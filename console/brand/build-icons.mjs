// Builds the Aegis logo files in console/public from the shapes below:
//   aegis-logo.svg            shield + ΛEGIS wordmark, off-white on transparent
//   favicon.svg               the shield on a dark rounded square (browser tab)
//   icon-32.png               the same, 32 px (older browsers, /favicon.ico)
//   apple-touch-icon.png      180 px, full square (iOS rounds the corners itself)
//   icon-192.png, icon-512.png       rounded square (Android, desktop installs)
//   icon-maskable-512.png     full bleed with the shield inside the safe circle (Android adaptive icons)
// and puts the logo (shield + wordmark, in the text colour) into app.html, login.html and setup.html
// between their <!-- brand --> and <!-- /brand --> markers.
// Run after changing a shape:  /opt/node24/bin/node console/brand/build-icons.mjs
// (Playwright's Chromium renders the PNGs.) The earlier Argus brand is kept in brand/argus/.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const INK = '#f3efe8';     // warm off-white, as in the Argus artwork
const BG = '#0b1114';      // near-black, close to the console's dark theme

// The shield with a heartbeat running through it: Aegis watches, on a fixed script.
// Drawn on a 200 × 200 grid; the outer edge spans about x 22–178, y 12–190.
export const MARK = `
  <path d="M100,18 C126,30 152,36 172,36 C172,112 150,156 100,184 C50,156 28,112 28,36 C48,36 74,30 100,18 Z" fill="none" stroke="currentColor" stroke-width="12" stroke-linejoin="round"/>
  <path d="M33,106 H70 L84,76 L102,138 L118,88 L128,106 H167" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`;
const MARK_BOX = { x: 22, y: 12, w: 156, h: 178 };

// ΛEGIS in the Argus lettering (traced from the original artwork; E and I drawn to match):
// cap height 723.3–796.7, stroke 9. Strokes are clipped to the cap height so their ends are
// cut level. ID names the clip path (unique per page).
export const wordmark = (id = 'aegis-cap') => `
  <defs><clipPath id="${id}"><rect x="300" y="723.3" width="700" height="73.4"/></clipPath></defs>
  <path d="M336,796.7 L376,723.3 L415.7,796.7 L405.7,796.7 L376,741.7 L346,796.7 Z"/>
  <g fill="none" stroke="currentColor" stroke-width="9" clip-path="url(#${id})">
    <path d="M528,727.8 H483.3 V792.2 H528 M483.3,760 H521"/>
    <path transform="translate(-11 0)" d="M667.6,738.8 A33.75,33.75 0 1 0 675.45,760.5 H645"/>
    <path d="M735.5,720 V800"/>
    <path transform="translate(-61 0)" d="M910.5,735 C904,729 896.5,727.5 889.5,727.5 C877.5,727.5 869.5,734 869.5,743.5 C869.5,754 880.5,757 891.5,760 C905,763.5 915,768 915,778 C915,788 904,793.7 890.5,793.7 C879,793.7 870,789.5 866,783"/>
  </g>`;

// The shield scaled to `height` and centred on (cx, cy).
const markAt = (cx, cy, height) => {
  const s = height / MARK_BOX.h;
  return `<g color="${INK}" fill="${INK}" transform="translate(${cx} ${cy}) scale(${s.toFixed(4)}) translate(${-(MARK_BOX.x + MARK_BOX.w / 2)} ${-(MARK_BOX.y + MARK_BOX.h / 2)})">${MARK}</g>`;
};
const glow = `<defs><radialGradient id="g" cx="50%" cy="47%" r="55%"><stop offset="0" stop-color="#fff" stop-opacity=".13"/><stop offset=".6" stop-color="#fff" stop-opacity=".03"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`;

function icon(size, { rounded, markShare }) {
  const r = rounded ? size * 0.225 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${glow}
  <rect width="${size}" height="${size}" rx="${r}" fill="${BG}"/><rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
  ${markAt(size / 2, size / 2, size * markShare)}</svg>`;
}

// Shield above the wordmark, centred on it (the wordmark spans x 336–857).
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="296 448 600 370" role="img" aria-label="Aegis" color="${INK}" fill="${INK}">
  ${markAt(596.5, 572, 218)}${wordmark()}</svg>`;

writeFileSync(join(OUT, 'aegis-logo.svg'), logo + '\n');
writeFileSync(join(OUT, 'favicon.svg'), icon(64, { rounded: true, markShare: 0.8 }) + '\n');

// The logo inside the pages: two inline SVGs in the text colour, sized by console.css.
const brand = `<svg class="mark" viewBox="16 8 168 188" fill="currentColor" aria-hidden="true">${MARK.replace(/\s*\n\s*/g, ' ')}</svg>`
  + `<svg class="word" viewBox="332 719 530 82" fill="currentColor" aria-hidden="true">${wordmark().replace(/\s*\n\s*/g, ' ')}</svg>`;
for (const page of ['app.html', 'login.html', 'setup.html']) {
  const f = join(OUT, page);
  const html = readFileSync(f, 'utf8');
  if (!/<!-- brand -->[\s\S]*?<!-- \/brand -->/.test(html)) throw new Error(`${page}: no <!-- brand --> markers`);
  writeFileSync(f, html.replace(/<!-- brand -->[\s\S]*?<!-- \/brand -->/, `<!-- brand -->${brand}<!-- /brand -->`));
}

const PNGS = [
  ['icon-32.png', 32, { rounded: true, markShare: 0.84 }],
  ['apple-touch-icon.png', 180, { rounded: false, markShare: 0.66 }],
  ['icon-192.png', 192, { rounded: true, markShare: 0.68 }],
  ['icon-512.png', 512, { rounded: true, markShare: 0.68 }],
  ['icon-maskable-512.png', 512, { rounded: false, markShare: 0.56 }],
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
console.log(`wrote aegis-logo.svg, favicon.svg, ${PNGS.map(([n]) => n).join(', ')} and the page logos to ${OUT}`);
