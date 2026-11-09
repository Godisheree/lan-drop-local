#!/usr/bin/env node
/**
 * Regression check: kelengkapan terjemahan dan tidak ada teks Indonesia yang
 * bocor ke UI English.
 *
 * Yang dijaga:
 * 1. Key dipakai di HTML/JS tapi tidak ada di kamus → yang tampil key mentah.
 * 2. Key ada di satu kamus tapi tidak di kamus lain → bahasa kehilangan kalimat.
 * 3. Placeholder `{x}` beda antar bahasa → interpolasi rusak.
 * 4. Teks Indonesia tertinggal di HTML.
 * 5. Teks Indonesia tertinggal di literal string JS (SEMUA literal, bukan pola
 *    properti tertentu — pola sempit pernah meloloskan 23 kebocoran).
 * 6. Pesan error server (`{ error: '...' }`) berbahasa Indonesia.
 * 7. Log server (`console.*`, `logbus.notice`) berbahasa Indonesia.
 * 8. `/dashboard` benar-benar memuat kamus (initI18n) — dulu lupa, hasilnya
 *    "2unit.minuteShort" di layar.
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

/** Semua file yang boleh berisi teks UI. */
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

// Kata yang menandai kalimat Indonesia. Kata Inggris yang kebetulan sama
// (file, transfer, status, error, server, dashboard, peer, LAN, Tailscale)
// sengaja tidak dimasukkan.
const ID_WORDS = new RegExp(
  '\\b(Perangkat|Riwayat|Kirim|Terima|Tolak|Batal|Salin|Tutup|Sambung|Memuat|Pastikan|Kedua|Kalau|Pilih|Belum|Hapus|Simpan|Keluar|Batalkan|Lokasi|disalin|tidak|sudah|gagal|Menunggu|mengirim|diterima|tersimpan|ditampilkan|dipakai|dibuka|diatur|terhubung|perangkat|lalu|kepada|dari|untuk|dengan|adalah|bisa|harus|hanya|masih|juga|agar|supaya|karena|tetapi|atau|dan|lain|sini|atas|bawah|mau|ingin|dapat|sedang|akan|telah|kami|kamu|anda|saya|dia|ini|itu' +
    // Kata yang pernah bocor tanpa terdeteksi: uptime "sejak", progres "sisa",
    // auto-accept "Tersimpan ... mati", title log "belum dibaca". Daftar ini
    // menangkap kalimat utuh, bukan identifier, karena `jsLeftovers` melewati
    // literal yang mirip identifier lebih dulu.
    '|sejak|sisa|tersimpan|dibaca|mati|berjalan|diperiksa|tersedia' +
    // Kata yang dipakai di sekitar kontrol (label switch, judul tombol).
    // "Ikuti otomatis" di dashboard lolos karena tidak ada satu pun di sini.
    '|ikuti|otomatis|tombol|tekan|pintasan|sandi|kunci)\\b',
  'i'
);

// ── 1. Referensi key dari kode ─────────────────────────────────────────────

function collectUsedKeys() {
  const used = new Map();

  for (const file of files) {
    // i18n.js berisi contoh di komentar (`data-i18n="key"`) dan menerjemahkan
    // key apa pun — bukan referensi.
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

    for (const m of src.matchAll(/\b(?:t|msg)\(\s*'([a-zA-Z][\w.]*)'\s*[,)]/g)) add(m[1]);
    for (const m of src.matchAll(/\b(?:t|msg)\(\s*"([a-zA-Z][\w.]*)"\s*[,)]/g)) add(m[1]);

    for (const m of src.matchAll(/STATUS_KEY\s*=\s*\{([\s\S]*?)\};/g)) {
      for (const k of m[1].matchAll(/'([a-zA-Z][\w.]*)'/g)) add(k[1]);
    }

    for (const m of src.matchAll(/\b[A-Z]\w*\(\s*'([a-z][\w.]*\.[\w.]+)'\s*\)/g)) add(m[1]);
  }
  return used;
}

