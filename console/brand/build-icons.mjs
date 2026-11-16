// Builds the Argus logo files in console/public from the shapes below:
//   argus-logo.svg            eye + ΛRGUS wordmark, off-white on transparent (for docs, chat avatars)
//   favicon.svg               the eye on a dark rounded square (browser tab)
//   icon-32.png               the same, 32 px (older browsers, /favicon.ico)
//   apple-touch-icon.png      180 px, full square (iOS rounds the corners itself)
//   icon-192.png, icon-512.png       rounded square (Android, desktop installs)
//   icon-maskable-512.png     full bleed with the eye inside the safe circle (Android adaptive icons)
// Run after changing a shape:  /opt/node24/bin/node console/brand/build-icons.mjs
// (Playwright's Chromium renders the PNGs.)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const INK = '#f3efe8';     // warm off-white, as in the original artwork
const BG = '#0b1114';      // near-black, close to the console's dark theme

// The eye, traced from the original artwork. Bounding box about x 430–828, y 430–683.
export const EYE = `
  <path d="M519,506 C560,410 692,393 828,510 C732,463 600,418 519,506 Z"/>
  <path d="M430,586 C480,550 545,500 620,489 C700,496 762,526 818,533 L612,683 L757,541 C720,526 680,511 640,509 L603,509 C562,516 510,540 473,566 C515,566 560,590 604,635 C578,616 532,590 487,581 C462,577 442,580 430,586 Z"/>
  <path fill-rule="evenodd" d="M555.5,529 A67,67 0 1 0 688.5,529 Z M564,529 A58,58 0 1 0 680,529 Z"/>
  <circle cx="622" cy="526" r="23"/>`;
const EYE_BOX = { x: 430, y: 428, w: 398, h: 255 };

// ΛRGUS, drawn as strokes on a 40-unit cap height.
export const WORDMARK = `
  <path d="M0,40 L17,0 L34,40"/>
  <path d="M58,40 V1.8 H72 A10.6,10.6 0 0 1 72,23 H58 M71,23 L84,40"/>
  <path d="M139,8.5 A18.5,20 0 1 0 142,23 H128"/>
  <path d="M166,0 V25 A14.5,14.5 0 0 0 195,25 V0"/>
  <path d="M240,7 C237,2.5 232.5,1.8 229,1.8 C222,1.8 218.5,5.5 218.5,10.5 C218.5,17 224,18.5 229.5,20 C235.5,21.6 241.5,23.5 241.5,30 C241.5,35.5 237,38.2 230,38.2 C224.5,38.2 219.5,36.5 217,32"/>`;

// The eye scaled to `width` and centred on (cx, cy).
const eyeAt = (cx, cy, width) => {
  const s = width / EYE_BOX.w;
  return `<g fill="${INK}" transform="translate(${cx} ${cy}) scale(${s.toFixed(4)}) translate(${-(EYE_BOX.x + EYE_BOX.w / 2)} ${-(EYE_BOX.y + EYE_BOX.h / 2)})">${EYE}</g>`;
};
const glow = (size) => `<defs><radialGradient id="g" cx="50%" cy="47%" r="55%"><stop offset="0" stop-color="#fff" stop-opacity=".13"/><stop offset=".6" stop-color="#fff" stop-opacity=".03"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`;

function icon(size, { rounded, eyeShare }) {
  const r = rounded ? size * 0.225 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${glow(size)}
  <rect width="${size}" height="${size}" rx="${r}" fill="${BG}"/><rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
  ${eyeAt(size / 2, size * 0.51, size * eyeShare)}</svg>`;
}

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 300" role="img" aria-label="Argus">
  ${eyeAt(260, 112, 300)}
  <g fill="none" stroke="${INK}" stroke-width="3.6" transform="translate(139 232)">${WORDMARK}</g></svg>`;

writeFileSync(join(OUT, 'argus-logo.svg'), logo + '\n');
writeFileSync(join(OUT, 'favicon.svg'), icon(64, { rounded: true, eyeShare: 0.82 }) + '\n');

const PNGS = [
  ['icon-32.png', 32, { rounded: true, eyeShare: 0.86 }],
  ['apple-touch-icon.png', 180, { rounded: false, eyeShare: 0.7 }],
  ['icon-192.png', 192, { rounded: true, eyeShare: 0.72 }],
  ['icon-512.png', 512, { rounded: true, eyeShare: 0.72 }],
  ['icon-maskable-512.png', 512, { rounded: false, eyeShare: 0.58 }],
];
const { chromium } = createRequire(join(OUT, '..', '..', 'package.json'))('playwright');
const browser = await chromium.launch();
for (const [name, size, opts] of PNGS) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${icon(size, opts)}`);
  await page.screenshot({ path: join(OUT, name), omitBackground: true });
  await page.close();
}
await browser.close();
console.log(`wrote argus-logo.svg, favicon.svg, ${PNGS.map(([n]) => n).join(', ')} to ${OUT}`);
