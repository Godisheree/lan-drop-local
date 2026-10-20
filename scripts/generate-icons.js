#!/usr/bin/env node
/**
 * Generator ikon PNG — nol dependency, nol CDN.
 *
 * Menulis PNG langsung: header + IHDR + IDAT (zlib bawaan Node) + IEND.
 * CRC32 diimplementasikan sendiri. Rendering pakai supersampling 4x lalu
 * downsample, jadi tepinya halus.
 *
 * Ikon dibuat dari bentuk yang sama dengan favicon & badge di notify.js:
 * lingkaran biru + panah turun putih.
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

const BLUE = [0x5b, 0x8d, 0xef];
const WHITE = [0xff, 0xff, 0xff];

/**
 * Whether a point (in normalized 0..1 space) is inside the glyph.
 *
 * @param {number} nx - x / size
 * @param {number} ny - y / size
 * @returns {{inside: boolean, color: number[]}|null}
 */
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

function sampleGlyph(nx, ny) {
  // Panah turun: batang vertikal + kepala chevron (dua garis miring).
  const cx = 0.5;
  const STEM_HALF = 0.068;
  const STEM_TOP = 0.19;
  const STEM_BOTTOM = 0.56;
  const HEAD_TOP = 0.44;
  const TIP_Y = 0.79;
  const HEAD_HALF = 0.175;
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

  return null;
}

/**
 * Render an icon to RGBA pixels.
 *
 * @param {number} size - output size in pixels
 * @param {Object} [opts]
 * @param {boolean} [opts.maskable] - full-bleed background, smaller glyph
 * @param {boolean} [opts.transparent] - no background circle
 * @param {number[]} [opts.background] - background color
 * @returns {Buffer} RGBA
 */
function renderIcon(size, opts = {}) {
  const {
    maskable = false,
    transparent = false,
    background = BLUE,
  } = opts;

  const SS = 4; // supersampling factor
  const rgba = Buffer.alloc(size * size * 4);

  // Glyph gets smaller for maskable (safe zone is the inner 80%).
  const glyphScale = maskable ? 0.62 : 1;

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
            color = background;
            alpha = 255;
          } else if (transparent) {
            color = null;
            alpha = 0;
          } else {
            // Circle background
            const dx = nx - 0.5;
            const dy = ny - 0.5;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= 0.48) {
              color = background;
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
