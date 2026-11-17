#!/usr/bin/env node
/**
 * Regression check: ketahanan inti Rust terhadap input jahat dan keadaan
 * yang tidak rapi.
 *
 * `check-rust-core.js` membuktikan jalur normal berjalan. Skrip ini menguji
 * yang sebaliknya: header palsu, frame raksasa, nama file yang mencoba keluar
 * folder, puluhan koneksi menganggur, transfer bersamaan, restart di tengah
 * jalan, dan settings.json yang rusak. Yang dicari bukan fitur, tapi cara
 * membuat server berhenti melayani atau menulis ke tempat yang salah.
 *
 * Usage: node scripts/check-rust-hardening.js
 *   Binari dibangun dulu: (cd rust && cargo build --release)
 */
const fs = require('fs');
const dgram = require('dgram');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'rust', 'target', 'release', 'lan-drop-core');
const TMP = path.join(os.tmpdir(), `landrop-hard-${crypto.randomBytes(4).toString('hex')}`);

let passes = 0;
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    passes++;
    console.log(`  OK   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────────`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  return Buffer.concat([head, payload]);
}

/** Permintaan HTTP dengan header yang bisa dipalsukan (Host, Origin). */
function raw({ port, method = 'GET', path: p = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, text: String(err.message) }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, headers: {}, text: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

function startInstance(name, dir, ports, extraEnv = {}) {
  fs.mkdirSync(path.join(dir, 'save'), { recursive: true });
  const proc = spawn(BIN, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      LANDROP_DATA_DIR: dir,
      LANDROP_SAVE_DIR: path.join(dir, 'save'),
      PORT: String(ports.http),
      TRANSFER_PORT: String(ports.tcp),
      DISCOVERY_PORT: String(ports.disc),
      DEVICE_NAME: name,
      LANDROP_ALLOW_SELF_TARGET: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const grab = (d) => { log.push(String(d)); if (log.length > 400) log.shift(); };
  proc.stdout.on('data', grab);
  proc.stderr.on('data', grab);
  return { proc, log };
}

async function api(port, route, { body, method, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json', ...(headers || {}) } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch (_) {}
  return { status: res.status, body: parsed, headers: res.headers };
}

async function waitReady(port, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.status === 200) return true;
    } catch (_) {}
    await sleep(100);
  }
  return false;
}

async function pendingId(port, fileName, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const { body } = await api(port, '/transfer/pending');
    const hit = (body || []).find((x) => x.fileName === fileName);
    if (hit) return hit.requestId;
    await sleep(100);
  }
  return null;
}

async function waitStatus(port, requestId, wanted, tries = 150) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const { body } = await api(port, `/transfer/status/${requestId}`);
    if (body && body.status) {
      last = body.status;
      if (wanted.includes(body.status)) return body.status;
    }
    await sleep(100);
  }
  return last;
}

function connect(port) {
  return new Promise((resolve) => {
    const frames = [];
    let buf = Buffer.alloc(0);
    const state = { closed: false };
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      resolve({ socket, frames, get closed() { return state.closed; } });
    });
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        try { frames.push(JSON.parse(buf.slice(4, 4 + len).toString())); } catch (_) {}
        buf = buf.slice(4 + len);
      }
    });
    socket.on('close', () => { state.closed = true; });
    socket.on('error', () => { state.closed = true; });
    setTimeout(() => resolve({ socket, frames, get closed() { return state.closed; } }), 2000);
  });
}

async function upload(port, fileName, payload) {
  const boundary = `----hard${crypto.randomBytes(4).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n', 'utf-8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const res = await fetch(`http://127.0.0.1:${port}/transfer/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, payload, tail]),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && body.files ? body.files[0] : null;
}

function settingsKey(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).accessKey || null;
  } catch (_) { return null; }
}

function rssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = status.match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : -1;
  } catch (_) { return -1; }
}

