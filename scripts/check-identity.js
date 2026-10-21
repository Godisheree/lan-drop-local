#!/usr/bin/env node
/**
 * Regression check identitas perangkat.
 *
 * Nama device yang salah bikin user bingung: HP Termux pernah menampilkan
 * "localhost" (hostname default Android) — tiap device jadi sama, dan
 * deviceCard di UI jadi tidak bisa dibedakan.
 *
 * Yang dicek:
 *   1. $DEVICE_NAME jadi prioritas (dan string kosong diabaikan)
 *   2. Fallback ke os.hostname()
 *   3. Fallback Android: hostname "localhost" -> model HP (atau 'Android')
 *   4. Nama dibersihkan: tanpa karakter kontrol, maksimal 40 karakter
 *   5. Single source of truth: index.js & discovery.js sama-sama pakai
 *      getDeviceName() dari platform.js (tidak ada os.hostname() sendiri)
 *
 * Usage: node scripts/check-identity.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const platform = require(path.join(ROOT, 'server', 'platform.js'));

let failures = 0;

function ok(label) {
  console.log(`  OK   ${label}`);
}

function fail(label, detail) {
  failures++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(`       ${detail}`);
}

function expectTrue(condition, label, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}

// ===================== 1. Prioritas env =====================
console.log('\n[1] Nama device dari $DEVICE_NAME');

expectTrue(
  platform.resolveDeviceName({ env: 'HP-Umi', hostname: 'DESKTOP-X' }) === 'HP-Umi',
  '$DEVICE_NAME dipakai duluan'
);

expectTrue(
  platform.resolveDeviceName({ env: '   ', hostname: 'DESKTOP-X' }) === 'DESKTOP-X',
  '$DEVICE_NAME kosong diabaikan (fallback ke hostname)'
);

expectTrue(
  platform.resolveDeviceName({ env: '  HP-Umi  ', hostname: 'DESKTOP-X' }) === 'HP-Umi',
  '$DEVICE_NAME dibersihkan (spasi tepi dibuang)'
);

// ===================== 2. Fallback hostname =====================
console.log('\n[2] Fallback ke hostname mesin');

expectTrue(
  platform.resolveDeviceName({ env: '', hostname: 'DESKTOP-GK51EBL' }) === 'DESKTOP-GK51EBL',
  'hostname dipakai kalau valid'
);

expectTrue(
  platform.resolveDeviceName({ env: '', hostname: 'laptop-saya.local' }) === 'laptop-saya.local',
  'hostname dengan titik tetap dipakai'
);

// ===================== 3. Fallback Android =====================
console.log('\n[3] Fallback Android/Termux');

expectTrue(
  platform.resolveDeviceName({ env: '', hostname: 'localhost', model: 'OPPO A38' }) === 'OPPO A38',
  'hostname "localhost" -> model HP'
);

expectTrue(
  platform.resolveDeviceName({ env: '', hostname: 'localhost', model: '' }) === 'Android',
  'model kosong -> "Android" (bukan "localhost")'
);

expectTrue(
  platform.resolveDeviceName({ env: '', hostname: 'localhost', model: null }) !== 'localhost',
  'nama device tidak pernah "localhost"'
);

// ===================== 4. Sanitasi =====================
console.log('\n[4] Nama device bersih');

const dirty = platform.resolveDeviceName({ env: 'HP\u0000\u0007control', hostname: 'x' });
expectTrue(!/[\u0000-\u001f]/.test(dirty), 'karakter kontrol dibuang', `dapat ${JSON.stringify(dirty)}`);

const long = platform.resolveDeviceName({ env: 'x'.repeat(200), hostname: 'x' });
expectTrue(long.length <= 40, 'nama device dibatasi 40 karakter', `panjang ${long.length}`);

const spaced = platform.resolveDeviceName({ env: 'HP   Redmi   Note', hostname: 'x' });
expectTrue(spaced === 'HP Redmi Note', 'spasi berlebih dirapatkan', `dapat ${JSON.stringify(spaced)}`);

// ===================== 5. Single source of truth =====================
console.log('\n[5] Sumber kebenaran nama device');

const indexSource = read('server/index.js');
const discoverySource = read('server/discovery.js');

expectTrue(
  /require\('\.\/platform'\)/.test(indexSource) && indexSource.includes('getDeviceName'),
  'server/index.js memakai getDeviceName() dari platform.js'
);

expectTrue(
  /require\('\.\/platform'\)/.test(discoverySource) && discoverySource.includes('getDeviceName'),
  'server/discovery.js memakai getDeviceName() dari platform.js'
);

expectTrue(
  !/os\.hostname\(\)/.test(indexSource),
  'server/index.js tidak memanggil os.hostname() sendiri'
);

expectTrue(
  !/os\.hostname\(\)/.test(discoverySource),
  'server/discovery.js tidak memanggil os.hostname() sendiri'
);

// Import 'os' yang sudah tidak dipakai = dead code.
expectTrue(
  !/const os = require\('os'\)/.test(discoverySource),
  'server/discovery.js tidak punya import os yang mati'
);

console.log(
  failures === 0
    ? '\n✅ Identitas perangkat konsisten.'
    : `\n❌ ${failures} pemeriksaan identitas gagal.`
);
process.exitCode = failures > 0 ? 1 : 0;
