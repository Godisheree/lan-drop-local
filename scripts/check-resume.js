#!/usr/bin/env node
/**
 * Regression check: transport TCP butuh kunci + resume tidak mencampur file.
 *
 * Dua bug yang dijaga di sini pernah terbukti lewat uji langsung:
 *
 *   - Port transfer TCP terbuka tanpa kunci. HTTP sudah dijaga, tapi siapa pun
 *     di Wi-Fi bisa menyambung langsung ke port itu dan mengirim teks (yang
 *     diterima otomatis) — gerbang HTTP-nya jadi tidak berarti.
 *   - Resume memakai kunci nama+ukuran. File A (2000 byte 'A') lalu file B
 *     (2000 byte 'B') dengan nama dan ukuran sama disambung menjadi satu file
 *     campuran, dan dilaporkan "completed".
 *
 * Cek ini menjalankan server sungguhan (spawn) dan bicara protokol frame
 * langsung, jadi yang diuji adalah perilaku, bukan bentuk kode.
 *
 * Usage: node scripts/check-resume.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), `landrop-resume-${crypto.randomBytes(4).toString('hex')}`);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort(start) {
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

/**
 * Buka koneksi ke port transfer dan kumpulkan SEMUA frame yang datang.
 *
 * Penting: penerima tidak membalas apa pun saat frame `transfer-request`
 * masuk — balasan `transfer-response` baru dikirim setelah ada yang menekan
 * "Terima" (lewat HTTP). Jadi tes ini harus: kirim permintaan, terima lewat
 * API, baru baca balasannya.
 *
 * @param {number} port
 * @returns {Promise<{socket: net.Socket, frames: Object[], closed: boolean, wait: (ms: number) => Promise<void>}>}
 */
