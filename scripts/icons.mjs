/**
 * The home-screen icons, rendered from `public/icon.svg`.
 *
 *   node scripts/icons.mjs
 *
 * iOS ignores an SVG icon: an iPhone "Add to Home Screen" showed a screenshot
 * instead. And Android wants a maskable icon with its art inside the safe zone,
 * or the launcher crops it. So the SVG is rendered to PNGs:
 *  - icon-192.png, icon-512.png:  the icon as drawn, for the manifest;
 *  - icon-maskable-512.png:       full-bleed background, art in the middle 80%;
 *  - apple-touch-icon.png (180):  opaque and square; iOS rounds the corners.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchOptions } from './chrome.mjs';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const svg = readFileSync(join(PUBLIC, 'icon.svg'), 'utf8');
const BG = '#0b0f14';
const art = (inner) => svg.replace(/<rect[^>]*\/>/, inner);
const variants = [
  { file: 'icon-192.png', size: 192, svg },
  { file: 'icon-512.png', size: 512, svg },
  // Square background, art scaled into the 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, svg: art(`<rect width="512" height="512" fill="${BG}"/><g transform="translate(51.2 51.2) scale(0.8)">`).replace('</svg>', '</g></svg>') },
  { file: 'apple-touch-icon.png', size: 180, svg: art(`<rect width="512" height="512" fill="${BG}"/>`) },
];

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
for (const v of variants) {
  await page.setViewportSize({ width: v.size, height: v.size });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${v.svg.replace('<svg ', `<svg width="${v.size}" height="${v.size}" `)}</body>`);
  writeFileSync(join(PUBLIC, v.file), await page.screenshot({ omitBackground: !v.file.startsWith('apple') && !v.file.includes('maskable') }));
  console.log(v.file, v.size);
}
await browser.close();
