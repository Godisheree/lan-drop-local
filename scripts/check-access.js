#!/usr/bin/env node
/**
 * Regression check kunci akses perangkat (pairing).
 *
 * Yang dijaga di sini bukan "apakah fitur ada", tapi apakah gerbangnya masih
 * menutup. Sebelum ini, siapa pun di Wi-Fi yang sama bisa memanggil
 * `/transfer/pending`, menerima kiriman atas nama pemilik, membaca teks
 * masuk, dan membatalkan transfer yang sedang jalan — tanpa kunci apa pun.
 *
 * Cek bersifat PERILAKU (middleware aslinya dipanggil dengan req/res tiruan)
 * plus satu cek statis untuk memastikan tidak ada rute data baru yang lupa
 * dipasangi gerbang.
 *
 * Usage: node scripts/check-access.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// logbus membajak console.* dan mendiamkannya kecuali LANDROP_DEBUG.
process.env.LANDROP_DEBUG = '1';

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settings = require(path.join(ROOT, 'server/settings'));
const access = require(path.join(ROOT, 'server/access'));

let failures = 0;
let passes = 0;

function check(label, fn) {
  try {
    fn();
    passes++;
    console.log(`  OK   ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label}`);
    if (err && err.message) console.log(`       ${err.message}`);
  }
}

/**
 * Req tiruan secukupnya untuk middleware ini.
 * @param {Object} [opts]
 */
function fakeReq(opts = {}) {
  const query = opts.query || {};
  const headers = opts.headers || {};
  const remote = opts.remoteAddress || '192.168.1.50';
  return {
    method: opts.method || 'GET',
    path: opts.path || '/',
    query,
    body: opts.body || {},
    socket: { remoteAddress: remote },
    headers,
    get(name) {
      return headers[String(name).toLowerCase()] || undefined;
    },
  };
}

/** Res tiruan: mencatat apa yang dilakukan middleware. */
function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    redirectedTo: null,
    ended: false,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; res.ended = true; return res; },
    set(name, value) { res.headers[name] = value; return res; },
    redirect(code, location) { res.statusCode = code; res.redirectedTo = location; res.ended = true; return res; },
    send() { res.ended = true; return res; },
  };
  return res;
}

const KEY = settings.getAccessKey();
const WRONG_KEY = KEY.slice(0, -2) + (KEY.endsWith('aa') ? 'bb' : 'aa');

// ── 1. Kunci perangkat ada dan bentuknya benar ────────────────────────────
check('settings menghasilkan kunci 48 hex', () => {
  assert.match(KEY, /^[0-9a-f]{48}$/, `kunci: ${KEY}`);
});

check('deviceId stabil dan aman dipakai di URL/kunci', () => {
  const a = settings.getDeviceId();
  const b = settings.getDeviceId();
  assert.strictEqual(a, b, 'deviceId berubah antar pemanggilan');
  assert.match(a, /^[A-Za-z0-9_-]{4,80}$/);
});

// ── 2. Gerbang API ────────────────────────────────────────────────────────
check('tanpa kunci: API dijawab 401 + pairing:true', () => {
  const res = fakeRes();
  let nextCalled = false;
  access.requireAccess(fakeReq(), res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, 'middleware meloloskan request tanpa kunci');
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body && res.body.pairing, true, 'respons harus menandai pairing');
});

