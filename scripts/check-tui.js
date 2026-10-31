#!/usr/bin/env node
/**
 * Uji menu launcher (`tui.js`) tanpa terminal sungguhan.
 *
 * Yang diuji bukan tampilannya, tapi dua hal yang gampang rusak diam-diam:
 * 1. Terjemahan byte stdin jadi tombol -- terutama escape sequence panah yang
 *    bisa tiba terpotong antar chunk (`\x1b` dulu, `[B` belakangan). Kalau
 *    salah, panah bawah terasa "kadang jalan kadang tidak".
 * 2. Navigasi menu -- pilihan terakhir harus balik ke atas (lingkar), dan
 *    Enter harus mengembalikan aksi milik baris yang sedang disorot.
 *
 * Usage: node scripts/check-tui.js
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { MENU, parseKeys, reduceKey, render, buildMenu, trayAvailable, canUseRawMode } = require(path.join(ROOT, 'tui.js'));

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

// ── parseKeys ──────────────────────────────────────────────────────────────

check('panah bawah (\\x1b[B) terbaca', () => {
  assert.deepStrictEqual(parseKeys('\x1b[B', true).keys, ['down']);
});

check('panah atas (\\x1b[A) terbaca', () => {
  assert.deepStrictEqual(parseKeys('\x1b[A', true).keys, ['up']);
});

check('panah gaya aplikasi (\\x1bOB) terbaca', () => {
  assert.deepStrictEqual(parseKeys('\x1bOB', true).keys, ['down']);
});

check('escape sequence terpotong tidak jadi tombol asal', () => {
  // Chunk pertama cuma "\x1b[", lanjutannya "B".
  const first = parseKeys('\x1b[', false);
  assert.deepStrictEqual(first.keys, [], 'chunk pertama belum lengkap, jangan hasilkan tombol');
  const second = parseKeys(first.rest + 'B', true);
  assert.deepStrictEqual(second.keys, ['down'], 'gabungan dua chunk harus jadi panah bawah');
});

check('\\x1b sendirian tanpa flush = belum ada tombol (tunggu)', () => {
  const parsed = parseKeys('\x1b', false);
  assert.deepStrictEqual(parsed.keys, []);
  assert.strictEqual(parsed.rest, '\x1b');
});

check('\\x1b sendirian dengan flush = cancel', () => {
  assert.deepStrictEqual(parseKeys('\x1b', true).keys, ['cancel']);
});

check('Enter, Ctrl+C, dan angka terbaca', () => {
  assert.deepStrictEqual(parseKeys('\r').keys, ['enter']);
  assert.deepStrictEqual(parseKeys('\x03').keys, ['cancel']);
  assert.deepStrictEqual(parseKeys('2').keys, ['2']);
});

check('beberapa tombol dalam satu chunk', () => {
  assert.deepStrictEqual(parseKeys('\x1b[B\x1b[B\r').keys, ['down', 'down', 'enter']);
});

check('tombol tak dikenal diabaikan tanpa error', () => {
  assert.deepStrictEqual(parseKeys('\x1b[H', true).keys, []);
  assert.deepStrictEqual(parseKeys('zx', true).keys, []);
});

check('Ctrl+C tetap kebaca walau nempel escape sequence', () => {
  assert.deepStrictEqual(parseKeys('\x1b[Az\x03', true).keys, ['up', 'cancel']);
});

// ── reduceKey ──────────────────────────────────────────────────────────────

const MENU3 = [
  { id: 'terminal', label: 'A', hint: '' },
  { id: 'tray', label: 'B', hint: '' },
  { id: 'quit', label: 'C', hint: '' },
];

check('panah bawah naik satu baris', () => {
  assert.strictEqual(reduceKey({ index: 0, action: null }, 'down', MENU3).index, 1);
});

check('panah bawah di baris terakhir balik ke atas (lingkar)', () => {
  assert.strictEqual(reduceKey({ index: 2, action: null }, 'down', MENU3).index, 0);
});

check('panah atas di baris pertama lompat ke bawah (lingkar)', () => {
  assert.strictEqual(reduceKey({ index: 0, action: null }, 'up', MENU3).index, 2);
});

check('Enter mengembalikan aksi baris yang disorot', () => {
  assert.strictEqual(reduceKey({ index: 1, action: null }, 'enter', MENU3).action, 'tray');
});

check('cancel = keluar, apa pun posisinya', () => {
  assert.strictEqual(reduceKey({ index: 2, action: null }, 'cancel', MENU3).action, 'quit');
});

check('tombol angka memilih langsung', () => {
  const st = reduceKey({ index: 0, action: null }, '2', MENU3);
  assert.strictEqual(st.index, 1);
  assert.strictEqual(st.action, 'tray');
});

check('angka di luar jumlah baris diabaikan', () => {
  const st = reduceKey({ index: 1, action: null }, '9', MENU3);
  assert.deepStrictEqual(st, { index: 1, action: null });
});

check('tombol asing tidak mengubah state', () => {
  const st = { index: 1, action: null };
  assert.deepStrictEqual(reduceKey(st, 'x', MENU3), st);
});

// ── menu & render ──────────────────────────────────────────────────────────

check('baris tray ada saat Electron tersedia', () => {
  const ids = buildMenu().map((m) => m.id);
  if (trayAvailable()) assert.ok(ids.includes('tray'), 'Electron ada tapi baris tray hilang');
  else assert.ok(!ids.includes('tray'), 'Electron tidak ada tapi baris tray masih muncul');
});

check('selalu ada aksi terminal & keluar', () => {
  const ids = buildMenu().map((m) => m.id);
  assert.ok(ids.includes('terminal') && ids.includes('quit'));
});

check('setiap baris menu punya id unik', () => {
  const ids = MENU.map((m) => m.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

check('render menandai baris terpilih dengan panah', () => {
  const text = render({ index: 1 }, MENU3);
  const marked = text.split('\n').filter((l) => l.includes('\u276F'));
  assert.strictEqual(marked.length, 1, 'harus tepat satu baris bertanda');
  assert.ok(marked[0].includes('B'), 'baris bertanda harus baris yang disorot');
});

check('render tidak menumpuk baris kosong berlebih', () => {
  const lines = render({ index: 0 }, MENU3).split('\n');
  assert.ok(lines.length <= 12, `terlalu banyak baris: ${lines.length}`);
});

check('canUseRawMode() false saat tidak ada tty (skrip ini jalan lewat pipe)', () => {
  assert.strictEqual(canUseRawMode(), false, 'kalau ini true, skripnya jalan di terminal sungguhan — cek manual');
});

// ── hasil ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} lulus`);
if (failed.length) process.exit(1);
