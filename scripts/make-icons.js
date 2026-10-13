'use strict';

// Draws the Milaclone icon and writes every size the app needs under
// public/icons: PWA icons (192, 512 and a maskable 512), the iPhone/iPad touch
// icon, the browser tab icon and a Windows .ico (256 px PNG inside) used by the
// Start-menu shortcut. Run with: node scripts/make-icons.js

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// An M whose second stroke ends in a spark, on a violet gradient.
const glyph = (scale = 1) => `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <path d="M128 378V170l128 124 128-124v208" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M388 74l11 30 30 11-30 11-11 30-11-30-30-11 30-11z" fill="#fff"/>
  </g>`;
const svg = ({ rounded = true, scale = 1 } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d3df0"/><stop offset="1" stop-color="#a17bff"/></linearGradient></defs>
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="url(#g)"/>${glyph(scale)}
</svg>`;

const png = (markup, size) => sharp(Buffer.from(markup)).resize(size, size).png().toBuffer();

// .ico with one PNG image (supported since Windows Vista)
function ico(pngBuffer, size = 256) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

(async () => {
  const round = svg(), full = svg({ rounded: false, scale: 0.78 });   // maskable: art inside the safe zone
  const write = (name, buf) => fs.writeFileSync(path.join(OUT, name), buf);
  write('icon-192.png', await png(round, 192));
  write('icon-512.png', await png(round, 512));
  write('icon-maskable-512.png', await png(full, 512));
  write('apple-touch-icon.png', await png(svg({ rounded: false, scale: 0.86 }), 180));
  write('favicon-32.png', await png(round, 32));
  write('milaclone.ico', ico(await png(round, 256)));
  fs.writeFileSync(path.join(OUT, 'icon.svg'), round.trim() + '\n');
  console.log('icons written to', OUT);
})();