check('kunci salah: tetap 401', () => {
  const res = fakeRes();
  let nextCalled = false;
  access.requireAccess(fakeReq({ headers: { 'x-landrop-key': WRONG_KEY } }), res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

check('kunci benar via header: lolos', () => {
  const res = fakeRes();
  let nextCalled = false;
  access.requireAccess(fakeReq({ headers: { 'x-landrop-key': KEY } }), res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'kunci benar tapi ditolak');
});

check('kunci benar via cookie: lolos', () => {
  const res = fakeRes();
  let nextCalled = false;
  access.requireAccess(
    fakeReq({ headers: { cookie: `${access.COOKIE_NAME}=${KEY}` } }),
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, true, 'cookie hasil pairing ditolak');
});

check('sesi PIN dashboard tetap diterima di jalur data', () => {
  const pin = require(path.join(ROOT, 'server/pin'));
  const session = pin.createSession();
  const res = fakeRes();
  let nextCalled = false;
  access.requireAccess(
    fakeReq({ headers: { cookie: `${pin.COOKIE_NAME}=${session}` } }),
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, true, 'dashboard jadi tidak bisa memantau');
  pin.destroySession(session);
});

// ── 3. Bootstrap pairing ──────────────────────────────────────────────────
check('?k=<benar> → cookie dipasang + dialihkan ke URL bersih', () => {
  const res = fakeRes();
  access.bootstrapPairing(fakeReq({ path: '/', query: { k: KEY } }), res, () => {});
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.redirectedTo, '/', 'kunci harus hilang dari URL');
  assert.match(res.headers['Set-Cookie'] || '', new RegExp(`${access.COOKIE_NAME}=${KEY}`));
});

check('?k=<salah> → 403, tidak ada cookie', () => {
  const res = fakeRes();
  access.bootstrapPairing(fakeReq({ path: '/', query: { k: WRONG_KEY } }), res, () => {});
  assert.strictEqual(res.statusCode, 403);
  assert.ok(!res.headers['Set-Cookie'], 'kunci salah tidak boleh dapat cookie');
});

check('?k= benar ikut dipertahankan bersama query lain', () => {
  const res = fakeRes();
  access.bootstrapPairing(fakeReq({ path: '/', query: { k: KEY, tab: 'devices' } }), res, () => {});
  assert.strictEqual(res.redirectedTo, '/?tab=devices');
});

check('browser loopback dapat cookie otomatis', () => {
  const res = fakeRes();
  access.bootstrapPairing(fakeReq({ path: '/', remoteAddress: '::1' }), res, () => {});
  assert.match(res.headers['Set-Cookie'] || '', new RegExp(access.COOKIE_NAME), 'laptop server sendiri jadi tidak bisa buka UI');
});

check('perangkat LAN lain TIDAK dapat cookie otomatis', () => {
  const res = fakeRes();
  access.bootstrapPairing(fakeReq({ path: '/', remoteAddress: '192.168.1.77' }), res, () => {});
  assert.ok(!res.headers['Set-Cookie'], 'tamu LAN dapat kunci tanpa memindai QR');
});

check('endpoint API tidak pernah dialihkan oleh bootstrap', () => {
  const res = fakeRes();
  let nextCalled = false;
  access.bootstrapPairing(fakeReq({ path: '/devices', query: { k: KEY } }), res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'API tidak boleh di-redirect');
  assert.strictEqual(res.redirectedTo, null);
});

// ── 4. Cek statis: tiap rute data punya gerbang ───────────────────────────
check('setiap rute data di server/index.js dipasangi requireAccess', () => {
  const src = read('server/index.js');
  // Rute yang memang sengaja terbuka: aset statis, manifest, sw, halaman
  // login dashboard, dan pin-info (hint-nya sendiri dibatasi loopback).
  const open = new Set([
    '/dashboard', '/dashboard/pin-info', '/dashboard/login', '/dashboard/logout',
    '/dashboard/pin', '/dashboard.html', '/manifest.webmanifest', '/sw.js',
    '/thumbnail', // gerbangnya access.requireDeviceKey (kunci/PIN, tanpa loopback)
    '/logs',      // PIN dashboard saja
  ]);

  const routes = src.match(/app\.(get|post)\(\s*'([^']+)'/g) || [];
  const unprotected = [];
  for (const route of routes) {
    const m = /app\.(get|post)\(\s*'([^']+)'/.exec(route);
    if (open.has(m[2])) continue;
    const line = src.slice(src.indexOf(route), src.indexOf(route) + 160);
    if (!/requireAccess|requireDeviceKey/.test(line)) unprotected.push(m[2]);
  }
  assert.deepStrictEqual(unprotected, [], `rute tanpa gerbang: ${unprotected.join(', ')}`);
});

check('access.js membandingkan kunci dengan waktu konstan', () => {
  const src = read('server/access.js');
  assert.ok(src.includes('timingSafeEqual'), 'perbandingan kunci biasa bisa dibocorkan lewat timing');
});

check('cookie pairing HttpOnly + SameSite', () => {
  const header = access.accessCookieHeader(KEY);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
});

// ── Ringkasan ─────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? `\n✅ ${passes} pemeriksaan kunci akses lolos.`
    : `\n❌ ${failures} pemeriksaan kunci akses gagal.`
);
process.exitCode = failures > 0 ? 1 : 0;