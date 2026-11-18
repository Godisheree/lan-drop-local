#!/usr/bin/env node
// Perbandingan perilaku: server Node (referensi) vs inti Rust.
//
// Tujuan: setiap fase port punya angka, bukan kesan. Skrip ini menyalakan dua
// server berdampingan lalu membandingkan respons untuk endpoint yang sama:
// status code, tipe konten, header penting, dan bentuk JSON (kunci wajib sama;
// nilai yang memang beda antar implementasi seperti pid/uptime/node dikecualikan).
//
// Hasil per endpoint:
//   SAMA       perilaku identik
//   BEDA       dua-duanya menjawab, tapi tidak sama  → exit 1
//   BELUM      Rust belum punya endpoint itu         → dihitung, bukan gagal
//
// Pemakaian:
//   node scripts/check-parity.js
//   node scripts/check-parity.js --bin rust/target/release/lan-drop-core

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argBin = process.argv.indexOf('--bin');
const RUST_BIN = argBin !== -1
  ? path.resolve(process.argv[argBin + 1])
  : path.join(ROOT, 'rust', 'target', 'release', 'lan-drop-core');

let pass = 0;
let fail = 0;
let pending = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  SAMA   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  BEDA   ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function belum(name) {
  pending++;
  console.log(`  BELUM  ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '0.0.0.0');
    };
    tryPort(start);
  });
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

async function waitFor(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return true;
    } catch (_) {
      await sleep(150);
    }
  }
  return false;
}

function startNode(httpPort, transferPort, discoveryPort, dataDir) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(httpPort),
      TRANSFER_PORT: String(transferPort),
      DISCOVERY_PORT: String(discoveryPort),
      LANDROP_DATA_DIR: dataDir,
      LANDROP_SAVE_DIR: path.join(dataDir, 'save'),
      LANDROP_NO_BROWSER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

function startRust(httpPort, transferPort, discoveryPort, dataDir) {
  const child = spawn(RUST_BIN, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(httpPort),
      TRANSFER_PORT: String(transferPort),
      DISCOVERY_PORT: String(discoveryPort),
      LANDROP_DATA_DIR: dataDir,
      LANDROP_SAVE_DIR: path.join(dataDir, 'save'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

async function get(base, pathname, headers = {}) {
  const res = await fetch(base + pathname, { headers, redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  let body = null;
  const text = await res.text();
  if (type.includes('json')) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = null;
    }
  }
  return { status: res.status, type, text, body, headers: res.headers };
}

/** Bandingkan dua respons; `keys` = daftar kunci JSON yang wajib sama. */
function sameResponse(a, b, keys) {
  if (a.status !== b.status) return `status ${a.status} vs ${b.status}`;
  if (a.type.split(';')[0] !== b.type.split(';')[0]) return `tipe ${a.type} vs ${b.type}`;
  if (keys) {
    for (const key of keys) {
      const av = JSON.stringify(a.body && a.body[key]);
      const bv = JSON.stringify(b.body && b.body[key]);
      if (av !== bv) return `${key}: ${av} vs ${bv}`;
    }
    return null;
  }
  if (a.text.length !== b.text.length) return `panjang ${a.text.length} vs ${b.text.length}`;
  return null;
}

async function main() {
  if (!fs.existsSync(RUST_BIN)) {
    console.error(`Binary Rust tidak ada: ${RUST_BIN}`);
    console.error('Bangun dulu: cd rust && cargo build --release');
    process.exit(2);
  }

  const nodePort = await freePort(3300);
  const nodeTransfer = await freePort(3310);
  const nodeDiscovery = await freePort(3400);
  const rustPort = await freePort(3350);
  const rustTransfer = await freePort(3360);
  const rustDiscovery = await freePort(3450);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-parity-'));
  const ip = lanAddress();

  const node = startNode(nodePort, nodeTransfer, nodeDiscovery, dataDir);
  if (!await waitFor(nodePort)) {
    node.kill('SIGKILL');
    console.error('Server Node gagal start');
    process.exit(2);
  }

  // Kunci dibuat server Node sekali; Rust membaca berkas yang sama (bukan
  // membuat kunci sendiri — dua implementasi dengan kunci berbeda tidak akan
  // pernah saling percaya).
  const settingsPath = path.join(dataDir, 'settings.json');
  for (let i = 0; i < 20 && !fs.existsSync(settingsPath); i++) await sleep(100);
  const key = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).accessKey;

  const rust = startRust(rustPort, rustTransfer, rustDiscovery, dataDir);
  if (!await waitFor(rustPort)) {
    node.kill('SIGKILL');
    rust.kill('SIGKILL');
    console.error('Server Rust gagal start');
    process.exit(2);
  }

  const N = `http://${ip}:${nodePort}`;
  const R = `http://${ip}:${rustPort}`;
  const keyed = { 'X-Landrop-Key': key };

  try {
    console.log(`\nNode: ${N}\nRust: ${R}\n`);

    console.log('Statis & halaman');
    {
      const a = await get(N, '/');
      const b = await get(R, '/');
      check('GET / byte-identik', sameResponse(a, b) === null, sameResponse(a, b));
    }
    for (const asset of ['/css/base.css', '/js/main.js', '/js/core/api.js']) {
      const a = await get(N, asset);
      const b = await get(R, asset);
      check(`GET ${asset}`, sameResponse(a, b) === null, sameResponse(a, b));
    }
    {
      const a = await get(N, '/sw.js');
      const b = await get(R, '/sw.js');
      const detail = sameResponse(a, b)
        || (a.headers.get('cache-control') !== b.headers.get('cache-control')
          ? `cache-control ${a.headers.get('cache-control')} vs ${b.headers.get('cache-control')}`
          : null)
        || (a.headers.get('service-worker-allowed') !== b.headers.get('service-worker-allowed')
          ? 'service-worker-allowed hilang' : null);
      check('GET /sw.js + header PWA', detail === null, detail);
    }
    {
      const a = await get(N, '/manifest.webmanifest');
      const b = await get(R, '/manifest.webmanifest');
      check('GET /manifest.webmanifest tipe konten',
        sameResponse(a, b) === null, sameResponse(a, b));
    }
    {
      const a = await get(N, '/dashboard');
      const b = await get(R, '/dashboard');
      check('GET /dashboard (belum login) = halaman login',
        sameResponse(a, b) === null, sameResponse(a, b));
    }
    {
      const a = await get(N, '/dashboard.html');
      const b = await get(R, '/dashboard.html');
      check('GET /dashboard.html dialihkan ke /dashboard',
        a.status === b.status && a.headers.get('location') === b.headers.get('location'),
        `${a.status}/${a.headers.get('location')} vs ${b.status}/${b.headers.get('location')}`);
    }

    console.log('\nGerbang akses');
    {
      const a = await get(N, '/status');
      const b = await get(R, '/status');
      check('/status tanpa kunci → 401 + pairing:true',
        a.status === 401 && b.status === 401
        && a.body && a.body.pairing === true && b.body && b.body.pairing === true,
        `${a.status}/${JSON.stringify(a.body)} vs ${b.status}/${JSON.stringify(b.body)}`);
    }
    {
      const a = await get(N, '/status', keyed);
      const b = await get(R, '/status', keyed);
      // port/transferPort sengaja tidak dibandingkan: dua server ini memang
      // dijalankan di port berbeda. Yang harus sama adalah field yang berasal
      // dari data, bukan dari env.
      const detail = sameResponse(a, b,
        ['deviceName', 'version', 'saveDir', 'dataDir']);
      if (!detail) {
        const portsOk = a.body.port === nodePort && b.body.port === rustPort
          && a.body.transferPort === nodeTransfer && b.body.transferPort === rustTransfer
          && a.body.discoveryPort === nodeDiscovery && b.body.discoveryPort === rustDiscovery;
        check('/status dengan kunci: port dilaporkan sesuai env', portsOk,
          `${a.body.port}/${a.body.transferPort} vs ${b.body.port}/${b.body.transferPort}`);
      }
      check('/status dengan kunci: field inti sama', detail === null, detail);
    }
    {
      const a = await get(N, '/?k=' + key);
      const b = await get(R, '/?k=' + key);
      const detail = a.status === b.status
        && a.headers.get('location') === b.headers.get('location')
        && (a.headers.get('set-cookie') ? 'cookie' : '') === (b.headers.get('set-cookie') ? 'cookie' : '')
        ? null
        : `${a.status}/${a.headers.get('location')} vs ${b.status}/${b.headers.get('location')}`;
      check('/?k= → 302 ke alamat bersih + cookie', detail === null, detail);
    }
    {
      const a = await get(N, '/?k=salah');
      const b = await get(R, '/?k=salah');
      check('kunci salah → 403 pairing', a.status === b.status && a.status === 403,
        `${a.status} vs ${b.status}`);
    }
    {
      const a = await get(N, '/status', { 'X-Landrop-Key': 'deadbeef'.repeat(6) });
      const b = await get(R, '/status', { 'X-Landrop-Key': 'deadbeef'.repeat(6) });
      check('kunci salah di header → 401', a.status === 401 && b.status === 401,
        `${a.status} vs ${b.status}`);
    }

    console.log('\nRute data');
    // Endpoint yang Rust belum punya: dihitung sebagai pekerjaan, bukan gagal,
    // supaya skrip ini bisa dipakai sebagai pengukur kemajuan per fase.
    const dataRoutes = [
      ['GET /me', '/me', 'keyed'],
      ['GET /devices', '/devices', 'keyed'],
      ['GET /discovery/status', '/discovery/status', 'keyed'],
      ['GET /transfer/pending', '/transfer/pending', 'keyed'],
      ['GET /transfer/active', '/transfer/active', 'keyed'],
      ['GET /transfer/text', '/transfer/text', 'keyed'],
      ['GET /history', '/history', 'keyed'],
      ['GET /settings/auto-approve', '/settings/auto-approve', 'keyed'],
      ['GET /system/disk', '/system/disk', 'keyed'],
      ['GET /logs', '/logs', 'keyed'],
    ];
    for (const [label, route] of dataRoutes) {
      const b = await get(R, route, keyed);
      if (b.status === 404) {
        belum(label);
        continue;
      }
      const a = await get(N, route, keyed);
      const detail = sameResponse(a, b);
      check(label, detail === null, detail);
    }

    console.log(`\nSAMA ${pass} · BEDA ${fail} · BELUM ${pending}`);
    if (fail) {
      console.log('\nSelisih:');
      for (const item of failures) console.log(`  - ${item}`);
      console.log('\nGAGAL');
    } else {
      console.log('\nSemua endpoint yang sudah ada di Rust berperilaku sama dengan Node.');
    }
  } finally {
    node.kill('SIGKILL');
    rust.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('check-parity gagal:', err.message);
  process.exit(2);
});
