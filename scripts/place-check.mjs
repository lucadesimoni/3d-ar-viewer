/**
 * Checks that a person can actually place a part, and that it snaps.
 *
 * The snap solver, the tolerance bands and the fit verification were reachable
 * only from tests: nothing in the interface moved a part, so the feature that
 * the whole app is named for could not be exercised by hand. This drags parts
 * with a real pointer and measures where they end up.
 *
 *   npm run build && npm run place:check
 */
import { chromium } from 'playwright';
import { launchOptions } from './chrome.mjs';

const URL_BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080/';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
await page.goto(`${URL_BASE}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.viewer-canvas');
await page.waitForTimeout(1500);

// --- 1. The step's "Place" action seats the parts through the snap solver. ---
const placed = await page.evaluate(async () => {
  const s = () => window.spatialStore.getState();
  s().setActiveStep(s().assembly.steps[0].id);
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.active-actions .secondary')?.click();
  await new Promise((r) => setTimeout(r, 300));
  const step = s().assembly.steps[0];
  const byId = new Map(s().assembly.parts.map((p) => [p.id, p]));
  return step.partIds.map((id) => {
    const pl = s().placements.get(id);
    const target = byId.get(id).targetPose.position;
    const d = Math.hypot(
      pl.pose.position[0] - target[0], pl.pose.position[1] - target[1], pl.pose.position[2] - target[2],
    );
    return { id, status: pl.status, mm: +(d * 1000).toFixed(2) };
  });
});
check('the step\'s Place action puts the parts in', placed.every((p) => p.status !== 'ghost'),
  placed.map((p) => `${p.id}=${p.status}`).join(', '));
check('and they end up seated, not 20 mm out where they were released',
  placed.every((p) => p.mm < 1), placed.map((p) => `${p.id} ${p.mm}mm`).join(', '));

// --- 2. Dragging a part with a pointer, and letting go, snaps it. -----------
const canvas = await page.locator('canvas.viewer-canvas').boundingBox();
const screenOf = (partId) => page.evaluate((id) => {
  const p = window.spatialScene().projectPart(id);
  return p ? { x: p.x, y: p.y, onScreen: p.onScreen } : null;
}, partId);

// Put the housing in reach: place its predecessor, then drag the housing itself.
await page.evaluate(async () => {
  const s = () => window.spatialStore.getState();
  s().setActiveStep('s2');
  await new Promise((r) => setTimeout(r, 200));
});
const housing = await screenOf('housing');
check('the part to drag is on screen', Boolean(housing?.onScreen));

const from = { x: canvas.x + housing.x * canvas.width, y: canvas.y + housing.y * canvas.height };
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(from.x + 7, from.y - 5, { steps: 8 });   // a few mm off the joint
await page.mouse.up();
await page.waitForTimeout(400);

const result = await page.evaluate(() => {
  const s = window.spatialStore.getState();
  const part = s.assembly.parts.find((p) => p.id === 'housing');
  const pl = s.placements.get('housing');
  const t = part.targetPose.position;
  return {
    status: pl.status,
    mm: +(Math.hypot(pl.pose.position[0] - t[0], pl.pose.position[1] - t[1], pl.pose.position[2] - t[2]) * 1000).toFixed(2),
    snapped: Boolean(s.lastSnap && s.lastSnap.partId === 'housing'),
    residualMm: s.lastSnap ? +s.lastSnap.residual.positionMm.toFixed(2) : null,
  };
});
check('a dragged part is placed on release', result.status !== 'ghost', `status=${result.status}`);
check('and the snap solver seats it on the joint', result.snapped && result.mm < 2,
  `${result.mm} mm from nominal, snap residual ${result.residualMm} mm`);

// --- 3. Dropped well outside capture range: no silent snap, a real error. ---
const far = await page.evaluate(async () => {
  const s = () => window.spatialStore.getState();
  const part = s().assembly.parts.find((p) => p.id === 'housing');
  const t = part.targetPose.position;
  s().placePart('housing', { position: [t[0] + 0.14, t[1], t[2]], rotation: part.targetPose.rotation });
  await new Promise((r) => setTimeout(r, 250));
  const pl = s().placements.get('housing');
  return {
    mm: +(Math.hypot(pl.pose.position[0] - t[0], pl.pose.position[1] - t[1], pl.pose.position[2] - t[2]) * 1000).toFixed(1),
    errors: s().diagnostics.filter((d) => d.severity === 'error' && d.partIds.includes('housing')).map((d) => d.code),
  };
});
check('a part dropped out of range is not silently teleported home', far.mm > 100, `${far.mm} mm out`);
check('and the operator is told why it is wrong', far.errors.length > 0, far.errors.join(', ') || 'no diagnostic');

await page.screenshot({ path: '/tmp/place-check.png' });
// --- Only the step in hand can be moved. -----------------------------------
// A tester: "what irritates me is that I can move the elements by drag and
// drop". Every part was draggable at any moment, in every view mode, with no
// cursor, no hover, no warning — including parts of steps that are not due. And
// two harder consequences: a move promoted a ghost to placed on every pointer
// event, before the operator had decided anything; and during a build animation
// the animated pose wins, so a drag moved nothing visibly, wrote to the store
// throughout, and committed the animated position on release.
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${URL_BASE}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(2000);

  /**
   * A screen point where this part is actually the frontmost thing.
   *
   * Projecting a part's centre is not enough: parts overlap, and the first
   * version of this check pressed the baseplate's centre and hit the housing
   * standing in front of it — then read the app's correct refusal as a bug.
   * Probe outwards from the centre until the pick agrees.
   */
  const canvasPoint = (id) => page.evaluate((partId) => {
    const scene = window.spatialScene();
    const p = scene.projectPart(partId);
    if (!p) return null;
    const r = document.querySelector('canvas.viewer-canvas').getBoundingClientRect();
    const cx = p.x * r.width;
    const cy = p.y * r.height;
    for (let radius = 0; radius <= 90; radius += 10) {
      for (let a = 0; a < 360; a += radius === 0 ? 360 : 30) {
        const x = cx + Math.cos((a * Math.PI) / 180) * radius;
        const y = cy + Math.sin((a * Math.PI) / 180) * radius;
        if (x < 0 || y < 0 || x > r.width || y > r.height) continue;
        if (scene.pickPartAt(x, y) === partId) return { x: r.left + x, y: r.top + y, exposed: true };
      }
    }
    return { x: r.left + cx, y: r.top + cy, exposed: false };
  }, id);
  const statusOf = (id) => page.evaluate(
    (partId) => window.spatialStore.getState().placements.get(partId)?.status, id,
  );
  /** The stored pose — in the assembly's own frame, which is where it lives. */
  const poseOf = (id) => page.evaluate(
    (partId) => window.spatialStore.getState().placements.get(partId)?.pose.position, id,
  );
  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  /** The stored pose with the finger still down — before the snap on release. */
  const poseMidDrag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await page.waitForTimeout(150);
    const pose = await poseOf(await page.evaluate(() => {
      const st = window.spatialStore.getState();
      return st.assembly.steps.find((s) => s.id === st.activeStepId).partIds[0];
    }));
    await page.mouse.up();
    await page.waitForTimeout(200);
    return pose;
  };

  // A part belonging to a step that is not the active one.
  const later = await page.evaluate(() => {
    const st = window.spatialStore.getState();
    const active = st.assembly.steps.find((s) => s.id === st.activeStepId);
    const other = st.assembly.steps.find((s) => s.id !== st.activeStepId && s.partIds.length);
    return { id: other.partIds[0], activeStep: active.id, step: other.id };
  });
  const at = await canvasPoint(later.id);
  if (at?.exposed) {
    const before = await statusOf(later.id);
    await drag(at, 60, 40);
    check('a part from a later step cannot be dragged',
      (await statusOf(later.id)) === before,
      `${later.id} (step ${later.step}) stayed ${await statusOf(later.id)}`);
  } else {
    check('a part from a later step is exposed to try', false, 'never frontmost');
  }

  // The active step's part still moves — the feature must survive the fix.
  const activePart = await page.evaluate(() => {
    const st = window.spatialStore.getState();
    return st.assembly.steps.find((s) => s.id === st.activeStepId).partIds[0];
  });
  const activeAt = await canvasPoint(activePart);
  // Which part is actually frontmost there: parts overlap, and the previous
  // gesture orbited the camera because a refused drag leaves the camera in
  // charge — projecting a centre does not guarantee picking that part.
  await drag(activeAt, 40, 30);
  // Not `=== 'placed'`: a placement with no error diagnostic is promoted again,
  // to `verified`, by `derive()`. The first version of this assertion demanded
  // 'placed' and reported the app's correct behaviour as a failure.
  const afterDrag = await statusOf(activePart);
  check('and the active step\'s part still can be',
    activeAt.exposed && afterDrag !== 'ghost',
    `${activePart} is ${afterDrag}${activeAt.exposed ? '' : ' (never exposed)'}`);

  // An abandoned drag must leave nothing behind. Moving used to promote
  // `ghost → placed` on every pointer event, so brushing a part changed the
  // build state before the operator had decided anything.
  await page.evaluate(() => window.spatialStore.getState().reset());
  await page.waitForTimeout(300);
  const abandonPart = await page.evaluate(() => {
    const st = window.spatialStore.getState();
    return st.assembly.steps.find((s) => s.id === st.activeStepId).partIds[0];
  });
  const abandonAt = await canvasPoint(abandonPart);
  await page.mouse.move(abandonAt.x, abandonAt.y);
  await page.mouse.down();
  await page.mouse.move(abandonAt.x + 50, abandonAt.y + 30, { steps: 10 });
  const midDrag = await statusOf(abandonPart);
  await page.mouse.up();
  await page.waitForTimeout(200);
  check('a drag in progress has not yet decided anything', midDrag === 'ghost',
    `${abandonPart} was ${midDrag} mid-drag`);

  // Nothing may be committed while a timeline is running.
  await page.evaluate(() => window.spatialStore.getState().reset());
  await page.waitForTimeout(300);
  const playing = await page.evaluate(() => {
    const st = window.spatialStore.getState();
    const id = st.assembly.steps.find((s) => s.id === st.activeStepId).partIds[0];
    // A timeline in the store is what `resolvePose` prefers over the placement.
    st.setAnimation({ durationS: 10, tracks: [], markers: [] }, 0);
    return id;
  });
  const animAt = await canvasPoint(playing);
  const beforeAnim = await statusOf(playing);
  if (animAt) await drag(animAt, 50, 30);
  check('and nothing is dragged while an animation is running',
    (await statusOf(playing)) === beforeAnim,
    `${playing} stayed ${await statusOf(playing)}`);
  await page.evaluate(() => window.spatialStore.getState().setAnimation(undefined, 0));

  // The exploded view is the same trap as a running timeline: what is drawn is
  // the base pose plus an explosion offset, so a drag that starts from the
  // drawn position and writes it back as the base one makes the part jump by
  // exactly that offset — and records a position nobody chose.
  await page.evaluate(() => window.spatialStore.getState().reset());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const st = window.spatialStore.getState();
    st.setViewMode('explode');
    st.setExplodeFactor(1.2);
  });
  await page.waitForTimeout(600);
  // A part that is actually reachable with the assembly blown apart. The first
  // step's plate is buried under the housing even exploded, and a drag that
  // lands on another part is refused for a reason that has nothing to do with
  // what this is testing — which is how the first version of this check passed
  // with its own fix taken out.
  let explodedPart;
  let explodedAt;
  for (const stepId of await page.evaluate(
    () => window.spatialStore.getState().assembly.steps.map((x) => x.id),
  )) {
    await page.evaluate((id) => window.spatialStore.getState().setActiveStep(id), stepId);
    await page.waitForTimeout(350);
    const candidate = await page.evaluate((id) => window.spatialStore.getState()
      .assembly.steps.find((s) => s.id === id).partIds[0], stepId);
    const at = await canvasPoint(candidate);
    if (at?.exposed) { explodedPart = candidate; explodedAt = at; break; }
  }
  check('a part of the active step is reachable in the exploded view',
    Boolean(explodedAt?.exposed), explodedPart ?? 'none exposed');
  const beforeExplode = explodedPart ? await poseOf(explodedPart) : undefined;
  // Read while the finger is still down. On release the snap solver seats the
  // part on its joint, which would hide any drag under a correct final pose.
  const duringExplode = explodedAt ? await poseMidDrag(explodedAt, 60, 40) : beforeExplode;
  check('nothing is dragged while the view is exploded',
    JSON.stringify(beforeExplode) === JSON.stringify(duringExplode),
    `${explodedPart}: ${JSON.stringify(beforeExplode)} → ${JSON.stringify(duringExplode)}, at ${JSON.stringify(explodedAt)}`);

  // And with the assembly anchored and turned — which is every AR session —
  // a drag has to move the part the way the finger went. A part's pose is
  // local to the assembly root and the picking ray is in world space, so
  // subtracting one from the other only ever worked at the origin, unturned.
  await page.evaluate(() => {
    const st = window.spatialStore.getState();
    st.setViewMode('guide');
    st.setExplodeFactor(0);
    // Half a turn about the vertical: now local +X points along world −X.
    st.setAnchor({ position: [0, 0, 0], rotation: [0, 1, 0, 0] }, 0.9, 'floor');
  });
  await page.waitForTimeout(500);
  const turnedPart = await page.evaluate(() => {
    const st = window.spatialStore.getState();
    return st.assembly.steps.find((s) => s.id === st.activeStepId).partIds[0];
  });
  const turnedAt = await canvasPoint(turnedPart);
  const beforeTurn = await poseOf(turnedPart);
  const duringTurn = turnedAt ? await poseMidDrag(turnedAt, 80, 0) : beforeTurn;
  const movedLocalX = duringTurn && beforeTurn ? duringTurn[0] - beforeTurn[0] : 0;
  check('a drag on a turned assembly moves the part the way the finger went',
    turnedAt !== undefined && movedLocalX < -0.005,
    `local x moved by ${movedLocalX.toFixed(3)} m, from ${JSON.stringify(turnedAt)} (dragging right, assembly turned 180°)`);
  await page.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall placement checks passed');
process.exit(failures.length ? 1 : 0);