function connect(target) {
  const opt = typeof target === 'number' ? { host: '127.0.0.1', port: target } : target;
  return new Promise((resolve) => {
    const frames = [];
    let buf = Buffer.alloc(0);
    const state = { closed: false };

    const socket = net.createConnection({ host: opt.host, port: opt.port }, () => {
      resolve({
        socket,
        frames,
        get closed() { return state.closed; },
        wait: (ms) => sleep(ms),
      });
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
  });
}

/** Ambil permintaan yang menunggu, dari API lokal. */
async function pendingList(httpPort) {
  const res = await fetch(`http://127.0.0.1:${httpPort}/transfer/pending`);
  return res.ok ? res.json() : [];
}

/** Tekan "Terima" lewat API. */
async function accept(httpPort, requestId) {
  const res = await fetch(`http://127.0.0.1:${httpPort}/transfer/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, accept: true }),
  });
  return res.ok ? res.json() : null;
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dataDir = path.join(TMP, 'data');
  const saveDir = path.join(TMP, 'save');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(saveDir, { recursive: true });

  const httpPort = await findFreePort(3310);
  const transferPort = await findFreePort(3311);

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(httpPort),
      TRANSFER_PORT: String(transferPort),
      DISCOVERY_PORT: String(await findFreePort(33244)),
      LANDROP_DATA_DIR: dataDir,
      LANDROP_SAVE_DIR: saveDir,
      LANDROP_NO_BROWSER: '1',
      // Semua permintaan di cek ini datang dari loopback; tanpa ini alamat
      // pengirim tidak akan cocok dengan peer discovery mana pun.
      LANDROP_ALLOW_SELF_TARGET: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.resume();
  server.stderr.resume();

  const cleanup = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);

  // Tunggu siap.
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/me`);
      ready = res.ok;
    } catch (_) { /* belum */ }
    if (!ready) await sleep(150);
  }
  if (!ready) {
    check('server uji bisa dijalankan', false);
    cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  const key = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).accessKey;

  // ── 1. Teks dari sumber yang tidak dikenal tidak diterima diam-diam ─────
  //
  // Port transfer TCP tidak memakai kunci perangkat: peer di LAN tidak punya
  // kunci kita, dan memaksanya berarti transfer antar perangkat mati. Yang
  // dijaga: klien yang BUKAN bagian jaringan LAN DROP (tidak pernah announce)
  // tidak boleh menaruh teks di kotak masuk tanpa persetujuan.
  const { listLANIPv4 } = require(path.join(ROOT, 'server/platform'));
  const lanIp = (listLANIPv4()[0] || {}).address;
  if (lanIp) {
    const inject = await connect({ host: lanIp, port: transferPort });
    inject.socket.write(frame({
      type: 'transfer-request',
      fileName: 'Teks',
      fileSize: 0,
      senderName: 'Tetangga',
      senderId: 'tetangga',
      kind: 'text',
    }));
    await inject.wait(300);

    // Pengirim belum mengirim payload teks: protokol mengharuskan penerima
    // menyetujui dulu. Ini justru yang hilang pada jalur lama — kind:text
    // langsung auto-accept sebelum ada persetujuan.
    const queued = await pendingList(httpPort);
    check('teks dari sumber tak dikenal masuk antrean persetujuan',
      queued.some((p) => p.senderName === 'Tetangga'), `pending=${queued.length}`);

    const texts = await (await fetch(`http://127.0.0.1:${httpPort}/transfer/text`)).json();
    check('teks belum disetujui tidak masuk kotak masuk', texts.length === 0, `texts=${texts.length}`);
    inject.socket.destroy();
  } else {
    console.log('  SKIP  teks dari sumber tak dikenal - tidak ada alamat LAN di mesin ini');
  }

  // ── 2. Kirim sebagian, putus (FIN), partial harus tersimpan ─────────────
  const payload = crypto.randomBytes(64 * 1024);
  const half = payload.length / 2;
  const resumeId = crypto.randomUUID();
  const base = { senderName: 'Pengirim-Uji', senderId: 'pengirim-uji', accessKey: key, resumeId };

  const first = await connect(transferPort);
  first.socket.write(frame({
    ...base, type: 'transfer-request', fileName: 'utuh.bin', fileSize: payload.length, kind: 'file',
  }));
  await first.wait(400);

  const list1 = await pendingList(httpPort);
  const req1 = list1.find((p) => p.fileName === 'utuh.bin');
  check('kiriman dengan kunci masuk daftar pending', !!req1, req1 ? `id=${req1.requestId}` : 'tidak ada');

  let resumeOffset = null;
  if (req1) {
    await accept(httpPort, req1.requestId);
    await first.wait(400);
    const response = first.frames.find((f) => f.type === 'transfer-response');
    check('penerima membalas accepted', !!(response && response.accepted === true),
      response ? JSON.stringify(response) : 'tidak ada balasan');

    first.socket.write(frame({ type: 'file-start', fileName: 'utuh.bin', fileSize: payload.length }));
    first.socket.write(payload.slice(0, half));
    await first.wait(600);
    first.socket.destroy(); // FIN — pengirim menyerah, bukan membatalkan
    await first.wait(700);
  }

  const partFile = path.join(saveDir, 'utuh.bin.landrop-part');
  const partExists = fs.existsSync(partFile);
  check('setelah putus, partial .landrop-part tetap ada', partExists);
  check('partial berisi byte yang sudah masuk (bukan 0)', partExists && fs.statSync(partFile).size > 0,
    partExists ? `${fs.statSync(partFile).size} byte` : 'tidak ada file');

  // ── 3. Kirim ulang dengan resumeId sama → lanjut, bukan mulai dari nol ──
  const second = await connect(transferPort);
  second.socket.write(frame({
    ...base, type: 'transfer-request', fileName: 'utuh.bin', fileSize: payload.length, kind: 'file',
  }));
  await second.wait(400);

  const list2 = await pendingList(httpPort);
  const req2 = list2.find((p) => p.fileName === 'utuh.bin');
  if (req2) {
    await accept(httpPort, req2.requestId);
    await second.wait(400);
    const response = second.frames.find((f) => f.type === 'transfer-response');
    resumeOffset = response ? response.resumeOffset : null;
    check('kirim ulang menawarkan resume dari offset > 0',
      typeof resumeOffset === 'number' && resumeOffset > 0, `offset=${resumeOffset}`);

    const from = typeof resumeOffset === 'number' && resumeOffset > 0 ? resumeOffset : half;
    second.socket.write(frame({ type: 'file-start', fileName: 'utuh.bin', fileSize: payload.length }));
    second.socket.write(payload.slice(from));
    await second.wait(1500);
    second.socket.destroy();
    await second.wait(500);
  }

  const finalFile = path.join(saveDir, 'utuh.bin');
  const finalOk = fs.existsSync(finalFile);
  check('file akhir mendarat', finalOk);
  check('isi file akhir identik dengan aslinya (resume tidak mencampur byte)',
    finalOk && Buffer.compare(fs.readFileSync(finalFile), payload) === 0,
    finalOk ? `${fs.statSync(finalFile).size} byte` : 'tidak ada file');

  // ── 4. File LAIN dengan nama & ukuran sama tidak ikut disambung ─────────
  const third = await connect(transferPort);
  third.socket.write(frame({
    type: 'transfer-request',
    fileName: 'utuh.bin',
    fileSize: payload.length,
    senderName: 'Pengirim-Uji',
    senderId: 'pengirim-uji',
    accessKey: key,
    resumeId: crypto.randomUUID(), // identitas berbeda = file berbeda
    kind: 'file',
  }));
  await third.wait(400);

  const list3 = await pendingList(httpPort);
  const req3 = list3.find((p) => p.fileName === 'utuh.bin');
  if (req3) {
    await accept(httpPort, req3.requestId);
    await third.wait(400);
    const response = third.frames.find((f) => f.type === 'transfer-response');
    check('file berbeda dengan nama+ukuran sama TIDAK ditawari resume',
      !!response && !response.resumeOffset, response ? `resumeOffset=${response.resumeOffset}` : 'tidak ada balasan');
  } else {
    check('file berbeda dengan nama+ukuran sama TIDAK ditawari resume', false, 'permintaan tidak masuk pending');
  }
  third.socket.destroy();

  // ── Ringkasan ───────────────────────────────────────────────────────────
  console.log(
    failures === 0
      ? `\n✅ ${passes} pemeriksaan transport & resume lolos.`
      : `\n❌ ${failures} pemeriksaan transport & resume gagal.`
  );
  process.exitCode = failures > 0 ? 1 : 0;

  cleanup();
  await sleep(200);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('cek gagal dijalankan:', err && err.message);
  process.exitCode = 1;
});