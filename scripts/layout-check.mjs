/**
 * The start screen, before any AR: is the model actually visible, and does the
 * chrome leave room for it?
 *
 * The fault this exists for: `frameCamera` measured the assembly *with its
 * bench and wall*, so a 0.26 m gearbox was framed as a 0.72 m object. On a
 * phone it came out 11% of the screen wide and 4% tall — a speck in the middle
 * of an empty grid, on the one screen whose whole job is to show the model.
 * Nothing failed; it just looked like an empty app.
 *
 * Usage: node scripts/layout-check.mjs   (with the app served on PREVIEW_URL)
 */
import { chromium } from 'playwright';
import { launchOptions, FAKE_CAMERA } from './chrome.mjs';

const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';
const OUT = process.argv[2] ?? '/tmp/layout-check';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(launchOptions());

/** Viewports that have to work, and what each one is the hard case for. */
const VIEWPORTS = [
  { name: 'phone portrait', w: 390, h: 844, dpr: 3, mobile: true, minViewShare: 0.38 },
  { name: 'phone landscape', w: 844, h: 390, dpr: 3, mobile: true, minViewShare: 0.55 },
  { name: 'tablet portrait', w: 820, h: 1180, dpr: 2, mobile: true, minViewShare: 0.5 },
  { name: 'desktop', w: 1440, h: 900, dpr: 1, mobile: false, minViewShare: 0.5 },
];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr,
    isMobile: vp.mobile, hasTouch: vp.mobile,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas', { timeout: 20000 });
  await page.waitForTimeout(2500);

  const m = await page.evaluate(() => {
    const scene = window.spatialScene();
    const canvas = document.querySelector('canvas.viewer-canvas').getBoundingClientRect();
    const pts = window.spatialStore.getState().assembly.parts
      .map((p) => scene.projectPart(p.id)).filter(Boolean);
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    return {
      view: [Math.round(canvas.width), Math.round(canvas.height)],
      viewShare: canvas.height / window.innerHeight,
      spanX: Math.max(...xs) - Math.min(...xs),
      spanY: Math.max(...ys) - Math.min(...ys),
      centreX: (Math.max(...xs) + Math.min(...xs)) / 2,
      centreY: (Math.max(...ys) + Math.min(...ys)) / 2,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      width: window.innerWidth, height: window.innerHeight,
    };
  });

  const tag = vp.name;
  // The assembly has to fill a real share of the frame along its longer axis.
  check(`${tag}: the assembly fills the view`, Math.max(m.spanX, m.spanY) > 0.35,
    `${(m.spanX * 100).toFixed(0)}% wide, ${(m.spanY * 100).toFixed(0)}% tall`);
  check(`${tag}: and is centred in it`,
    Math.abs(m.centreX - 0.5) < 0.12 && Math.abs(m.centreY - 0.5) < 0.15,
    `centre at ${m.centreX.toFixed(2)}, ${m.centreY.toFixed(2)}`);
  check(`${tag}: the 3D view gets its share of the screen`, m.viewShare >= vp.minViewShare,
    `${(m.viewShare * 100).toFixed(0)}% of the height (min ${(vp.minViewShare * 100).toFixed(0)}%)`);
  // A start screen that scrolls has already lost: the controls move under the
  // thumb and the model goes off the top.
  check(`${tag}: the page does not scroll`,
    m.scrollW <= m.width + 1 && m.scrollH <= m.height + 1,
    `${m.scrollW}x${m.scrollH} in ${m.width}x${m.height}`);

  // Every control has to be reachable without scrolling, and thumb-sized.
  const small = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('button, select')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(b).visibility === 'hidden') continue;
      if (r.height < 32) out.push(`${(b.textContent || b.tagName).trim().slice(0, 18)} ${Math.round(r.height)}px`);
      if (r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || r.left < -1) {
        out.push(`${(b.textContent || b.tagName).trim().slice(0, 18)} off-screen`);
      }
    }
    return out;
  });
  if (vp.mobile) {
    check(`${tag}: every control is on screen and thumb-sized`, small.length === 0, small.join(', '));
  }

  await page.screenshot({ path: `${OUT}/${vp.name.replace(/ /g, '-')}.png` });
  await context.close();
}

