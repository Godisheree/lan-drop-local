#!/usr/bin/env node
/**
 * Regression check: kelengkapan terjemahan.
 *
 * Empat hal yang gampang rusak dan tidak kelihatan sampai user melihatnya:
 * 1. Key dipakai di HTML/JS tapi tidak ada di kamus → yang tampil "nav.connect"
 *    mentah di layar.
 * 2. Key ada di satu kamus tapi tidak di kamus lain → bahasa Indonesia
 *    kehilangan sebagian kalimat.
 * 3. `data-i18n` tanpa key, atau key tanpa `data-i18n`.
 * 4. Teks Indonesia tertinggal di HTML/JS utama (terjemahan setengah jalan).
 *
 * Usage: node scripts/check-i18n.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`OK   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name} — ${err && err.message ? err.message : err}`);
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(PUBLIC, rel), 'utf8'));
}

const en = readJson('locales/en.json');
const id = readJson('locales/id.json');

/** Kumpulkan semua file yang boleh berisi teks UI. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'locales') continue;
      walk(full, out);
    } else if (/\.(html|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(PUBLIC);

// ── Referensi key dari kode ────────────────────────────────────────────────

/** Key yang dipakai lewat `data-i18n` / `data-i18n-attr` / `t('...')`. */
function collectUsedKeys() {
  const used = new Map(); // key -> Set(file)

  for (const file of files) {
    // i18n.js sendiri berisi CONTOH pemakaian di komentar
    // (`data-i18n="key"`) dan menerjemahkan key apa pun yang diberikan —
    // keduanya bukan referensi. Lewati sebelum regex apa pun dijalankan.
    if (path.basename(file) === 'i18n.js') continue;

    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const add = (key) => {
      const clean = key.trim();
      if (!clean) return;
      if (!used.has(clean)) used.set(clean, new Set());
      used.get(clean).add(rel);
    };

    for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) add(m[1]);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(',')) {
        const key = pair.split(':')[1];
        if (key) add(key);
      }
    }

    // t('key') dan t("key") — tapi BUKAN t(key) variabel. `msg()` adalah
    // padanan lokal di login.js (halaman itu sengaja tanpa import).
    for (const m of src.matchAll(/\b(?:t|msg)\(\s*'([a-zA-Z][\w.]*)'\s*[,)]/g)) add(m[1]);
    for (const m of src.matchAll(/\b(?:t|msg)\(\s*"([a-zA-Z][\w.]*)"\s*[,)]/g)) add(m[1]);

    // Peta status -> key: `const STATUS_KEY = { pending: 'dashboard.statusPending', … }`.
    // Nilainya dipakai lewat variabel, jadi regex t() di atas tidak melihatnya.
    for (const m of src.matchAll(/STATUS_KEY\s*=\s*\{([\s\S]*?)\};/g)) {
      for (const k of m[1].matchAll(/'([a-zA-Z][\w.]*)'/g)) add(k[1]);
    }

    // Helper bersarang: `const U = (key) => t(key);` lalu `U('unit.secondShort')`.
    for (const m of src.matchAll(/\b[A-Z]\w*\(\s*'([a-z][\w.]*\.[\w.]+)'\s*\)/g)) add(m[1]);
  }
  return used;
}

const used = collectUsedKeys();

// ── 1 & 2. Paritas kamus ───────────────────────────────────────────────────

check('en.json dan id.json punya key identik', () => {
  const onlyEn = Object.keys(en).filter((k) => !(k in id));
  const onlyId = Object.keys(id).filter((k) => !(k in en));
  assert.deepStrictEqual(
    { onlyEn, onlyId },
    { onlyEn: [], onlyId: [] },
    `en saja: ${onlyEn.join(', ') || '-'} | id saja: ${onlyId.join(', ') || '-'}`
  );
});

check('setiap key yang dipakai ada di kedua kamus', () => {
  const missing = [];
  for (const [key, where] of used) {
    if (!(key in en)) missing.push(`${key} (en) ← ${[...where][0]}`);
    if (!(key in id)) missing.push(`${key} (id) ← ${[...where][0]}`);
  }
  assert.strictEqual(missing.length, 0, `key tidak ditemukan: ${missing.slice(0, 8).join(' · ')}`);
});

