// Builds the Argus logo files in console/public from the shapes below:
//   argus-logo.svg            eye + ΛRGUS wordmark as in the original, off-white on transparent
//   favicon.svg               the eye on a dark rounded square (browser tab)
//   icon-32.png               the same, 32 px (older browsers, /favicon.ico)
//   apple-touch-icon.png      180 px, full square (iOS rounds the corners itself)
//   icon-192.png, icon-512.png       rounded square (Android, desktop installs)
//   icon-maskable-512.png     full bleed with the eye inside the safe circle (Android adaptive icons)
// and puts the logo (eye + wordmark, in the text colour) into app.html, login.html and setup.html
// between their <!-- brand --> and <!-- /brand --> markers.
// Run after changing a shape:  /opt/node24/bin/node console/brand/build-icons.mjs
// (Playwright's Chromium renders the PNGs.)
import { readFileSync, writeFileSync } from 'node:fs';
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

// ΛRGUS, traced from the original artwork, in the same coordinates as the eye:
// cap height 723.3–796.7, stroke 9. Strokes are clipped to the cap height so their
// ends are cut level like the original's. ID names the clip path (unique per page).
export const wordmark = (id = 'argus-cap') => `
  <defs><clipPath id="${id}"><rect x="300" y="723.3" width="700" height="73.4"/></clipPath></defs>
  <path d="M336,796.7 L376,723.3 L415.7,796.7 L405.7,796.7 L376,741.7 L346,796.7 Z"/>
  <g fill="none" stroke="currentColor" stroke-width="9" clip-path="url(#${id})">
    <path d="M483.3,800 V727.8 H519 A16.35,16.35 0 0 1 519,760.5 H483.3 M505,760.5 L542,802"/>
    <path d="M667.6,738.8 A33.75,33.75 0 1 0 675.45,760.5 H645"/>
    <path d="M746.3,720 V767.7 A26,26 0 0 0 798.3,767.7 V720"/>
    <path d="M910.5,735 C904,729 896.5,727.5 889.5,727.5 C877.5,727.5 869.5,734 869.5,743.5 C869.5,754 880.5,757 891.5,760 C905,763.5 915,768 915,778 C915,788 904,793.7 890.5,793.7 C879,793.7 870,789.5 866,783"/>
  </g>`;

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

// Eye and wordmark exactly as laid out in the original artwork.
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="306 398 640 430" role="img" aria-label="Argus" color="${INK}" fill="${INK}">
  ${EYE}${wordmark()}</svg>`;

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
// The logo inside the pages: two inline SVGs in the text colour, sized by console.css.
const brand = `<svg class="mark" viewBox="426 424 406 263" fill="currentColor" aria-hidden="true">${EYE.replace(/\s*\n\s*/g, ' ')}</svg>`
  + `<svg class="word" viewBox="332 719 588 82" fill="currentColor" aria-hidden="true">${wordmark().replace(/\s*\n\s*/g, ' ')}</svg>`;
for (const page of ['app.html', 'login.html', 'setup.html']) {
  const f = join(OUT, page);
  const html = readFileSync(f, 'utf8');
  if (!/<!-- brand -->[\s\S]*?<!-- \/brand -->/.test(html)) throw new Error(`${page}: no <!-- brand --> markers`);
  writeFileSync(f, html.replace(/<!-- brand -->[\s\S]*?<!-- \/brand -->/, `<!-- brand -->${brand}<!-- /brand -->`));
}

console.log(`wrote argus-logo.svg, favicon.svg, ${PNGS.map(([n]) => n).join(', ')} and the page logos to ${OUT}`);