// --- The HUD when the host disagrees about the viewport. -------------------
// Reported from an iPad running the app through the Needle App Clip: AR works,
// but the bottom bar and the step strip are sometimes not there.
//
// The app is a column as tall as the viewport with the HUD as its last row, and
// that row has to stay in the flow: iOS Safari anchors a `position: fixed`
// element to the *layout* viewport — the tall one without the toolbars — so a
// bar pinned to the bottom hides behind them, which is a check of its own in
// ar-verify. The column's height therefore has to be right, and `100dvh` is a
// guess. `--app-h` is measured from `visualViewport` instead.
{
  const cam = await chromium.launch(launchOptions(FAKE_CAMERA));
  for (const vp of [
    { name: 'tablet portrait', w: 820, h: 1180 },
    { name: 'tablet landscape', w: 1180, h: 820 },
    { name: 'phone portrait', w: 390, h: 844 },
  ]) {
    const context = await cam.newContext({
      viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.click('.ar-enter');
    await page.waitForSelector('.ar-bar', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('.app').classList.add('xr-session'));

    // Twice: as opened, and after the visible area changes under the app — a
    // toolbar sliding in, a clip resizing its presentation, the device turning.
    for (const [when, size] of [['as opened', null], ['after the host resizes', { width: vp.w, height: vp.h - 220 }]]) {
      if (size) { await page.setViewportSize(size); await page.waitForTimeout(300); }
      const seen = await page.evaluate(() => {
        const box = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { bottom: Math.round(r.bottom), top: Math.round(r.top), h: Math.round(r.height) };
        };
        return {
          app: box('.app'), bar: box('.ar-bar'), now: box('.ar-now'),
          measured: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
          h: window.innerHeight,
        };
      });
      const on = (b) => b && b.h > 0 && b.bottom <= seen.h + 1 && b.top >= -1;
      check(`${vp.name}: the app measures the visible height rather than assuming it (${when})`,
        seen.measured === `${seen.h}px`, `--app-h ${seen.measured || 'unset'} for ${seen.h}px`);
      check(`${vp.name}: its box is no taller than what can be seen (${when})`,
        seen.app && seen.app.h <= seen.h + 1, `${seen.app?.h} of ${seen.h}`);
      check(`${vp.name}: the control bar is on screen (${when})`,
        on(seen.bar), seen.bar ? `bottom ${seen.bar.bottom} of ${seen.h}` : 'not rendered');
      check(`${vp.name}: and so is the step strip (${when})`,
        on(seen.now), seen.now ? `bottom ${seen.now.bottom} of ${seen.h}` : 'not rendered');
    }
    await context.close();
  }
  await cam.close();
}

// --- Motion, for an operator who asked for less of it. ---------------------
// One pulsing dot was covered by a reduced-motion rule and the other was not.
// That is how these rules usually go: written for the animation in front of
// you, and the next one lands somewhere else. None of the motion here carries
// meaning the still state does not, so under the preference it all stops.
{
  const quiet = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    reducedMotion: 'reduce',
  });
  const page = await quiet.newPage();
  await page.goto(`${URL}?assembly=kallax-4x4`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const moving = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const st = getComputedStyle(el);
      const duration = (v) => v.split(',').some((d) => parseFloat(d) > 0.01);
      if (st.animationName !== 'none' && duration(st.animationDuration)) {
        out.push(`${el.className || el.tagName} animates ${st.animationName}`);
      }
      if (duration(st.transitionDuration)) out.push(`${el.className || el.tagName} transitions`);
    }
    return out.slice(0, 6);
  });
  check('nothing animates when the operator has asked for reduced motion',
    moving.length === 0, moving.join(', ') || 'nothing moves');
  await quiet.close();
}

