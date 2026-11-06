#!/usr/bin/env node
/**
 * Regression check: ikon tray versi npm.
 *
 * Tiga hal yang gampang rusak tanpa kelihatan:
 * 1. `icon.ico` hilang dari paket, atau strukturnya salah → Windows menolak
 *    NotifyIcon, dan user cuma lihat "tidak ada ikon" tanpa pesan apa pun.
 * 2. `server/tray.js` menarik Electron lagi → `npm i -g` jadi 240 MB.
 * 3. Launcher tetap memanggil Electron untuk mode tray.
 *
 * Usage: node scripts/check-tray.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICON_ICO = path.join(ROOT, 'public', 'icons', 'icon.ico');
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

// ── icon.ico ───────────────────────────────────────────────────────────────

check('icon.ico ada', () => {
  assert.ok(fs.existsSync(ICON_ICO), 'jalankan: npm run icons');
});

check('icon.ico punya header ICONDIR yang benar', () => {
  const ico = fs.readFileSync(ICON_ICO);
  assert.strictEqual(ico.readUInt16LE(0), 0, 'reserved harus 0');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'type harus 1 (icon)');
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 2, `harus multi-ukuran untuk tray + scaling, dapat ${count}`);
});

check('setiap frame icon.ico menunjuk ke data yang valid', () => {
  const ico = fs.readFileSync(ICON_ICO);
  const count = ico.readUInt16LE(4);

  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    const size = ico.readUInt8(base) || 256; // 0 berarti 256
    const length = ico.readUInt32LE(base + 8);
    const offset = ico.readUInt32LE(base + 12);

    assert.ok(offset + length <= ico.length, `frame ${i} keluar dari batas file`);
    assert.strictEqual(ico.readUInt32LE(offset), 40, `frame ${i} bukan BITMAPINFOHEADER`);
    assert.strictEqual(ico.readInt32LE(offset + 4), size, `frame ${i} lebar tidak cocok`);
  }
});

check('ukuran tray kecil tersedia (16 & 32 px)', () => {
  const ico = fs.readFileSync(ICON_ICO);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(ico.readUInt8(6 + i * 16) || 256);
  assert.ok(sizes.includes(16) && sizes.includes(32), `dapat: ${sizes.join(', ')}`);
});

check('icon.ico ikut ke dalam paket npm', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  // Folder `public/` di-whitelist; icon.ico ada di dalamnya. Kalau suatu saat
  // whitelist-nya dipersempit, ini yang menangkapnya.
  assert.ok(pkg.files.includes('public/'), 'public/ harus ada di files');
  assert.ok(pkg.files.includes('server/'), 'server/ harus ada di files');
});

// ── Tray tanpa Electron ────────────────────────────────────────────────────

check('server/tray.js tidak menarik Electron', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'tray.js'), 'utf8');
  assert.ok(!/require\(['"]electron['"]\)/.test(src), 'tray.js masih require("electron")');
});

check('tui.js tidak menarik Electron untuk mode tray', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tui.js'), 'utf8');
  assert.ok(!/require\(['"]electron['"]\)/.test(src), 'tui.js masih require("electron")');
});

check('tui.js spawn server/index.js --tray', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tui.js'), 'utf8');
  assert.ok(/index\.js['"]\),\s*['"]--tray['"]/.test(src), 'runTray() bukan spawn node --tray');
});

check('Electron hanya devDependency', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  assert.ok(pkg.devDependencies && pkg.devDependencies.electron, 'electron harus tetap devDependency');
  assert.ok(!pkg.dependencies.electron, 'electron tidak boleh jadi dependency runtime');
});

check('scripts tray-win.ps1 ada', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'server', 'tray-win.ps1')));
});

check('systray2 tidak jadi dependency paket', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!all.systray2, 'systray2 harus di-install saat runtime, bukan dependency');
});

// ── Satu onListening, bukan N ──────────────────────────────────────────────
// Bug yang pernah lolos: `server.listen(port, host, cb)` mendaftarkan cb sebagai
// `once('listening')` yang TIDAK dilepas kalau listen gagal. Kalau 3000..3008
// terpakai, sembilan callback menumpuk dan semuanya menyala bersamaan → sembilan
// ikon tray, sembilan socket discovery, sembilan TCP server. Yang kelihatan di
// user: "sekali jalan lan-drop, kok prosesnya banyak banget".

check('onListening didaftarkan di luar retry loop', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.ok(
    /server\.once\(\s*['"]listening['"]\s*,\s*onListening\s*\)/.test(src),
    'onListening harus dipasang sekali lewat server.once("listening", ...)'
  );
  assert.ok(
    !/server\.listen\(\s*port\s*,\s*['"]0\.0\.0\.0['"]\s*,/.test(src),
    'server.listen() tidak boleh menerima callback — callback-nya bocor antar retry'
  );
});

check('listenHttp melepas handler error sebelum retry', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const body = src.slice(src.indexOf('function listenHttp'), src.indexOf('server.once(\'listening\''));
  assert.ok(/removeListener\(\s*['"]error['"]\s*,\s*onError\s*\)/.test(body), 'handler error tidak dilepas');
});

check('listenTransfer melepas handler sebelum retry', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'transfer.js'), 'utf8');
  const start = src.indexOf('function listenTransfer');
  const body = src.slice(start, src.indexOf('function startTransferServer'));
  assert.ok(/removeListener\(\s*['"]error['"]\s*,\s*onError\s*\)/.test(body), 'handler error tidak dilepas');
  assert.ok(/removeListener\(\s*['"]listening['"]\s*,\s*onListening\s*\)/.test(body), 'handler listening tidak dilepas');
});

check('startTransferServer idempoten', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'transfer.js'), 'utf8');
  const start = src.indexOf('function startTransferServer');
  const body = src.slice(start, start + 400);
  assert.ok(/tcpServer\.listening\s*\)\s*return/.test(body), 'dipanggil dua kali akan membuat tcpServer baru dan membocorkan yang lama');
});

// ── hasil ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} lulus`);
if (failed.length) process.exit(1);
