// Erzeugt die App-Icons (PNG) aus der Bär-Illustration.
// Aufruf: cd tools && npm install && npm run icons
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'icons');

const C = { bg: '#F3EBDF', line: '#8C6A50', fill: '#FCF8F2', soft: '#EBDAC4', blush: '#E9B9A3' };

// Bärenkopf, gleiche Form wie in js/bear.js (Koordinaten 40..200 x 22..172)
const head = `
  <circle cx="76" cy="57" r="21" fill="${C.fill}" stroke="${C.line}" stroke-width="5.5"/>
  <circle cx="164" cy="57" r="21" fill="${C.fill}" stroke="${C.line}" stroke-width="5.5"/>
  <circle cx="76" cy="57" r="10" fill="${C.soft}"/>
  <circle cx="164" cy="57" r="10" fill="${C.soft}"/>
  <circle cx="120" cy="97" r="56" fill="${C.fill}" stroke="${C.line}" stroke-width="5.5"/>
  <circle cx="86" cy="113" r="8.5" fill="${C.blush}" opacity="0.55"/>
  <circle cx="154" cy="113" r="8.5" fill="${C.blush}" opacity="0.55"/>
  <circle cx="100" cy="93" r="5.5" fill="${C.line}"/>
  <circle cx="140" cy="93" r="5.5" fill="${C.line}"/>
  <ellipse cx="120" cy="117" rx="22" ry="16" fill="${C.soft}" stroke="${C.line}" stroke-width="5"/>
  <path d="M111.5 109.5q8.5-5 17 0q-2.5 7-8.5 8q-6-1-8.5-8z" fill="${C.line}"/>
  <path d="M120 117.5v4.5M120 122q-5 5.5-10 2M120 122q5 5.5 10 2" fill="none" stroke="${C.line}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;

// Kopf-Mitte (inkl. Ohren) liegt bei x=120, y≈94; Höhe ca. 135 Einheiten.
function iconSVG({ scale, rounded }) {
  const size = 512;
  const s = (size * scale) / 160;
  const tx = size / 2 - 120 * s;
  const ty = size / 2 - 95 * s;
  const bg = rounded
    ? `<rect width="${size}" height="${size}" rx="112" fill="${C.bg}"/>`
    : `<rect width="${size}" height="${size}" fill="${C.bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}<g transform="translate(${tx} ${ty}) scale(${s})">${head}</g></svg>`;
}

function png(svg, width, file) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  writeFileSync(join(out, file), r.render().asPng());
  console.log('✓', file, width + 'px');
}

const full = iconSVG({ scale: 0.8, rounded: false });
const maskable = iconSVG({ scale: 0.6, rounded: false });
png(full, 180, 'apple-touch-icon.png');
png(full, 192, 'icon-192.png');
png(full, 512, 'icon-512.png');
png(maskable, 512, 'icon-maskable-512.png');
writeFileSync(join(out, 'favicon.svg'), iconSVG({ scale: 0.8, rounded: true }));
writeFileSync(join(out, 'icon.svg'), full);
console.log('✓ favicon.svg, icon.svg');
