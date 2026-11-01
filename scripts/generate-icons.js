#!/usr/bin/env node
/**
 * Generator ikon PNG — nol dependency, nol CDN.
 *
 * Menulis PNG langsung: header + IHDR + IDAT (zlib bawaan Node) + IEND.
 * CRC32 diimplementasikan sendiri. Rendering pakai supersampling 4x lalu
 * downsample, jadi tepinya halus.
 *
 * Mark: squircle gradien oren + panah turun dengan garis dasar ("drop").
 * Bentuk yang sama dipakai favicon dinamis di public/js/features/notify.js.
 * Lihat docs/adr/0010-brand-color-dan-logo.md.
 *
 * Usage: node scripts/generate-icons.js
 * Output: public/icons/*.png
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG encoding ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * @param {Buffer} buf
 * @returns {number} CRC32
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type - 4 karakter
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Susun file PNG dari pixel RGBA.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba - width*height*4 byte
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Scanline per baris: filter byte 0 + data RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Rendering ──────────────────────────────────────────────────────────────

// Aksen dari public/css/tokens.css (--accent → --accent-strong, mode terang).
const ACCENT_START = [0xff, 0x6b, 0x1a];
const ACCENT_END = [0xc2, 0x41, 0x0c];
const WHITE = [0xff, 0xff, 0xff];

/**
 * Warna latar pada satu titik: gradien diagonal, atau satu warna kalau dipaksa.
 *
 * @param {number} nx - x / size (0..1)
 * @param {number} ny - y / size (0..1)
 * @param {number[]|null} background
 * @returns {number[]}
 */
function backgroundColor(nx, ny, background) {
  if (background) return background;
  const t = Math.max(0, Math.min(1, (nx + ny) / 2));
  return [
    ACCENT_START[0] + (ACCENT_END[0] - ACCENT_START[0]) * t,
    ACCENT_START[1] + (ACCENT_END[1] - ACCENT_START[1]) * t,
    ACCENT_START[2] + (ACCENT_END[2] - ACCENT_START[2]) * t,
  ];
}

/**
 * Jarak titik ke segmen garis.
 *
 * @param {number} px
 * @param {number} py
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Apakah titik ada di dalam glyph (panah turun + garis dasar).
 *
 * @param {number} nx - x / size
 * @param {number} ny - y / size
 * @returns {{inside: boolean, color: number[]}|null}
 */
function sampleGlyph(nx, ny) {
  // Panah turun: batang vertikal + kepala chevron + garis dasar ("drop").
  const cx = 0.5;
  const STEM_HALF = 0.068;
  const STEM_TOP = 0.16;
  const STEM_BOTTOM = 0.50;
  const HEAD_TOP = 0.38;
  const TIP_Y = 0.68;
  const HEAD_HALF = 0.175;
  const BASE_Y = 0.82;
  const BASE_HALF = 0.24;
  const STROKE = 0.05;

  // Batang vertikal
  if (Math.abs(nx - cx) <= STEM_HALF && ny >= STEM_TOP && ny <= STEM_BOTTOM) {
    return { inside: true, color: WHITE };
  }

  // Kepala: dua garis dari luar-atas menyatu di ujung bawah.
  const leftX = cx - HEAD_HALF;
  const rightX = cx + HEAD_HALF;

  const dLeft = distanceToSegment(nx, ny, leftX, HEAD_TOP, cx, TIP_Y);
  const dRight = distanceToSegment(nx, ny, rightX, HEAD_TOP, cx, TIP_Y);

  if (Math.min(dLeft, dRight) <= STROKE) {
    return { inside: true, color: WHITE };
  }

  // Garis dasar — bagian "drop" (sesuatu yang jatuh ke sebuah permukaan).
  if (Math.abs(ny - BASE_Y) <= STROKE && Math.abs(nx - cx) <= BASE_HALF) {
    return { inside: true, color: WHITE };
  }

  return null;
}

/**
 * Render an icon to RGBA pixels.
 *
 * @param {number} size - output size in pixels
 * @param {Object} [opts]
 * @param {boolean} [opts.maskable] - full-bleed background, smaller glyph
 * @param {boolean} [opts.transparent] - no background shape
 * @param {number[]} [opts.background] - warna latar paksa (default: gradien aksen)
 * @returns {Buffer} RGBA
 */
function renderIcon(size, opts = {}) {
  const {
    maskable = false,
    transparent = false,
    background = null,
  } = opts;

  const SS = 4; // supersampling factor
  const rgba = Buffer.alloc(size * size * 4);

  // Glyph gets smaller for maskable (safe zone is the inner 80%).
  const glyphScale = maskable ? 0.62 : 1;

  // Squircle: setengah sisi + radius sudut, dalam fraksi sisi.
  const HALF = 0.44;
  const CORNER = 0.16;
  const STRAIGHT = HALF - CORNER;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const nx = px / size;
          const ny = py / size;

          let color = null;
          let alpha = 0;

          if (maskable) {
            // Full-bleed background
            color = backgroundColor(nx, ny, background);
            alpha = 255;
          } else if (transparent) {
            color = null;
            alpha = 0;
          } else {
            // Squircle background
            const dx = Math.abs(nx - 0.5);
            const dy = Math.abs(ny - 0.5);
            const inside = dx <= HALF && dy <= HALF
              && !(dx > STRAIGHT && dy > STRAIGHT
                && Math.hypot(dx - STRAIGHT, dy - STRAIGHT) > CORNER);

            if (inside) {
              color = backgroundColor(nx, ny, background);
              alpha = 255;
            }
          }

          if (alpha > 0) {
            // Glyph in scaled space
            const gx = (nx - 0.5) / glyphScale + 0.5;
            const gy = (ny - 0.5) / glyphScale + 0.5;

            const hit = sampleGlyph(gx, gy);
            if (hit && hit.inside) {
              color = hit.color;
            }
          }

          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += alpha;
          }
        }
      }

      const samples = SS * SS;
      const idx = (y * size + x) * 4;
      const alphaAvg = a / samples;

      if (alphaAvg > 0) {
        // Average color only over covered samples
        const covered = a / 255;
        rgba[idx] = Math.round(r / covered);
        rgba[idx + 1] = Math.round(g / covered);
        rgba[idx + 2] = Math.round(b / covered);
        rgba[idx + 3] = Math.round(alphaAvg);
      }
    }
  }

  return rgba;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const outDir = path.join(__dirname, '..', 'public', 'icons');
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [
    { file: 'icon-192.png', size: 192, opts: {} },
    { file: 'icon-512.png', size: 512, opts: {} },
    { file: 'icon-maskable-512.png', size: 512, opts: { maskable: true } },
    { file: 'apple-touch-icon.png', size: 180, opts: { maskable: true } },
    { file: 'favicon-32.png', size: 32, opts: {} },
  ];

  for (const target of targets) {
    const rgba = renderIcon(target.size, target.opts);
    const png = encodePng(target.size, target.size, rgba);
    const outPath = path.join(outDir, target.file);
    fs.writeFileSync(outPath, png);
    console.log(`${target.file.padEnd(24)} ${target.size}x${target.size}  ${png.length} byte`);
  }

  console.log(`\nIkon dibuat di ${outDir}`);
}

if (require.main === module) main();

module.exports = { encodePng, renderIcon };
