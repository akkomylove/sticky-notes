'use strict';

// 程序化光栅化应用图标：纸色圆角便签 + 右下折角 + 墨色对勾。
// 4x 超采样后盒式降采样，保证 16px 托盘尺寸下圆角和对勾依旧干净。
// 跑法：node build/make-icon.js → build/icon.ico + renderer/assets/icon-*.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MASTER = 256;
const SS = 4;
const HI = MASTER * SS;
const ROOT = path.join(__dirname, '..');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const PAPER_TOP = hex('#f9e8a6');
const PAPER_BOT = hex('#f2d88b');
const FLAP_TOP = hex('#e9c86f');
const FLAP_BOT = hex('#d9b455');
const INK = hex('#35301c');
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// 折角斜线 x+y=420：外侧切掉，内侧三角形是翻折过来的纸背。
function sample(x, y) {
  if (distSeg(x, y, 82, 134, 114, 166) <= 11 || distSeg(x, y, 114, 166, 176, 102) <= 11) return [...INK, 255];
  if (x >= 172 && y >= 172 && x + y <= 420) return [...mix(FLAP_TOP, FLAP_BOT, (x + y - 344) / 152), 255];
  if (inRoundRect(x, y, 8, 8, 248, 248, 52) && x + y <= 420) return [...mix(PAPER_TOP, PAPER_BOT, (y - 8) / 240), 255];
  return [0, 0, 0, 0];
}

const hi = Buffer.alloc(HI * HI * 4);
for (let y = 0; y < HI; y += 1) {
  for (let x = 0; x < HI; x += 1) {
    const [r, g, b, a] = sample((x + 0.5) / SS, (y + 0.5) / SS);
    const o = (y * HI + x) * 4;
    hi[o] = r;
    hi[o + 1] = g;
    hi[o + 2] = b;
    hi[o + 3] = a;
  }
}

function downsample(n) {
  const out = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    const y0 = Math.round((y * HI) / n);
    const y1 = Math.round(((y + 1) * HI) / n);
    for (let x = 0; x < n; x += 1) {
      const x0 = Math.round((x * HI) / n);
      const x1 = Math.round(((x + 1) * HI) / n);
      let r = 0;
      let g = 0;
      let b = 0;
      let opaque = 0;
      let total = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const o = (sy * HI + sx) * 4;
          total += 1;
          if (hi[o + 3]) {
            opaque += 1;
            r += hi[o];
            g += hi[o + 1];
            b += hi[o + 2];
          }
        }
      }
      const o = (y * n + x) * 4;
      out[o] = opaque ? Math.round(r / opaque) : 0;
      out[o + 1] = opaque ? Math.round(g / opaque) : 0;
      out[o + 2] = opaque ? Math.round(b / opaque) : 0;
      out[o + 3] = Math.round((opaque / total) * 255);
    }
  }
  return out;
}

const crcTable = [];
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, trailer]);
}
function png(n, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(n * (1 + n * 4));
  for (let y = 0; y < n; y += 1) {
    raw[y * (1 + n * 4)] = 0;
    rgba.copy(raw, y * (1 + n * 4) + 1, y * n * 4, (y + 1) * n * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = [];
  const blobs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.buf.length;
    dirs.push(d);
    blobs.push(e.buf);
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

const assets = path.join(ROOT, 'renderer', 'assets');
fs.mkdirSync(assets, { recursive: true });
const sizes = [256, 48, 32, 24, 16];
const pngs = new Map();
for (const n of sizes) {
  const buf = png(n, downsample(n));
  pngs.set(n, buf);
  if (n !== 48) fs.writeFileSync(path.join(assets, `icon-${n}.png`), buf);
}
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico([256, 48, 32, 16].map((n) => ({ size: n, buf: pngs.get(n) }))));
console.log('written:', ['build/icon.ico', ...[256, 32, 24, 16].map((n) => `renderer/assets/icon-${n}.png`)].join(', '));