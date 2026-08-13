// Dev-only: generate the PWA PNG icons (no image libraries needed). A brand-red
// square with a gold "bowl" disc + white ring — full-bleed so it works maskable.
// Run from waitlist-app: node scripts/gen-icons.js
const zlib = require('zlib'), fs = require('fs'), path = require('path');

function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size) {
  const bg = [0xb9, 0x1c, 0x1c], gold = [0xf2, 0xc1, 0x4e], white = [0xff, 0xff, 0xff];
  const cx = (size - 1) / 2, cy = (size - 1) / 2, R = size * 0.34, ring = size * 0.05;
  const raw = Buffer.alloc(size * (size * 4 + 1)); let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const col = d < R ? gold : (d < R + ring ? white : bg);
      raw[p++] = col[0]; raw[p++] = col[1]; raw[p++] = col[2]; raw[p++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const out = path.join(__dirname, '..', 'public');
[[512, 'icon-512.png'], [192, 'icon-192.png'], [180, 'apple-touch-icon.png']].forEach(([s, f]) => {
  fs.writeFileSync(path.join(out, f), png(s)); console.log('wrote', f, s + 'px');
});