// --- Getting the panel out of the way. -------------------------------------
// A tester asked to be able to focus the 3D view. It was already possible —
// tapping the active tab collapses the sheet — and nothing on screen said so.
// An affordance, not a feature: the handle does what the tab already did.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(2000);

  const share = () => page.evaluate(() => {
    const c = document.querySelector('canvas.viewer-canvas').getBoundingClientRect();
    return c.height / window.innerHeight;
  });
  const before = await share();
  const handle = page.locator('.sheet-handle');
  check('the panel says it can be got out of the way', await handle.count() === 1);
  const box = await handle.boundingBox().catch(() => null);
  check('and the handle is a thumb target', Boolean(box) && box.height >= 44,
    box ? `${Math.round(box.height)} px tall` : 'no handle');

  await handle.click();
  await page.waitForTimeout(500);
  const after = await share();
  check('and using it gives the 3D view the room',
    after > before + 0.1, `${Math.round(before * 100)}% → ${Math.round(after * 100)}% of the height`);
  check('and the handle goes with the panel it collapsed',
    await page.locator('.sheet-handle').count() === 0);

  // The canvas growing this much is exactly what used to break the studio
  // camera. `frameCamera` sets a guard flag and clears it before returning,
  // but Babylon does not recompute a dirty view matrix — and so does not fire
  // its changed-observable — until the *next* render frame, well after the
  // flag was already cleared. That deferred, unrelated notification read as
  // "the operator touched the camera" and disabled every future auto-refit,
  // including the very first one this collapse needs. The tell is the same
  // one an operator would see: the shelf spilling off both edges of a canvas
  // it used to fit inside.
  const fit = await page.evaluate(() => {
    const scene = window.spatialScene();
    const canvas = document.querySelector('canvas.viewer-canvas').getBoundingClientRect();
    const pts = window.spatialStore.getState().assembly.parts
      .map((p) => scene.projectPart(p.id)).filter(Boolean);
    const xs = pts.map((q) => q.x);
    return { spanX: Math.max(...xs) - Math.min(...xs), width: canvas.width };
  });
  check('and the 3D view re-frames to fill it rather than overflowing',
    fit.spanX <= 1, `assembly spans ${(fit.spanX * 100).toFixed(0)}% of the ${Math.round(fit.width)}px-wide canvas`);
  await context.close();
}

// --- The assembly picker's options. ----------------------------------------
// Reported as "dropdown colours - flaw", and it was: the options inherited
// `--text` (#e6edf5, near white) while the operating system draws the popup on
// a light background of its own, so every unselected entry was near-white on
// white. Only the highlighted row could be read. The popup is drawn by the OS
// and cannot be screenshotted, but the colours the browser hands it can be read.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.assembly-picker');

  const colours = await page.evaluate(() => {
    const option = document.querySelector('.assembly-picker option');
    const select = document.querySelector('.assembly-picker');
    const st = getComputedStyle(option);
    return {
      colour: st.color,
      background: st.backgroundColor,
      scheme: getComputedStyle(select).colorScheme,
    };
  });
  const luminance = (css) => {
    const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const transparent = /rgba\(0, 0, 0, 0\)|transparent/.test(colours.background);
  check('the picker\'s options set their own background, not the popup\'s',
    !transparent, colours.background);
  check('and they are legible against it',
    !transparent && contrast(colours.colour, colours.background) >= 4.5,
    transparent ? 'no background to measure against'
      : `${contrast(colours.colour, colours.background).toFixed(1)}:1 (${colours.colour} on ${colours.background})`);
  check('and the control asks the OS for a dark popup',
    colours.scheme.includes('dark'), colours.scheme);
  await context.close();
}

// --- The mode bar, where a phone actually gives it room. --------------------
// A landscape phone puts the panel in a side column as narrow as 240px (see
// the landscape grid above), and four labelled view-mode buttons plus a reset
// button do not fit on one row there. `.mode-switch` did not wrap, so the
// overflow spilled past `.mode-bar`'s own box and past the page's right edge
// — past `.app`'s own `overflow: hidden`, which swallowed it with no
// scrollbar and no error. "Animate" was there in the DOM and nowhere a finger
// could reach it.
{
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(1500);
  await page.locator('.sheet-tabs button', { hasText: 'View' }).click();
  await page.waitForTimeout(400);

  const offscreen = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('.mode-bar button')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1 || r.left < -1) {
        out.push(`${(b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 20)} right=${Math.round(r.right)} of ${innerWidth}`);
      }
    }
    return out;
  });
  check('phone landscape, View open: every mode button is actually on the page',
    offscreen.length === 0, offscreen.join(', ') || 'all on screen');

  // The same narrow column, but the control this used to lose outright: a
  // build could not be reset on any phone under 640px at all (`display:
  // none`, nothing standing in for it). It is a `.mode` button now, so it
  // shrinks like its neighbours instead of disappearing — check that it is
  // still there and still has a name, icon-only or not.
  const reset = page.locator('.mode.reset');
  check('and Reset build is still one of them',
    await reset.count() === 1, `${await reset.count()} found`);
  if (await reset.count() === 1) {
    const box = await reset.boundingBox();
    const label = await reset.getAttribute('aria-label');
    check('reachable on screen and named for assistive tech even with its text hidden',
      Boolean(box) && box.width > 0 && box.height > 0 && label === 'Reset build',
      `box=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none'}, aria-label=${label}`);
  }
  await context.close();
}