async function main() {
  if (!fs.existsSync(BIN)) {
    console.log(`Binari Rust belum ada: ${BIN}`);
    console.log('Bangun dulu: (cd rust && cargo build --release)');
    process.exitCode = 1;
    return;
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  const aDir = path.join(TMP, 'a');
  const bDir = path.join(TMP, 'b');
  const cDir = path.join(TMP, 'c');
  for (const d of [aDir, bDir, cDir]) fs.mkdirSync(d, { recursive: true });

  // Port discovery dipisah: yang diuji di sini listener A saja, dan dua
  // socket di port yang sama membuat kiriman unicast bisa jatuh ke B —
  // hasil tes jadi bergantung kernel, bukan perilaku server.
  const aPorts = { http: await findFreePort(), tcp: await findFreePort(), disc: await findFreePort() };
  const bPorts = { http: await findFreePort(), tcp: await findFreePort(), disc: await findFreePort() };
  const cPorts = { http: await findFreePort(), tcp: await findFreePort(), disc: await findFreePort() };

  let a = startInstance('MesinA', aDir, aPorts);
  let b = startInstance('MesinB', bDir, bPorts);
  const c = startInstance('MesinC', cDir, cPorts, { LANDROP_PEERS: '' });

  const cleanup = () => {
    for (const inst of [a, b, c]) { try { inst.proc.kill('SIGKILL'); } catch (_) {} }
  };
  process.on('exit', cleanup);

  try {
    const ready = await Promise.all([waitReady(aPorts.http), waitReady(bPorts.http), waitReady(cPorts.http)]);
    check('tiga instance hidup', ready.every(Boolean), ready.join(','));
    if (!ready.every(Boolean)) return;

    // ── 1. Header & gerbang HTTP ───────────────────────────────────────────
    section('Header & gerbang HTTP');

    const evilHost = await raw({ port: aPorts.http, path: '/status', headers: { host: 'evil.example.com' } });
    check('Host asing ditolak 403 (anti DNS rebinding)', evilHost.status === 403, `${evilHost.status}`);

    const okHost = await raw({ port: aPorts.http, path: '/status', headers: { host: `localhost:${aPorts.http}` } });
    check('Host localhost diterima', okHost.status === 200, `${okHost.status}`);

    const crossOrigin = await raw({
      port: aPorts.http, method: 'POST', path: '/transfer/request',
      headers: {
        'content-type': 'application/json',
        host: `localhost:${aPorts.http}`,
        origin: 'http://evil.example.com',
      },
      body: JSON.stringify({ targetIp: '127.0.0.1', targetPort: bPorts.tcp, fileName: 'x', fileSize: 1 }),
    });
    check('POST lintas origin ditolak 403', crossOrigin.status === 403, `${crossOrigin.status}`);

    const sameOrigin = await raw({
      port: aPorts.http, method: 'POST', path: '/transfer/request',
      headers: {
        'content-type': 'application/json',
        host: `localhost:${aPorts.http}`,
        origin: `http://localhost:${aPorts.http}`,
      },
      body: JSON.stringify({ targetIp: '127.0.0.1', targetPort: bPorts.tcp, fileName: 'origin-ok.bin', fileSize: 10 }),
    });
    check('POST origin sama diterima', sameOrigin.status === 200, `${sameOrigin.status}`);

    const missing = await api(aPorts.http, '/tidak-ada-rute-ini');
    check('rute tak dikenal → 404 (bukan crash)', missing.status === 404, `${missing.status}`);

    const wrongMethod = await raw({ port: aPorts.http, method: 'DELETE', path: '/status', headers: { host: `localhost:${aPorts.http}` } });
    check('metode tak didukung ditolak 405', wrongMethod.status === 405, `${wrongMethod.status}`);

    const headers = await raw({ port: aPorts.http, path: '/', headers: { host: `localhost:${aPorts.http}` } });
    check('header keamanan terpasang',
      headers.headers['x-content-type-options'] === 'nosniff'
      && /frame-ancestors/.test(headers.headers['content-security-policy'] || ''),
      JSON.stringify({ nosniff: headers.headers['x-content-type-options'] }));

    // ── 2. Statis & path traversal ─────────────────────────────────────────
    section('Berkas statis & path traversal');

    for (const attempt of ['/..%2fserver%2findex.js', '/%2e%2e%2fpackage.json', '/../server/index.js']) {
      const res = await raw({ port: aPorts.http, path: attempt, headers: { host: `localhost:${aPorts.http}` } });
      const leaked = /require\(|"name":\s*"lan-drop|app\.get\(/.test(res.text);
      check(`traversal ${attempt} tidak membocorkan berkas server`, !leaked, `status=${res.status} ${res.text.length}B`);
    }

    const asset = await raw({ port: aPorts.http, path: '/js/features/devices.js', headers: { host: `localhost:${aPorts.http}` } });
    check('aset frontend normal tetap dilayani', asset.status === 200 && /setupFileInputs/.test(asset.text),
      `status=${asset.status} ${asset.text.length}B`);

    const dash = await raw({ port: aPorts.http, path: '/dashboard', headers: { host: `localhost:${aPorts.http}` } });
    check('/dashboard tanpa sesi tidak membocorkan riwayat',
      !/transfer-saved|savedTo/.test(dash.text), `status=${dash.status} ${dash.text.length}B`);

    // ── 3. Protokol TCP: masukan cacat ─────────────────────────────────────
    section('Protokol TCP — masukan cacat');

    const huge = await connect(aPorts.tcp);
    const hugeHead = Buffer.alloc(4);
    hugeHead.writeUInt32BE(8 * 1024 * 1024); // 8 MB, batas 64 KiB
    huge.socket.write(Buffer.concat([hugeHead, Buffer.alloc(64, 0x41)]));
    await sleep(500);
    check('frame melebihi 64 KiB diputus, bukan dialokasikan', huge.closed || huge.frames.length === 0,
      huge.closed ? 'koneksi ditutup' : 'tanpa balasan');

    const garbage = await connect(aPorts.tcp);
    const gHead = Buffer.alloc(4);
    const gBody = Buffer.from('bukan json sama sekali', 'utf-8');
    gHead.writeUInt32BE(gBody.length);
    garbage.socket.write(Buffer.concat([gHead, gBody]));
    await sleep(400);
    check('frame bukan JSON diputus', garbage.closed, garbage.closed ? 'ditutup' : 'masih terbuka');

    const wrongType = await connect(aPorts.tcp);
    wrongType.socket.write(frame({ type: 'halo', fileName: 'x' }));
    await sleep(400);
    check('frame pertama bukan transfer-request ditolak', wrongType.closed || wrongType.frames.length === 0,
      wrongType.closed ? 'ditutup' : 'tanpa balasan');

    const zero = await connect(aPorts.tcp);
    zero.socket.write(Buffer.alloc(4)); // panjang 0
    await sleep(400);
    check('frame panjang 0 ditolak tanpa crash', zero.closed || zero.frames.length === 0,
      zero.closed ? 'ditutup' : 'tanpa balasan');

    const aliveAfterJunk = await api(aPorts.http, '/status');
    check('server tetap melayani setelah masukan cacat', aliveAfterJunk.status === 200, `${aliveAfterJunk.status}`);

    // ── 4. Banjir koneksi menganggur ───────────────────────────────────────
    section('Beban — koneksi menganggur');

    const idle = [];
    for (let i = 0; i < 80; i++) {
      const sock = net.createConnection({ host: '127.0.0.1', port: aPorts.tcp });
      sock.on('error', () => {});
      idle.push(sock);
    }
    await sleep(800);
    const stillServing = await api(aPorts.http, '/status');
    check('80 koneksi menganggur tidak membuat HTTP mati', stillServing.status === 200, `${stillServing.status}`);
    const rssFlood = rssMb(a.proc.pid);
    check('RSS tetap wajar saat dibanjiri', rssFlood > 0 && rssFlood < 120, `${rssFlood} MB`);
    for (const sock of idle) { try { sock.destroy(); } catch (_) {} }
    await sleep(500);

    // Koneksi baru diuji ke server penerima (B): di situlah antrean pending
    // yang mau dibaca, jadi hasilnya bisa dipastikan.
    const afterFlood = await connect(bPorts.tcp);
    afterFlood.socket.write(frame({
      type: 'transfer-request', fileName: 'setelah-banjir.bin', fileSize: 4,
      senderName: 'MesinA', senderId: 'cccccccccccc', resumeId: 'flood-1', kind: 'file',
    }));
    const floodPid = await pendingId(bPorts.http, 'setelah-banjir.bin', 20);
    check('koneksi sah masih diterima setelah banjir', !!floodPid, `${floodPid}`);
    await api(bPorts.http, '/transfer/respond', { body: { requestId: floodPid, accept: false, message: 'uji' } });
    afterFlood.socket.destroy();

    // ── 5. Semantik transfer ───────────────────────────────────────────────
    section('Semantik transfer');

    // 5a. Penolakan dengan alasan sampai ke pengirim.
    const rejectConn = await connect(bPorts.tcp);
    rejectConn.socket.write(frame({
      type: 'transfer-request', fileName: 'ditolak.bin', fileSize: 1000,
      senderName: 'MesinA', senderId: 'dddddddddddd', resumeId: 'reject-1', kind: 'file',
    }));
    const rejectId = await pendingId(bPorts.http, 'ditolak.bin');
    await api(bPorts.http, '/transfer/respond', {
      body: { requestId: rejectId, accept: false, message: 'Ruang disk penerima tidak cukup' },
    });
    for (let i = 0; i < 40 && !rejectConn.frames.length; i++) await sleep(50);
    const rejectFrame = rejectConn.frames.find((f) => f.type === 'transfer-response');
    check('penolakan membawa alasan ke pengirim',
      rejectFrame && rejectFrame.accepted === false && /tidak cukup/.test(rejectFrame.message || ''),
      JSON.stringify(rejectFrame || {}));
    rejectConn.socket.destroy();

    // 5b. Nama file menjalar keluar folder.
    const trav = await connect(bPorts.tcp);
    trav.socket.write(frame({
      type: 'transfer-request', fileName: '../../keluar.txt', fileSize: 2048,
      senderName: 'Penyusup', senderId: 'eeeeeeeeeeee', resumeId: 'trav-1', kind: 'file',
    }));
    const travId = await pendingId(bPorts.http, '../../keluar.txt');
    check('nama file traversal tetap masuk antrean sebagai berkas biasa', !!travId);
    if (travId) {
      await api(bPorts.http, '/transfer/respond', { body: { requestId: travId, accept: true } });
      for (let i = 0; i < 40 && !trav.frames.length; i++) await sleep(50);
      trav.socket.write(frame({ type: 'file-start', fileName: '../../keluar.txt', fileSize: 2048 }));
      trav.socket.write(Buffer.alloc(2048, 9));
      await sleep(700);
      const escaped = ['keluar.txt', path.join(TMP, 'keluar.txt'), path.join(bDir, 'keluar.txt')]
        .filter((p) => fs.existsSync(p));
      const saved = fs.existsSync(path.join(bDir, 'save', 'keluar.txt'));
      check('berkas traversal tidak keluar folder simpan', escaped.length === 0, escaped.join(','));
      check('berkas traversal disimpan dengan nama aman di save', saved,
        saved ? 'save/keluar.txt' : fs.readdirSync(path.join(bDir, 'save')).join(','));
      trav.socket.destroy();
    }

    // 5c. Ukuran yang diklaim tidak cocok dengan isi.
    const liar = await connect(bPorts.tcp);
    liar.socket.write(frame({
      type: 'transfer-request', fileName: 'bohong.bin', fileSize: 1024,
      senderName: 'Pembohong', senderId: 'ffffffffffff', resumeId: 'lie-1', kind: 'file',
    }));
    const liarId = await pendingId(bPorts.http, 'bohong.bin');
    await api(bPorts.http, '/transfer/respond', { body: { requestId: liarId, accept: true } });
    for (let i = 0; i < 40 && !liar.frames.length; i++) await sleep(50);
    liar.socket.write(frame({ type: 'file-start', fileName: 'bohong.bin', fileSize: 4096 }));
    liar.socket.write(Buffer.alloc(4096, 3));
    await sleep(600);
    const liarPath = path.join(bDir, 'save', 'bohong.bin');
    const liarSize = fs.existsSync(liarPath) ? fs.statSync(liarPath).size : -1;
    // Ukuran yang mengikat adalah `file-start` (Node juga begitu, dan di situ
    // penerima memeriksa ulang ruang disk). Yang penting: berkasnya utuh
    // sesuai ukuran itu, bukan terpotong di angka dari frame request.
    check('ukuran file-start yang berlaku, berkas utuh', liarSize === 4096, `${liarSize} byte`);
    liar.socket.destroy();

    // file-start dengan ukuran 0 / tak masuk akal harus ditolak, bukan
    // membuat berkas kosong atau menggantung.
    const kosong = await connect(bPorts.tcp);
    kosong.socket.write(frame({
      type: 'transfer-request', fileName: 'kosong.bin', fileSize: 0,
      senderName: 'MesinA', senderId: 'abababababab', resumeId: 'zero-1', kind: 'file',
    }));
    const kosongId = await pendingId(bPorts.http, 'kosong.bin');
    if (kosongId) await api(bPorts.http, '/transfer/respond', { body: { requestId: kosongId, accept: true } });
    for (let i = 0; i < 40 && !kosong.frames.length; i++) await sleep(50);
    kosong.socket.write(frame({ type: 'file-start', fileName: 'kosong.bin', fileSize: 0 }));
    await sleep(500);
    check('file-start berukuran 0 ditolak', !fs.existsSync(path.join(bDir, 'save', 'kosong.bin')),
      fs.existsSync(path.join(bDir, 'save', 'kosong.bin')) ? 'berkas kosong tersimpan' : 'tidak tersimpan');
    kosong.socket.destroy();

    // 5d. Dua pengirim, nama sama, isi beda.
    const mkTwin = async (sender, marker, size) => {
      const before = new Set(((await api(bPorts.http, '/transfer/pending')).body || []).map((x) => x.requestId));
      const conn = await connect(bPorts.tcp);
      conn.socket.write(frame({
        type: 'transfer-request', fileName: 'kembar.txt', fileSize: size,
        senderName: sender, senderId: sender.padEnd(12, 'x').slice(0, 12), resumeId: `twin-${marker}`, kind: 'file',
      }));
      // Ambil requestId BARU: kalau memakai nama, dua permintaan bersamaan
      // bisa bertukar id dan yang diuji jadi bukan yang dimaksud.
      let id = null;
      for (let i = 0; i < 60 && !id; i++) {
        const list = (await api(bPorts.http, '/transfer/pending')).body || [];
        id = (list.find((x) => x.fileName === 'kembar.txt' && !before.has(x.requestId)) || {}).requestId || null;
        if (!id) await sleep(100);
      }
      await api(bPorts.http, '/transfer/respond', { body: { requestId: id, accept: true } });
      for (let i = 0; i < 60 && !conn.frames.length; i++) await sleep(50);
      conn.socket.write(frame({ type: 'file-start', fileName: 'kembar.txt', fileSize: size }));
      conn.socket.write(Buffer.alloc(size, marker));
      for (let i = 0; i < 80 && !conn.frames.some((f) => f.type === 'transfer-saved'); i++) await sleep(50);
      conn.socket.destroy();
    };
    await mkTwin('Pengirim1', 1, 4096);
    await mkTwin('Pengirim2', 2, 4096);
    const twins = fs.readdirSync(path.join(bDir, 'save')).filter((f) => /^kembar( \(\d+\))?\.txt$/.test(f)).sort();
    const twinContents = twins.map((f) => fs.readFileSync(path.join(bDir, 'save', f)).toString('hex').slice(0, 8));
    check('dua file bernama sama tidak saling menimpa',
      twins.length === 2 && new Set(twinContents).size === 2, `${twins.join(', ')}`);

    // 5e. Pembatalan oleh pengirim.
    // Diuji pada jendela yang nyata: pengguna menekan Batal setelah penerima
    // setuju tapi sebelum byte mengalir (di situ letak jendela sebenarnya
    // untuk file besar — upload masih berjalan). Lewat loopback 64 MB selesai
    // dalam ~300 ms, jadi mengejar streaming-nya hanya menghasilkan tes gagal
    // secara acak, bukan bug.
    const big = crypto.randomBytes(2 * 1024 * 1024);
    const bigUp = await upload(aPorts.http, 'batal-kirim.bin', big);
    const bigReq = await api(aPorts.http, '/transfer/request', {
      body: {
        targetIp: '127.0.0.1', targetPort: bPorts.tcp, fileName: 'batal-kirim.bin',
        fileSize: big.length, targetName: 'MesinB', resumeId: 'cancel-send-1',
      },
    });
    const bigId = bigReq.body && bigReq.body.requestId;
    await api(bPorts.http, '/transfer/respond', { body: { requestId: await pendingId(bPorts.http, 'batal-kirim.bin'), accept: true } });
    await waitStatus(aPorts.http, bigId, ['accepted']);
    const cancelled = await api(aPorts.http, `/transfer/cancel/${bigId}`, { body: { role: 'send' } });
    check('batal setelah disetujui diterima', cancelled.status === 200, `${cancelled.status}`);
    check('status pengirim menjadi cancelled',
      (await waitStatus(aPorts.http, bigId, ['cancelled'], 40)) === 'cancelled');
    const sendAfterCancel = await api(aPorts.http, '/transfer/send-file', {
      body: { requestId: bigId, filePath: bigUp.filePath },
    });
    await sleep(400);
    check('berkas tidak terkirim setelah dibatalkan',
      !fs.existsSync(path.join(bDir, 'save', 'batal-kirim.bin')),
      `send-file=${sendAfterCancel.status}`);

    // ── 5f. Batas ukuran upload ────────────────────────────────────────────
    const tiga = crypto.randomBytes(3 * 1024 * 1024);
    const upTiga = await upload(aPorts.http, 'tiga-mb.bin', tiga);
    check('upload 3 MB diterima (batas body bukan 2 MB)', !!upTiga && upTiga.fileSize === tiga.length,
      upTiga ? `${upTiga.fileSize} byte` : 'ditolak');

    // Batch banyak berkas kecil (foto) harus lolos: batasnya per berkas,
    // bukan total batch.
    const batchBoundary = `----batch${crypto.randomBytes(3).toString('hex')}`;
    const batchParts = [];
    for (let i = 0; i < 5; i++) {
      batchParts.push(Buffer.from(
        `--${batchBoundary}\r\nContent-Disposition: form-data; name="file"; filename="foto-${i}.jpg"\r\n`
        + 'Content-Type: image/jpeg\r\n\r\n', 'utf-8',
      ));
      batchParts.push(crypto.randomBytes(300 * 1024));
      batchParts.push(Buffer.from('\r\n', 'utf-8'));
    }
    batchParts.push(Buffer.from(`--${batchBoundary}--\r\n`, 'utf-8'));
    const batchRes = await fetch(`http://127.0.0.1:${aPorts.http}/transfer/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${batchBoundary}` },
      body: Buffer.concat(batchParts),
    });
    const batchBody = batchRes.ok ? await batchRes.json() : null;
    check('5 berkas dalam satu upload batch', batchRes.ok && batchBody.files.length === 5,
      `${batchRes.status} ${batchBody ? batchBody.files.length : 0} berkas`);

    const cPorts2 = { http: await findFreePort(), tcp: await findFreePort(), disc: await findFreePort() };
    const cLimit = startInstance('MesinC2', path.join(TMP, 'c3'), cPorts2, { LANDROP_MAX_UPLOAD_MB: '5' });
    const limitReady = await waitReady(cPorts2.http);
    if (limitReady) {
      const six = crypto.randomBytes(6 * 1024 * 1024);
      const res = await fetch(`http://127.0.0.1:${cPorts2.http}/transfer/upload`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=----lim' },
        body: Buffer.concat([
          Buffer.from('------lim\r\nContent-Disposition: form-data; name="file"; filename="enam.bin"\r\n\r\n'),
          six,
          Buffer.from('\r\n------lim--\r\n'),
        ]),
      });
      const text = await res.text();
      check('upload melebihi LANDROP_MAX_UPLOAD_MB → 413 berbahasa Inggris',
        res.status === 413 && /limit/i.test(text), `${res.status} ${text.slice(0, 80)}`);
    } else {
      check('instance batas upload hidup', false, 'tidak start');
    }
    try { cLimit.proc.kill('SIGKILL'); } catch (_) {}

    // ── 6. Transfer paralel ────────────────────────────────────────────────
    section('Beban — transfer paralel');

    const files = Array.from({ length: 6 }, (_, i) => crypto.randomBytes(512 * 1024));
    const results = await Promise.all(files.map(async (buf, i) => {
      const name = `paralel-${i}.bin`;
      const up = await upload(aPorts.http, name, buf);
      const req = await api(aPorts.http, '/transfer/request', {
        body: {
          targetIp: '127.0.0.1', targetPort: bPorts.tcp, fileName: name,
          fileSize: buf.length, targetName: 'MesinB', resumeId: `par-${i}`,
        },
      });
      const id = req.body && req.body.requestId;
      await api(bPorts.http, '/transfer/respond', { body: { requestId: await pendingId(bPorts.http, name), accept: true } });
      await waitStatus(aPorts.http, id, ['accepted']);
      await api(aPorts.http, '/transfer/send-file', { body: { requestId: id, filePath: up.filePath } });
      const target = path.join(bDir, 'save', name);
      for (let k = 0; k < 300 && !fs.existsSync(target); k++) await sleep(50);
      const landed = fs.existsSync(target) ? fs.readFileSync(target) : null;
      return !!landed && crypto.createHash('sha1').update(landed).digest('hex')
        === crypto.createHash('sha1').update(buf).digest('hex');
    }));
    check('6 transfer paralel semuanya utuh', results.every(Boolean), `${results.filter(Boolean).length}/6`);
    const rssLoad = rssMb(a.proc.pid);
    check('RSS setelah beban tetap di bawah 80 MB', rssLoad > 0 && rssLoad < 80, `${rssLoad} MB`);

    // ── 6b. Berkas besar: 64 MB ────────────────────────────────────────────
    section('Berkas besar');

    const raksasa = crypto.randomBytes(64 * 1024 * 1024);
    const hugeUp = await upload(aPorts.http, 'besar-64mb.bin', raksasa);
    check('upload 64 MB diterima', !!hugeUp && hugeUp.fileSize === raksasa.length);
    const hugeReq = await api(aPorts.http, '/transfer/request', {
      body: {
        targetIp: '127.0.0.1', targetPort: bPorts.tcp, fileName: 'besar-64mb.bin',
        fileSize: raksasa.length, targetName: 'MesinB', resumeId: 'huge-1',
      },
    });
    const hugeId = hugeReq.body.requestId;
    await api(bPorts.http, '/transfer/respond', { body: { requestId: await pendingId(bPorts.http, 'besar-64mb.bin'), accept: true } });
    await waitStatus(aPorts.http, hugeId, ['accepted']);
    const t0 = Date.now();
    await api(aPorts.http, '/transfer/send-file', { body: { requestId: hugeId, filePath: hugeUp.filePath } });
    const hugePath = path.join(bDir, 'save', 'besar-64mb.bin');
    for (let i = 0; i < 400 && !fs.existsSync(hugePath); i++) await sleep(50);
    const landedHuge = fs.existsSync(hugePath) ? fs.readFileSync(hugePath) : null;
    check('64 MB mendarat utuh',
      !!landedHuge && landedHuge.length === raksasa.length
      && crypto.createHash('sha256').update(landedHuge).digest('hex')
        === crypto.createHash('sha256').update(raksasa).digest('hex'),
      `${Date.now() - t0} ms`);
    const rssHuge = rssMb(a.proc.pid);
    check('RSS pengirim tetap kecil saat mengirim 64 MB', rssHuge > 0 && rssHuge < 80, `${rssHuge} MB`);
    const rssHugeB = rssMb(b.proc.pid);
    check('RSS penerima tetap kecil saat menerima 64 MB', rssHugeB > 0 && rssHugeB < 80, `${rssHugeB} MB`);

    // ── 6c. ffmpeg tidak ada → kirim apa adanya ────────────────────────────
    section('ffmpeg opsional');

    const dPorts = { http: await findFreePort(), tcp: await findFreePort(), disc: await findFreePort() };
    const d = startInstance('MesinD', path.join(TMP, 'd'), dPorts, {
      LANDROP_FFMPEG: '/nonexistent/ffmpeg',
      LANDROP_ALLOW_SELF_TARGET: '1',
    });
    if (await waitReady(dPorts.http)) {
      const aviUp = await upload(dPorts.http, 'tanpa-ffmpeg.avi', crypto.randomBytes(200 * 1024));
      const aviReq = await api(dPorts.http, '/transfer/request', {
        body: {
          targetIp: '127.0.0.1', targetPort: dPorts.tcp, fileName: 'tanpa-ffmpeg.avi',
          fileSize: aviUp.fileSize, targetName: 'MesinD', resumeId: 'no-ffmpeg-1',
        },
      });
      await api(dPorts.http, '/transfer/respond', {
        body: { requestId: await pendingId(dPorts.http, 'tanpa-ffmpeg.avi'), accept: true },
      });
      await waitStatus(dPorts.http, aviReq.body.requestId, ['accepted']);
      await api(dPorts.http, '/transfer/send-file', {
        body: { requestId: aviReq.body.requestId, filePath: aviUp.filePath },
      });
      const out = path.join(TMP, 'd', 'save', 'tanpa-ffmpeg.avi');
      for (let i = 0; i < 200 && !fs.existsSync(out); i++) await sleep(50);
      check('tanpa ffmpeg, video tetap terkirim apa adanya',
        fs.existsSync(out) && fs.statSync(out).size === aviUp.fileSize,
        fs.existsSync(out) ? `${fs.statSync(out).size} byte .avi` : 'tidak ada');
      check('transfer tanpa ffmpeg selesai',
        (await waitStatus(dPorts.http, aviReq.body.requestId, ['completed'], 60)) === 'completed');
    } else {
      check('instance tanpa ffmpeg hidup', false, 'tidak start');
    }
    try { d.proc.kill('SIGKILL'); } catch (_) {}

    // ── 7. Restart & ketahanan state ───────────────────────────────────────
    section('Restart & state di disk');

    const keyBefore = settingsKey(aDir);
    const histBefore = (await api(aPorts.http, '/history')).body || [];
    const diskBefore = fs.readdirSync(path.join(aDir, 'save'));

    a.proc.kill('SIGKILL');
    await sleep(300);
    a = startInstance('MesinA', aDir, aPorts);
    check('instance hidup lagi setelah SIGKILL', await waitReady(aPorts.http), `${aPorts.http}`);
    const keyAfter = settingsKey(aDir);
    check('accessKey tidak berubah setelah restart', !!keyAfter && keyAfter === keyBefore, `${String(keyAfter).slice(0, 8)}…`);
    const histAfter = (await api(aPorts.http, '/history')).body || [];
    check('riwayat bertahan setelah restart', histAfter.length === histBefore.length,
      `${histBefore.length} → ${histAfter.length}`);
    const diskAfter = fs.readdirSync(path.join(aDir, 'save'));
    check('folder simpan tidak dikosongkan saat start', diskAfter.length === diskBefore.length,
      `${diskBefore.length} → ${diskAfter.length}`);

    // settings.json rusak — server harus tetap hidup, bukan menolak start.
    const cKeyBefore = settingsKey(cDir);
    c.proc.kill('SIGKILL');
    await sleep(200);
    fs.writeFileSync(path.join(cDir, 'settings.json'), '{ ini bukan json');
    const c2 = startInstance('MesinC', cDir, cPorts);
    const cAlive = await waitReady(cPorts.http);
    check('settings.json rusak tidak menggagalkan start', cAlive, `${cPorts.http}`);
    const cKeyAfter = settingsKey(cDir);
    check('settings.json rusak diganti baru yang sah', !!cKeyAfter && cKeyAfter !== cKeyBefore,
      `${String(cKeyAfter || '').slice(0, 8)}…`);
    c2.proc.kill('SIGKILL');

    // ── 7b. Resume setelah penerima restart ───────────────────────────────
    section('Resume lintas restart');

    const total = 8 * 1024 * 1024;
    const half = 3 * 1024 * 1024;
    const payload = Buffer.alloc(total);
    for (let i = 0; i < total; i++) payload[i] = (i * 7) % 251;

    const sendResumeRequest = async (fromByte, toByte) => {
      const conn = await connect(bPorts.tcp);
      conn.socket.write(frame({
        type: 'transfer-request', fileName: 'lanjut-restart.bin', fileSize: total,
        senderName: 'MesinA', senderId: 'abcabcabcabc', resumeId: 'restart-1', kind: 'file',
      }));
      const id = await pendingId(bPorts.http, 'lanjut-restart.bin');
      await api(bPorts.http, '/transfer/respond', { body: { requestId: id, accept: true } });
      for (let i = 0; i < 60 && !conn.frames.length; i++) await sleep(50);
      const response = conn.frames.find((f) => f.type === 'transfer-response');
      conn.socket.write(frame({ type: 'file-start', fileName: 'lanjut-restart.bin', fileSize: total }));
      conn.socket.write(payload.slice(fromByte, toByte));
      await sleep(500);
      conn.socket.destroy();
      return response ? response.resumeOffset : -1;
    };

    check('percobaan pertama mulai dari nol', (await sendResumeRequest(0, half)) === 0,
      'offset 0');
    const partPath = path.join(bDir, 'save', 'lanjut-restart.bin.landrop-part');
    for (let i = 0; i < 40 && !fs.existsSync(partPath); i++) await sleep(100);
    check('partial tersimpan setelah koneksi putus', fs.existsSync(partPath),
      fs.existsSync(partPath) ? `${fs.statSync(partPath).size} byte` : 'tidak ada');

    b.proc.kill('SIGKILL');
    await sleep(400);
    b = startInstance('MesinB', bDir, bPorts);
    check('penerima hidup lagi dengan data dir yang sama', await waitReady(bPorts.http), `${bPorts.http}`);

    const offsetAfterRestart = await sendResumeRequest(half, total);
    check('resume melanjutkan dari offset partial setelah restart',
      offsetAfterRestart === half, `offset=${offsetAfterRestart}`);
    const resumedPath = path.join(bDir, 'save', 'lanjut-restart.bin');
    for (let i = 0; i < 100 && !fs.existsSync(resumedPath); i++) await sleep(100);
    const resumed = fs.existsSync(resumedPath) ? fs.readFileSync(resumedPath) : null;
    check('berkas hasil resume setelah restart utuh',
      !!resumed && resumed.length === total && crypto.createHash('sha1').update(resumed).digest('hex')
        === crypto.createHash('sha1').update(payload).digest('hex'),
      resumed ? `${resumed.length} byte` : 'tidak ada');
    check('partial hilang setelah selesai',
      !fs.existsSync(path.join(bDir, 'save', 'lanjut-restart.bin.landrop-part')));

    // ── 8. Discovery ───────────────────────────────────────────────────────
    section('Discovery');

    // Announce dikirim langsung (unicast ke port discovery), bukan lewat
    // broadcast: dua instance di satu mesin berbagi port, dan pengiriman
    // broadcast antar-socket di situ bergantung kernel — bukan yang mau diuji.
    const lanIp = Object.values(os.networkInterfaces()).flat()
      .find((n) => n && n.family === 'IPv4' && !n.internal).address;
    // `bind` menentukan ALAMAT SUMBER paket — itulah yang dipakai penjaga
    // anti-hijack, bukan field `ip` di payload.
    const announce = (fields, from = '127.0.0.1', to = '127.0.0.1') => new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      sock.bind(0, from, () => {
        const payload = Buffer.from(JSON.stringify({
          type: 'announce', deviceId: 'aaaa11112222', deviceName: 'MesinPalsu',
          ip: from === '127.0.0.1' ? '192.168.1.99' : lanIp,
          port: 3999, transferPort: 3998, ...fields,
        }));
        sock.send(payload, aPorts.disc, to, () => { sock.close(); resolve(); });
      });
      sock.on('error', () => { try { sock.close(); } catch (_) {} resolve(); });
    });

    await announce({}, lanIp, lanIp);
    let seen = null;
    for (let i = 0; i < 40; i++) {
      const list = (await api(aPorts.http, '/devices')).body || [];
      seen = list.find((d) => d.deviceName === 'MesinPalsu');
      if (seen) break;
      await sleep(100);
    }
    check('announce diterima dan peer masuk daftar', !!seen,
      seen ? `${seen.deviceName} @ ${seen.ip}:${seen.port}` : 'tidak muncul');

    // Anti-hijack: deviceId sama dari alamat lain tidak boleh memindahkan
    // kartu peer selama peer aslinya masih hidup.
    if (seen) {
      for (let i = 0; i < 5; i++) await announce({}, '127.0.0.1', '127.0.0.1');
      await sleep(500);
      const list = (await api(aPorts.http, '/devices')).body || [];
      const after = list.find((d) => d.deviceName === 'MesinPalsu');
      check('announce dari alamat lain tidak membajak peer yang masih hidup',
        after && after.ip === lanIp, after ? `${after.ip} (harus ${lanIp})` : 'peer hilang');
    }

    // Tanpa announce lanjutan, peer harus kedaluwarsa (timeout 10 detik).
    let dropped = false;
    for (let i = 0; i < 40; i++) {
      const list = (await api(aPorts.http, '/devices')).body || [];
      if (!list.some((d) => d.deviceName === 'MesinPalsu')) { dropped = true; break; }
      await sleep(500);
    }
    check('peer kedaluwarsa setelah announce berhenti', dropped,
      dropped ? 'hilang' : 'masih terdaftar >20 detik');

    // ── 9. Rate limit PIN ──────────────────────────────────────────────────
    section('Rate limit PIN');

    let first429 = null;
    for (let i = 1; i <= 14; i++) {
      const res = await api(aPorts.http, '/dashboard/login', { body: { pin: '000000' } });
      if (res.status === 429 && first429 === null) first429 = i;
    }
    check('percobaan PIN dibatasi (429)', first429 !== null, `429 pada percobaan ke-${first429}`);
    const retryAfter = await api(aPorts.http, '/dashboard/login', { body: { pin: '000000' } });
    check('429 menyertakan Retry-After', !!retryAfter.headers.get('retry-after'),
      `${retryAfter.headers.get('retry-after')}`);

    const pageWhileLimited = await raw({ port: aPorts.http, path: '/dashboard', headers: { host: `localhost:${aPorts.http}` } });
    check('halaman dashboard tetap terbuka saat PIN dibatasi', pageWhileLimited.status === 200,
      `${pageWhileLimited.status}`);
  } finally {
    cleanup();
    try {
      const keep = process.env.LANDROP_KEEP_TMP === '1';
      if (!keep) fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log(`\n${passes} lulus, ${failures} gagal`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
