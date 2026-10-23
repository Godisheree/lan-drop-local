#!/usr/bin/env node
/**
 * Uji perilaku terima otomatis (auto-approve) di sisi server.
 *
 * Bicara protokol frame TCP mentah langsung ke instance server yang
 * dijalankan skrip ini — tanpa browser. Yang diuji bukan "apakah toggle
 * tersimpan", tapi apakah penerimaan otomatis benar-benar aman:
 *
 *   1. Toggle mati            → permintaan tetap menunggu (tidak diterima)
 *   2. Toggle nyala           → diterima tanpa modal, file mendarat di disk
 *   3. Ukuran tidak diketahui → DITOLAK (fail-closed), bukan diterima buta
 *   4. Ukuran klaim raksasa   → DITOLAK (ruang disk tidak cukup)
 *   5. Ukuran nyata > klaim   → transfer dibatalkan sebelum menulis apa pun
 *   6. Selesai                → entri pending dibersihkan (tidak ada hantu)
 *
 * Usage: node scripts/check-autoapprove.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Protokol frame: 4-byte big-endian uint32 panjang + payload JSON UTF-8
// ---------------------------------------------------------------------------

function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json]);
}

/** Kumpulkan frame JSON dari socket. */
function frameCollector(onFrame) {
  let buf = Buffer.alloc(0);
  return (data) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const payload = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      try {
        onFrame(JSON.parse(payload.toString('utf-8')));
      } catch (_) {}
    }
  };
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => {
      if (start < 65000) findFreePort(start + 1).then(resolve, reject);
      else reject(new Error('tidak ada port bebas'));
    });
    srv.listen(start, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Kirim transfer-request lalu tunggu transfer-response.
 * @returns {Promise<{socket: net.Socket, response: Object|null}>}
 */
function sendRequest(port, meta, { waitMs = 800 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = null;

    socket.on('connect', () => socket.write(frame({ type: 'transfer-request', ...meta })));
    socket.on('data', frameCollector((msg) => {
      if (msg.type === 'transfer-response') response = msg;
    }));
    socket.on('error', () => {});
    socket.on('close', () => resolve({ socket, response }));

    setTimeout(() => resolve({ socket, response }), waitMs);
  });
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------

async function main() {
  const root = path.join(os.tmpdir(), `landrop-autoapprove-${process.pid}`);
  const dataDir = path.join(root, 'data');
  const saveDir = path.join(root, 'save');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(saveDir, { recursive: true });

  const PORT = await findFreePort(3410);
  const TRANSFER_PORT = await findFreePort(3411);
  const base = `http://127.0.0.1:${PORT}`;

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TRANSFER_PORT: String(TRANSFER_PORT),
      DISCOVERY_PORT: String(await findFreePort(3412)),
      LANDROP_DATA_DIR: dataDir,
      LANDROP_SAVE_DIR: saveDir,
      DEVICE_NAME: 'Penerima-Test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const cleanup = () => {
    try { child.kill(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    // Tunggu server siap.
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        await getJson(`${base}/me`);
        ready = true;
        break;
      } catch (_) {
        await sleep(150);
      }
    }
    if (!ready) throw new Error('server tidak siap');

    const sender = { senderName: 'Pengirim-Test', senderId: 'pengirim-test', batchId: 'b1' };

    // --- 1. Toggle mati → tetap menunggu --------------------------------
    const off = await sendRequest(TRANSFER_PORT, { ...sender, fileName: 'a.txt', fileSize: 100, kind: 'file' });
    check('toggle mati: tidak ada balasan accept', !off.response || off.response.accepted !== true,
      off.response ? JSON.stringify(off.response) : 'tidak ada frame');
    off.socket.destroy();

    // --- 2. Nyalakan toggle ---------------------------------------------
    const enabled = await postJson(`${base}/settings/auto-approve`, { enabled: true, peers: [] });
    check('POST /settings/auto-approve menyimpan enabled', enabled.body.enabled === true);
    const readBack = await getJson(`${base}/settings/auto-approve`);
    check('GET /settings/auto-approve membaca kembali', readBack.enabled === true);

    // --- 3. Ukuran tidak diketahui → tolak (fail-closed) ----------------
    const unknown = await sendRequest(TRANSFER_PORT, { ...sender, fileName: 'b.txt', fileSize: 0, kind: 'file' });
    check('ukuran tidak diketahui: DITOLAK', unknown.response && unknown.response.accepted === false,
      unknown.response ? String(unknown.response.message) : 'tidak ada frame');
    unknown.socket.destroy();

    // --- 4. Klaim ukuran raksasa → tolak karena disk --------------------
    const huge = await sendRequest(TRANSFER_PORT, { ...sender, fileName: 'c.txt', fileSize: 1e15, kind: 'file' });
    check('klaim 1e15 byte: DITOLAK', huge.response && huge.response.accepted === false,
      huge.response ? String(huge.response.message) : 'tidak ada frame');
    huge.socket.destroy();

    // --- 5. Terima otomatis dengan ukuran jujur, file harus mendarat -----
    const payload = Buffer.from('halo dari uji terima otomatis\n', 'utf-8');
    const accepted = await sendRequest(
      TRANSFER_PORT,
      { ...sender, fileName: 'auto-test.txt', fileSize: payload.length, kind: 'file' },
      { waitMs: 150 }
    );
    check('ukuran wajar: DITERIMA otomatis', accepted.response && accepted.response.accepted === true,
      accepted.response ? 'accepted' : 'tidak ada frame');

    if (accepted.response && accepted.response.accepted === true) {
      const closed = new Promise((r) => accepted.socket.on('close', r));
      accepted.socket.write(frame({ type: 'file-start', fileName: 'auto-test.txt', fileSize: payload.length }));
      accepted.socket.write(payload);
      // Penerima menutup socket untuk menandakan selesai.
      await Promise.race([closed, sleep(4000)]);
      accepted.socket.destroy();
      await sleep(300);

      const landed = path.join(saveDir, 'auto-test.txt');
      check('file mendarat di folder simpan', fs.existsSync(landed));
      if (fs.existsSync(landed)) {
        check('isi file utuh', fs.readFileSync(landed, 'utf-8') === payload.toString('utf-8'));
      }
    }

    // --- 6. Ukuran nyata jauh > klaim → batal sebelum menulis ------------
    const ghost = await sendRequest(
      TRANSFER_PORT,
      { ...sender, fileName: 'ghost.txt', fileSize: 10, kind: 'file' },
      { waitMs: 150 }
    );
    if (ghost.response && ghost.response.accepted === true) {
      ghost.socket.write(frame({ type: 'file-start', fileName: 'ghost.txt', fileSize: 1e15 }));
      ghost.socket.write(Buffer.alloc(10));
      await sleep(600);
    }
    ghost.socket.destroy();
    await sleep(200);
    check('klaim palsu 1e15 di file-start: tidak ada file ditulis',
      !fs.existsSync(path.join(saveDir, 'ghost.txt')) &&
      !fs.existsSync(path.join(saveDir, 'ghost.txt.landrop-part')));

    // --- 7. Tidak ada entri pending yang tertinggal ----------------------
    const pending = await getJson(`${base}/transfer/pending`);
    const stuck = pending.filter((p) => p.status === 'accepted' || p.status === 'pending');
    check('tidak ada entri pending tertinggal setelah transfer selesai', stuck.length === 0,
      stuck.length ? JSON.stringify(stuck) : '');

    // --- 8. Toggle mati lagi → kembali menunggu --------------------------
    await postJson(`${base}/settings/auto-approve`, { enabled: false });
    const offAgain = await sendRequest(TRANSFER_PORT, { ...sender, fileName: 'd.txt', fileSize: 100, kind: 'file' });
    check('toggle dimatikan: tidak diterima otomatis', !offAgain.response || offAgain.response.accepted !== true);
    offAgain.socket.destroy();

  } finally {
    child.kill();
    await sleep(200);
    if (process.argv.includes('--logs')) console.log('\n--- log server ---\n' + logs.join(''));
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} pemeriksaan lolos.`);
  if (failed.length) {
    console.log('Gagal: ' + failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Uji gagal dijalankan:', err.message);
  process.exit(1);
});