check('tidak ada key yatim di kamus', () => {
  const orphan = Object.keys(en).filter((k) => !used.has(k));
  assert.strictEqual(orphan.length, 0, `tidak dipakai di mana pun: ${orphan.slice(0, 8).join(', ')}`);
});

check('kedua kamus tidak kosong dan tidak ada nilai kosong', () => {
  for (const [loc, dict] of [['en', en], ['id', id]]) {
    const keys = Object.keys(dict);
    assert.ok(keys.length > 100, `${loc} hanya ${keys.length} key`);
    const blank = keys.filter((k) => !String(dict[k]).trim());
    assert.strictEqual(blank.length, 0, `${loc} punya nilai kosong: ${blank.slice(0, 5).join(', ')}`);
  }
});

check('placeholder {x} sama di kedua bahasa', () => {
  const mismatch = [];
  for (const key of Object.keys(en)) {
    const pick = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
    if (pick(en[key]) !== pick(id[key])) {
      mismatch.push(`${key}: en(${pick(en[key])}) ≠ id(${pick(id[key])})`);
    }
  }
  assert.strictEqual(mismatch.length, 0, mismatch.slice(0, 5).join(' · '));
});

// ── 3. Atribut i18n di HTML ────────────────────────────────────────────────

check('setiap data-i18n punya key yang valid', () => {
  const bad = [];
  for (const file of files.filter((f) => f.endsWith('.html'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/data-i18n="([^"]*)"/g)) {
      if (!m[1].trim()) bad.push(path.relative(ROOT, file));
    }
  }
  assert.strictEqual(bad.length, 0, `data-i18n kosong di: ${bad.join(', ')}`);
});

// ── 4. Teks Indonesia tertinggal ───────────────────────────────────────────

check('index.html tidak lagi berbahasa Indonesia', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const leftovers = src
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      if (line.includes('data-i18n')) return false; // sudah diterjemahkan runtime
      if (line.trim().startsWith('<!--')) return false;
      return /\b(Perangkat|Riwayat|Kirim|Terima|Tolak|Batal|Salin|Tutup|Sambung|Memuat|Pastikan|Kedua|Kalau|Pilih|Belum)\b/.test(line);
    })
    .map(({ no, line }) => `${no}: ${line.trim().slice(0, 50)}`);
  assert.strictEqual(leftovers.length, 0, `baris: ${leftovers.slice(0, 4).join(' | ')}`);
});

check('dashboard.html tidak lagi berbahasa Indonesia', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'dashboard.html'), 'utf8');
  const leftovers = src
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      if (line.includes('data-i18n')) return false;
      if (line.trim().startsWith('<!--')) return false;
      return /\b(Perangkat|Riwayat|Kirim|Terima|Tolak|Batal|Salin|Tutup|Memuat|Pastikan|Kalau|Pilih|Belum|Hapus|Simpan|Keluar)\b/.test(line);
    })
    .map(({ no, line }) => `${no}: ${line.trim().slice(0, 50)}`);
  assert.strictEqual(leftovers.length, 0, `baris: ${leftovers.slice(0, 4).join(' | ')}`);
});

// ── 5. Aset i18n ikut terkirim ─────────────────────────────────────────────

check('bendera SVG ada dan ikut paket public/', () => {
  for (const flag of ['gb.svg', 'id.svg']) {
    const file = path.join(PUBLIC, 'icons', 'flags', flag);
    assert.ok(fs.existsSync(file), `${flag} tidak ada`);
    const svg = fs.readFileSync(file, 'utf8');
    assert.ok(svg.includes('<svg'), `${flag} bukan SVG`);
    assert.ok(!/<script/i.test(svg), `${flag} berisi <script>`);
  }
  const pkg = require(path.join(ROOT, 'package.json'));
  assert.ok(pkg.files.includes('public/'), 'public/ harus di whitelist npm');
});


// ── 6. Teks Indonesia tertinggal di JS frontend ────────────────────────────
// Pemeriksaan HTML saja tidak cukup: string UI juga dibuat di JS (`text:`,
// `title:`, `aria-label:`). Dua kebocoran nyata lolos dari sini sekali.