const used = collectUsedKeys();

// ── 2. Paritas kamus ───────────────────────────────────────────────────────

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
  assert.strictEqual(orphan.length, 0, `tidak dipakai: ${orphan.slice(0, 8).join(', ')}`);
});

check('kedua kamus terisi dan tidak ada nilai kosong', () => {
  for (const [loc, dict] of [['en', en], ['id', id]]) {
    const keys = Object.keys(dict);
    assert.ok(keys.length > 100, `${loc} hanya ${keys.length} key`);
    const blank = keys.filter((k) => !String(dict[k]).trim());
    assert.strictEqual(blank.length, 0, `${loc} nilai kosong: ${blank.slice(0, 5).join(', ')}`);
  }
});

check('placeholder {x} sama di kedua bahasa', () => {
  const mismatch = [];
  const pick = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
  for (const key of Object.keys(en)) {
    if (pick(en[key]) !== pick(id[key])) mismatch.push(`${key}: ${pick(en[key])} ≠ ${pick(id[key])}`);
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

// ── 4. Teks Indonesia tertinggal di HTML ───────────────────────────────────

/**
 * Teks Indonesia yang tertinggal di HTML.
 *
 * Dulu baris yang mengandung `data-i18n` dibuang BULAT, jadi teks yang
 * menumpang di baris yang sama lolos — `<span>Ikuti otomatis</span>` di
 * samping checkbox ber-`data-i18n` tidak pernah diperiksa. Sekarang yang
 * dibuang hanya elemen yang memang diterjemahkan (dan komentar), sisanya
 * diperiksa baris per baris.
 */
function htmlLeftovers(rel) {
  const src = fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
  const out = [];

  // Komentar HTML bisa lebih dari satu baris — buang dulu di seluruh sumber,
  // kalau tidak baris lanjutannya terbaca sebagai teks UI.
  const noComments = src.replace(/<!--[\s\S]*?-->/g, '');

  noComments.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (!line.trim()) return;

    // Elemen yang teksnya dikelola `data-i18n` (termasuk isinya).
    line = line.replace(/<([a-zA-Z][\w-]*)\b[^>]*\sdata-i18n="[^"]*"[^>]*>[^<]*<\/\1>/g, '');
    // Atribut terjemahan itu sendiri tidak boleh ikut diperiksa.
    line = line.replace(/data-i18n(?:-attr)?="[^"]*"/g, '');
    // Nilai atribut non-teks: id, class, name, type, href, src, dsb.
    line = line.replace(/\b(?:id|class|name|type|href|src|for|role|tabindex|lang|charset|rel|content|width|height|viewBox|xmlns|d|fill|stroke|aria-labelledby|aria-describedby|inputmode|autocomplete|maxlength|minlength|pattern|step|min|max|enterkeyhint)="[^"]*"/g, '');

    if (ID_WORDS.test(line)) out.push(`${i + 1}: ${line.trim().slice(0, 50)}`);
  });

  return out;
}

for (const page of ['index.html', 'dashboard.html', 'dashboard-login.html']) {
  check(`${page} tidak lagi berbahasa Indonesia`, () => {
    const left = htmlLeftovers(page);
    assert.strictEqual(left.length, 0, `baris: ${left.slice(0, 4).join(' | ')}`);
  });
}

// ── 5. Teks Indonesia di literal string JS ─────────────────────────────────

/**
 * Periksa SEMUA literal string, bukan pola properti tertentu. Pendekatan lama
 * hanya mengenali `text:`, `showToast(`, `setAttribute(` sehingga
 * `copyText(x, '...')`, `new Error('...')`, `label: '...'`, dan
 * `toast('...')` lolos — 23 kebocoran nyata.
 */
function jsLeftovers(rel) {
  const src = fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
  const out = [];

  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;

    const code = line.replace(/\/\*.*?\*\//g, '').replace(/(^|[^:])\/\/.*$/, '$1');
    const literals = code.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [];

    for (const literal of literals) {
      const inner = literal.slice(1, -1);
      if (/^[\w-]+$/.test(inner)) continue;
      if (/^(?:[\w-]+\s+)*[\w-]+$/.test(inner) && !ID_WORDS.test(inner)) continue;
      if (/^(?:\.|#|\[|@|\/|https?:)/.test(inner)) continue;
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

// ── 6. Pesan error server ──────────────────────────────────────────────────

check('pesan error server berbahasa Inggris', () => {
  const words = ['tidak', 'gagal', 'belum', 'sudah', 'harus', 'hanya', 'melebihi',
    'ditolak', 'diizinkan', 'bukan', 'untuk', 'dengan', 'dari'];
  const bad = [];

  for (const file of fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js'))) {
    fs.readFileSync(path.join(ROOT, 'server', file), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/error\s*:/.test(line)) return;
      const low = ` ${line.toLowerCase()}`;
      if (words.some((w) => low.includes(` ${w} `))) bad.push(`${file}:${i + 1}`);
    });
  }

  assert.strictEqual(bad.length, 0, `pesan error Indonesia: ${bad.slice(0, 5).join(', ')}`);
});

// ── 7. Log server ──────────────────────────────────────────────────────────

check('log server berbahasa Inggris', () => {
  const words = ['tidak', 'gagal', 'belum', 'sudah', 'juga', 'tetap', 'lewat',
    'mungkin', 'dari', 'untuk', 'dengan'];
  const bad = [];

  for (const file of fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js'))) {
    fs.readFileSync(path.join(ROOT, 'server', file), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/console\.(log|warn|error)|logbus\.notice/.test(line)) return;
      const low = ` ${line.toLowerCase()} `;
      if (words.some((w) => low.includes(` ${w} `))) bad.push(`${file}:${i + 1}`);
    });
  }

  assert.strictEqual(bad.length, 0, `log Indonesia: ${bad.slice(0, 5).join(', ')}`);
});

// ── 8. Kamus benar-benar dimuat di setiap halaman ──────────────────────────

check('dashboard.js memanggil initI18n sebelum merender', () => {
  // Bug nyata: /dashboard punya entry sendiri dan dulu tidak pernah memuat
  // kamus, jadi `t()` mengembalikan key mentah — "2unit.minuteShort 57..."
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'dashboard.js'), 'utf8');
  assert.ok(src.includes('initI18n'), 'dashboard.js harus memanggil initI18n()');
});

