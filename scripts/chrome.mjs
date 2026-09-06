/**
 * Where the headless browser lives.
 *
 * The sandbox this was written in ships a Chromium at a fixed path and blocks
 * downloads; a CI runner installs its own through Playwright and has no such
 * path. Preferring the pinned binary when it exists, and letting Playwright
 * resolve its own otherwise, is what makes the same check script run in both
 * without a flag.
 */
import { existsSync } from 'node:fs';

const PINNED = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export function launchOptions(extraArgs = []) {
  const options = {
    headless: true,
    args: [
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox',
      ...extraArgs,
    ],
  };
  if (existsSync(PINNED)) options.executablePath = PINNED;
  return options;
}

/** Arguments that stand a fake camera in for a real one. */
export const FAKE_CAMERA = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];