const ID_WORDS = new RegExp("\\b(Perangkat|Riwayat|Kirim|Terima|Tolak|Batal|Salin|Tutup|Sambung|Memuat|Pastikan|Kedua|Kalau|Pilih|Belum|Hapus|Simpan|Keluar|Batalkan|Lokasi|disalin|tidak|sudah|gagal|Menunggu|mengirim|diterima|tersimpan|ditampilkan|dipakai|dibuka|diatur|terhubung|perangkat|lalu|kepada|dari|untuk|dengan|adalah|bisa|harus|hanya|masih|juga|agar|supaya|karena|tetapi|atau|dan)\\b");

/**
 * Cari baris yang memuat LITERAL STRING berbahasa Indonesia.
 *
 * Pendekatan lama hanya memeriksa pola tertentu (`text:`, `showToast(`, …),
 * sehingga kebocoran nyata lolos: `copyText(x, 'Nama file disalin')`,
 * `new Error('Koneksi terputus')`, `label: 'Terima permintaan masuk'`, dan
 * `toast('Log disalin ke clipboard')`. Sekarang: ambil SEMUA literal string di
 * baris itu, lalu periksa apakah salah satunya mengandung kata Indonesia.
 *
 * Komentar dibuang dulu (banyak komentar berbahasa Indonesia dan itu memang
 * tidak apa-apa — kode & komentar boleh Indonesia, yang tidak boleh adalah
 * teks yang tampil ke user).
 */
function jsLeftovers(rel) {
  const src = fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
  const out = [];

  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;

    // Buang komentar di ujung baris, lalu semua literal string.
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/(^|[^:])\/\/.*$/, '$1');
    const literals = code.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [];

    for (const literal of literals) {
      const inner = literal.slice(1, -1);
      // Nama kelas/atribut/selector/URL bukan teks untuk user.
      if (/^[\w-]+$/.test(inner)) continue;
      if (/^(?:[\w-]+\s+)*[\w-]+$/.test(inner) && !ID_WORDS.test(inner)) continue;
      if (/^(?:\.|#|\[|@|\/|https?:)/.test(inner)) continue;
      // Markup SVG/XML bukan teks untuk user.
      if (/^\s*</.test(inner)) continue;
      if (ID_WORDS.test(inner)) {
        out.push(`${i + 1}: ${literal.slice(0, 46)}`);
        break;
      }
    }
  });

  return out;
}

check('dashboard.js tidak lagi berbahasa Indonesia', () => {
  const left = jsLeftovers('js/dashboard.js');
  assert.strictEqual(left.length, 0, `baris: ${left.slice(0, 4).join(' | ')}`);
});

for (const name of ['transfers', 'devices', 'send', 'receive', 'connect', 'history', 'gallery', 'pwa', 'text']) {
  check(`features/${name}.js tidak lagi berbahasa Indonesia`, () => {
    const left = jsLeftovers(`js/features/${name}.js`);
    assert.strictEqual(left.length, 0, `baris: ${left.slice(0, 3).join(' | ')}`);
  });
}

// ── 7. Pesan error server tidak boleh berbahasa Indonesia ─────────────────
// Pesan ini dikirim ke klien (`{ error: '...' }`) dan ditampilkan di UI, jadi
// termasuk teks user-facing walau tinggal di server/.

check('pesan error server berbahasa Inggris', () => {
  const words = ['tidak', 'gagal', 'belum', 'sudah', 'harus', 'hanya', 'melebihi',
    'ditolak', 'diizinkan', 'bukan', 'untuk', 'dengan', 'dari', 'tidak ada'];
  const bad = [];

  for (const file of fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(ROOT, 'server', file), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/error\s*:/.test(line)) return;
      const low = line.toLowerCase();
      if (words.some((w) => low.includes(` ${w}`))) bad.push(`${file}:${i + 1}`);
    });
  }

  assert.strictEqual(bad.length, 0, `pesan error Indonesia: ${bad.slice(0, 5).join(', ')}`);
});

// ── hasil ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} lulus`);
if (failed.length) process.exit(1);