check('main.js memanggil initI18n dan initLocale', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'main.js'), 'utf8');
  assert.ok(src.includes('initI18n'), 'main.js harus memanggil initI18n()');
  assert.ok(src.includes('initLocale'), 'main.js harus memanggil initLocale()');
});

check('login.js memuat kamus sendiri', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'login.js'), 'utf8');
  assert.ok(src.includes('/locales/'), 'login.js harus memuat kamus lewat fetch');
});

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

// ── 9. File yang memanggil t() wajib meng-import t ─────────────────────────
//
// Bug nyata 1.2.16: features/transfers.js memanggil t() tanpa import, jadi
// setiap transfer yang lewat file itu melempar "t is not defined" — penerima
// melihat "Gagal menerima <file>: t is not defined" padahal bytes-nya sampai.

check('setiap file public/js yang memakai t() meng-import t', () => {
  const bad = [];
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    if (file.endsWith(path.join('core', 'i18n.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!/(^|[^\w.$])t\(/.test(src)) continue;
    const imports = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*i18n\.js['"]/.exec(src);
    const names = imports ? imports[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()) : [];
    const defines = /(?:const|let|var|function)\s+t/.test(src);
    if (!names.includes('t') && !defines) bad.push(path.relative(ROOT, file));
  }
  assert.deepStrictEqual(bad, [], `t() tanpa import: ${bad.join(', ')}`);
});

// ── hasil ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} lulus`);
if (failed.length) process.exit(1);