// --- The card a short phone's own panel height could not fit. --------------
// An iPhone SE-class screen (667px, a real and still-common height) gives the
// step panel 38% of that — and a caution line, tools, and three action
// buttons together ran past it. `.step-guide` clips rather than scrolls, so
// "Sign off" was there in the DOM and nowhere on screen, with no way to
// scroll to it either — the panel itself does not scroll, only its own
// children may.
{
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(1500);
  // The 46-step equipment rack is the deep case: long instructions, a caution
  // on some steps, tools on others — the one of the three samples most likely
  // to overflow a short panel.
  await page.selectOption('select.assembly-picker', { label: 'Modular Equipment Rack (14-bay)' }).catch(() => {});
  await page.waitForTimeout(1000);

  const reach = await page.evaluate(() => {
    const card = document.querySelector('.active-card');
    const btn = document.querySelector('.active-actions button.primary, .active-actions button:last-child');
    if (!card || !btn) return { missing: true };
    // Whether the *whole* button paints where it claims to be, not whether its
    // own (possibly clipped-by-an-ancestor) box says it should, and not just
    // its centre — a button clipped just below its centre point still passes
    // a centre-only hit test while its lower half, and the finger that lands
    // there, hits nothing. `getBoundingClientRect` reports the button's true,
    // unclipped position regardless of an ancestor's `overflow: hidden`, so
    // every corner (inset a little, off the rounded edge) is checked instead.
    // Scrolling the card to its end is harmless when nothing needs scrolling,
    // so this runs unconditionally.
    card.scrollTop = card.scrollHeight;
    const r = btn.getBoundingClientRect();
    // Edge midpoints, not corners: a rounded button's actual hit shape follows
    // its border-radius, so a point a few pixels in from the geometric corner
    // of its bounding box can legitimately land on the card behind it even on
    // a fully visible button. The midpoint of each edge has no such curve to
    // dodge and still proves all four sides are painted where claimed.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const edge = 2;
    const points = [
      [cx, r.top + edge], [cx, r.bottom - edge],
      [r.left + edge, cy], [r.right - edge, cy],
    ];
    const results = points.map(([x, y]) => {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return hit === btn || btn.contains(hit);
    });
    return { allEdgesReachable: results.every(Boolean), edges: results };
  });
  check('phone portrait, short viewport: the step\'s primary action is reachable, edge to edge',
    Boolean(reach.allEdgesReachable), JSON.stringify(reach));
  await context.close();
}

