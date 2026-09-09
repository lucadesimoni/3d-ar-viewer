/**
 * The diagnostics file: one button instead of a round of screenshots.
 *
 * This exists because of how the last fortnight went. Every fault on a real
 * device — a black passthrough, a session that would not start, a tap that did
 * not place — was chased through screenshots and guesses, and several rounds
 * went on my wrong ones. So the file has to actually contain what those rounds
 * needed, and that is what this checks: the device, what the app was doing, the
 * sequence of events, and the errors a phone otherwise swallows.
 *
 * Usage: node scripts/log-check.mjs   (with the app served on PREVIEW_URL)
 */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { launchOptions, FAKE_CAMERA } from './chrome.mjs';

const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(launchOptions(FAKE_CAMERA));
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  acceptDownloads: true,
});
const page = await context.newPage();
await page.goto(`${URL}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.viewer-canvas');
await page.waitForTimeout(1500);

// A failure of the kind that is invisible on a phone.
await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', {
  message: 'boom inside a render loop', filename: 'bundle.js', lineno: 42, colno: 7,
})));

// Into camera AR, so there is a session to describe and a frame to attach.
await page.click('.ar-enter');
await page.waitForSelector('.ar-bar', { timeout: 20000 });
// Held looking down at the floor, then a tap: a real placement, so the log has
// a real placement in it. The point of the check is that it does.
await page.evaluate(() => {
  setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
    alpha: 90, beta: 60, gamma: 0, absolute: true,
  })), 40);
});
await page.waitForTimeout(2000);
await page.mouse.click(195, 500);
await page.waitForTimeout(1500);

const save = async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.locator('.ar-log-row button', { hasText: 'Save diagnostics log' }).click(),
  ]);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
};

await page.locator('.ar-btn', { hasText: 'Settings' }).click();
await page.waitForTimeout(500);
await page.locator('.ar-details summary').click();
await page.waitForTimeout(300);

const report = await save();
check('the log saves as a file the operator can send',
  report?.version === 1, `version ${report?.version}`);
// A log without a build identity is a log you cannot act on: one arrived from a
// device forty-seven minutes after a merge, missing the field that merge had
// added, and "the device refused it" was indistinguishable from "this is an
// older bundle". That ambiguity cost a round trip.
// A real short hash and a real timestamp. The fallbacks this can degrade to —
// 'unknown' with no git, 'dev'/'unbuilt' when the Vite define is missing — must
// not pass, or the check attests to an identity the file does not carry. The
// first version of this assertion accepted 'dev' and so proved nothing.
check('it says which build produced it',
  /^[0-9a-f]{7,}\+?$/.test(report.build?.commit ?? '')
    && !Number.isNaN(Date.parse(report.build?.at ?? '')),
  `${report.build?.commit} built ${report.build?.at}`);
check('and the build is on screen too, without exporting anything',
  (await page.locator('.ar-build').textContent()).includes(report.build.commit),
  await page.locator('.ar-build').textContent());
check('it says whether the field of view was measured or assumed',
  ['xr-camera', 'operator', 'assumed'].includes(report.render?.fovSource),
  `${report.render?.fovDeg}° (${report.render?.fovSource})`);
check('it reports what was rendered into, measured inside a frame',
  Array.isArray(report.render?.bufferSize) && report.render.bufferSize[0] > 0,
  `${report.render?.bufferSize?.join('x')}`);
check('and no capability field claims a device cannot do what a session granted',
  !('hitTest' in (report.capabilities ?? {})) && 'hitTestGranted' in (report.capabilities ?? {}),
  Object.keys(report.capabilities ?? {}).filter((k) => /hitTest|anchors/i.test(k)).join(', '));

check('it says what the device and browser are',
  Boolean(report.device?.userAgent) && typeof report.page?.secureContext === 'boolean',
  `${report.device?.userAgent?.slice(0, 40)}…, secure=${report.page?.secureContext}`);
check('and what AR was actually doing',
  report.ar?.source === 'camera' && typeof report.ar?.placement === 'string',
  `source=${report.ar?.source}, placement=${report.ar?.placement}`);
check('and which renderer, at what rate',
  Boolean(report.render?.backend) && typeof report.render?.fps === 'number',
  `${report.render?.backend}, ${Math.round(report.render?.fps ?? -1)} fps, clock=${report.render?.clock}`);
check('it carries the sequence of events, not just a snapshot',
  Array.isArray(report.log) && report.log.some((e) => e.message.includes('camera passthrough')),
  `${report.log?.length} entries`);
// A report of "it drifted" that says nothing about the placement it drifted
// from is a report about nothing. The first real device log had that shape:
// placed and anchored, and not one line about either.
check('including the placement it was anchored by',
  report.log.some((e) => e.kind === 'place' && e.message.includes('anchor set')),
  report.log.filter((e) => e.kind === 'place').map((e) => e.message).join('; ') || 'none');
check('including the errors a phone otherwise swallows',
  report.log.some((e) => e.kind === 'error' && e.message.includes('boom')),
  report.log.filter((e) => e.kind === 'error').map((e) => e.message).join('; ') || 'none');
check('and it holds no images unless one was attached',
  Array.isArray(report.captures) && report.captures.length === 0,
  `${report.captures?.length} captures`);

// The frame: a picture of the real thing, with what the app expected in it.
await page.locator('.ar-log-row button', { hasText: 'Attach a camera frame' }).click();
await page.waitForTimeout(600);
const withFrame = await save();
const capture = withFrame.captures?.[0];
check('a camera frame can be attached', Boolean(capture?.image?.startsWith('data:image/jpeg')),
  capture ? `${Math.round(capture.image.length / 1024)} kB` : 'none attached');
check('and it carries the pose it was taken from',
  Array.isArray(capture?.camera?.position) && typeof capture?.camera?.fovDeg === 'number',
  capture ? `fov ${capture.camera.fovDeg}°` : 'no pose');
// Numbers, always — an unplaced assembly projects to NaN, which JSON writes
// as `null`, and a file that promises numbers and delivers nulls wastes the
// time of whoever reads it, which is the only reason this file exists.
check('and where the app expected every part to be, as numbers',
  Array.isArray(capture?.parts) && capture.parts.length > 0
    && capture.parts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)
      && typeof p.name === 'string'),
  capture ? `${capture.parts.length} parts, ${capture.parts.filter((p) => p.onScreen).length} on screen; first ${JSON.stringify(capture.parts[0])}` : 'none');

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall log checks passed');
process.exit(failures.length ? 1 : 0);
