// scripts/app-icons.mjs — makes the app icons in public/icons (the
// installable app, phone push notifications, the browser tab). Run with
// `node scripts/app-icons.mjs` after changing the design below.
//
// A floor-plan outline under a dimension line: a takeoff. White on the app's
// blue. Maskable and Apple icons are full-bleed with the drawing inside the
// middle 60% (the platforms crop their own shape); the badge is the drawing
// alone, for Android's status bar.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const drawing = (color) => `
  <g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M156 146 H356 M156 128 V164 M356 128 V164" stroke-width="18"/>
    <path d="M156 196 H356 V316 H276 V376 H156 Z" stroke-width="26"/>
  </g>`;
const background = (rounded) => `
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/>
  </linearGradient></defs>
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="url(#g)"/>`;
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${body}</svg>`);

// The maskable one's drawing shrinks into the safe zone.
const safe = (body) => `<g transform="translate(256 256) scale(0.8) translate(-256 -256)">${body}</g>`;

const icons = [
  ['icon-192.png', 192, svg(background(true) + drawing('#fff'))],
  ['icon-512.png', 512, svg(background(true) + drawing('#fff'))],
  ['icon-maskable-512.png', 512, svg(background(false) + safe(drawing('#fff')))],
  ['apple-touch-icon.png', 180, svg(background(false) + safe(drawing('#fff')))],
  ['favicon-32.png', 32, svg(background(true) + drawing('#fff'))],
  ['badge-96.png', 96, svg(`<g transform="translate(256 256) scale(1.25) translate(-256 -252)">${drawing('#fff')}</g>`)],
];
for (const [name, size, source] of icons) {
  await sharp(source, { density: 72 * (size / 512) * 4 }).resize(size, size).png({ compressionLevel: 9 }).toFile(join(out, name));
  console.log(`public/icons/${name} (${size}px)`);
}