// --- The step strip's far end, past what one screen at a time can show. ----
// A 46-step assembly (the equipment rack) only shows the first handful of
// step circles at once; the rest are a swipe away with nothing on screen
// saying so before this scroll-affordance. Both directions of the claim are
// checked — the badge showing while there is more, and going away once the
// strip is genuinely scrolled to its end — because a badge that never turns
// off would be as wrong as one that never turns on.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(1500);
  await page.selectOption('select.assembly-picker', { label: 'Modular Equipment Rack (14-bay)' }).catch(() => {});
  await page.waitForTimeout(1000);

  check('phone portrait, 46-step assembly: the step strip says there is more',
    await page.locator('.step-list-wrap .scroll-more.right').count() === 1);

  await page.evaluate(() => {
    const ol = document.querySelector('.step-list');
    ol.scrollLeft = ol.scrollWidth;
    ol.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);

  const reach = await page.evaluate(() => {
    const rows = document.querySelectorAll('.step-row');
    const row = rows[rows.length - 1];
    if (!row) return { missing: true };
    // Same edge-midpoint hit test as the active-card check below: corners of
    // a rounded target can miss even a fully visible one, and this is a
    // circular bullet — the one shape where the edge midpoints sit exactly
    // on the boundary rather than inside it.
    const r = row.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, edge = 2;
    const points = [[cx, r.top + edge], [cx, r.bottom - edge], [r.left + edge, cy], [r.right - edge, cy]];
    const results = points.map(([x, y]) => {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return hit === row || row.contains(hit);
    });
    return { allEdgesReachable: results.every(Boolean), edges: results };
  });
  check('and step 46 is reachable once actually scrolled there, edge to edge',
    Boolean(reach.allEdgesReachable), JSON.stringify(reach));
  check('and the badge is gone once there is nothing more to scroll to',
    await page.locator('.step-list-wrap .scroll-more.right').count() === 0);

  // The selected bullet's ring sits outside its own box — 2px width, 2px
  // offset — and `.step-list` clips vertically (`overflow-y: hidden`) to stop
  // an accidental scrollbar, not to trim that ring. Without enough padding on
  // the list the ring reads as a flat-topped smear rather than a circle: a
  // reported flaw, and a real one — this checks the ring's own box, not a
  // screenshot, so it catches the clip whether it is 1px or 10px.
  await page.locator('.step-row').nth(3).click();
  await page.waitForTimeout(200);
  const ring = await page.evaluate(() => {
    const row = document.querySelector('.step-row.selected');
    const bullet = row?.querySelector('.bullet');
    const list = document.querySelector('.step-list');
    if (!bullet || !list) return { missing: true };
    const b = bullet.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const cs = getComputedStyle(bullet);
    const grow = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    return { ringTop: b.top - grow, ringBottom: b.bottom + grow, listTop: l.top, listBottom: l.bottom };
  });
  check('the selected step\'s ring is not clipped top or bottom by the scroll strip',
    !ring.missing && ring.ringTop >= ring.listTop - 0.5 && ring.ringBottom <= ring.listBottom + 0.5,
    JSON.stringify(ring));

  await context.close();
}

// --- The More sheet, wherever its content runs past 46dvh. -----------------
// The same gap, a different container: the register list is capped to
// `46dvh` and scrolls, but nothing on screen said there was more once its
// content — hint text, datum buttons, the result block — overflowed it.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(1500);
  await page.selectOption('select.assembly-picker', { label: 'Modular Equipment Rack (14-bay)' }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator('.sheet-tabs button', { hasText: 'More' }).click();
  await page.waitForTimeout(300);

  check('phone portrait, More sheet, Register tab: the sheet says there is more',
    await page.locator('.mobile-sheet .scroll-more.down').count() === 1);

  await page.evaluate(() => {
    const sheet = document.querySelector('.mobile-sheet');
    sheet.scrollTop = sheet.scrollHeight;
    sheet.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);

  const reach = await page.evaluate(() => {
    const items = document.querySelectorAll('.datum-list li button');
    const btn = items[items.length - 1];
    if (!btn) return { missing: true };
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, edge = 2;
    const points = [[cx, r.top + edge], [cx, r.bottom - edge], [r.left + edge, cy], [r.right - edge, cy]];
    const results = points.map(([x, y]) => {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return hit === btn || btn.contains(hit);
    });
    return { allEdgesReachable: results.every(Boolean), edges: results };
  });
  check('and the last datum is reachable once actually scrolled there, edge to edge',
    Boolean(reach.allEdgesReachable), JSON.stringify(reach));
  check('and the badge is gone once there is nothing more to scroll to',
    await page.locator('.mobile-sheet .scroll-more.down').count() === 0);

  await context.close();
}

// --- Telling two adjacent counts apart by something other than colour. -----
// "0" red beside "0" orange, and nothing else distinguishing them — silent to
// a screen reader, and to anyone who cannot rely on that particular red and
// that particular orange reading as different colours.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(1500);
  const labels = await page.evaluate(() => [...document.querySelectorAll('.counts .count')]
    .map((el) => el.getAttribute('aria-label')));
  check('the error and warning counts each carry their own name',
    labels.length === 2 && labels.every((l) => l && /error|warning/.test(l)),
    labels.join(' | ') || 'none found');
  await context.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall layout checks passed');
process.exit(failures.length ? 1 : 0);
