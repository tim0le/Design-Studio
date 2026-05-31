#!/usr/bin/env node
/*
 * generate-icons.js — produces the PWA PNG icons with zero external deps.
 *
 * Draws an on-brand icon (warm near-black background, burnt-orange rounded
 * square with a centered diamond glyph) into raw RGBA pixels, then encodes
 * them as a PNG using Node's built-in zlib. Matches the .topbar-brand-mark.
 *
 * Usage:  node scripts/generate-icons.js
 * Outputs (relative to repo root):
 *   public/icons/icon-192.png
 *   public/icons/icon-512.png
 *   public/icons/icon-maskable-512.png
 *   public/apple-touch-icon.png   (180x180)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Brand tokens (mirror style.css :root) ─────────────────────────────
const BG = [0x0d, 0x0c, 0x0b];      // --bg  warm near-black
const ACCENT = [0xb8, 0x5a, 0x3e];  // --accent burnt orange
const GLYPH = [0xf5, 0xf3, 0xf0];   // --white diamond glyph

// ── Minimal PNG encoder (truecolor + alpha, 8-bit) ────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: truecolor + alpha
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Add per-scanline filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing helpers ───────────────────────────────────────────────────
function makeCanvas(size) {
  return { size, px: Buffer.alloc(size * size * 4) };
}

function setPx(c, x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  // Source-over alpha blend onto existing pixel.
  const sa = a / 255;
  const da = c.px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  for (let k = 0; k < 3; k++) {
    const sc = rgb[k];
    const dc = c.px[i + k];
    c.px[i + k] = oa === 0 ? 0 : Math.round((sc * sa + dc * da * (1 - sa)) / oa);
  }
  c.px[i + 3] = Math.round(oa * 255);
}

function fillBackground(c, rgb) {
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) setPx(c, x, y, rgb, 255);
  }
}

// Filled rounded rectangle with anti-aliased edges via 3x3 supersampling.
function roundedRect(c, x0, y0, w, h, r, rgb) {
  const x1 = x0 + w, y1 = y0 + h;
  const inside = (px, py) => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    // corner regions
    const cx = px < x0 + r ? x0 + r : (px > x1 - r ? x1 - r : px);
    const cy = py < y0 + r ? y0 + r : (py > y1 - r ? y1 - r : py);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++;
        }
      }
      if (hits) setPx(c, x, y, rgb, Math.round((hits / 9) * 255));
    }
  }
}

// Filled diamond (rotated square) centered at (cx,cy) with given half-extent.
function diamond(c, cx, cy, half, rgb) {
  const inside = (px, py) => Math.abs(px - cx) + Math.abs(py - cy) <= half;
  for (let y = Math.floor(cy - half); y <= Math.ceil(cy + half); y++) {
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++;
        }
      }
      if (hits) setPx(c, x, y, rgb, Math.round((hits / 9) * 255));
    }
  }
}

// ── Compose one icon ──────────────────────────────────────────────────
// maskable=true keeps the artwork inside the safe zone (~80%) so platform
// masks never clip the glyph; the background fills the full bleed area.
function renderIcon(size, maskable) {
  const c = makeCanvas(size);
  fillBackground(c, BG);

  // Padding: standard icons hug the edges a bit; maskable stays in safe zone.
  const pad = maskable ? size * 0.18 : size * 0.10;
  const tile = size - pad * 2;
  const radius = tile * 0.22;
  roundedRect(c, pad, pad, tile, tile, radius, ACCENT);

  // Diamond glyph centered on the tile.
  diamond(c, size / 2, size / 2, tile * 0.30, GLYPH);

  return encodePng(size, size, c.px);
}

// ── Write files ───────────────────────────────────────────────────────
const root = path.resolve(__dirname, '..');
const iconsDir = path.join(root, 'public', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

const outputs = [
  [path.join(iconsDir, 'icon-192.png'), renderIcon(192, false)],
  [path.join(iconsDir, 'icon-512.png'), renderIcon(512, false)],
  [path.join(iconsDir, 'icon-maskable-512.png'), renderIcon(512, true)],
  [path.join(root, 'public', 'apple-touch-icon.png'), renderIcon(180, false)],
];

for (const [file, buf] of outputs) {
  fs.writeFileSync(file, buf);
  console.log(`wrote ${path.relative(root, file)} (${buf.length} bytes)`);
}
