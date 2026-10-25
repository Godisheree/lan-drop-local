#!/usr/bin/env node
/**
 * Regression: pengirim cuma boleh bilang "completed" kalau penerima
 * mengonfirmasi file-nya benar-benar tersimpan.
 *
 * Bug yang dijaga di sini (nyata, ketemu dari keluhan "katanya kekirim tapi
 * file-nya gak ada"): dulu pengirim menandai 'completed' begitu semua byte
 * masuk buffer socket. Penerima yang mati di tengah / gagal rename .part
 * tetap bikin pengirim bilang "terkirim", padahal tidak ada file apa pun.
 *
 * Tiga perilaku penerima diuji:
 *   saved → simpan + frame 'transfer-saved'      → status harus 'completed'
 *   drop  → byte dibaca penuh lalu RST tanpa ACK → status harus 'unconfirmed'
 *   fail  → frame 'transfer-save-failed'         → status 'failed' + alasan
 *
 * Usage: node scripts/check-ack.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(os.tmpdir(), 'landrop-check-ack');
const FILE_SIZE = 140313;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      if (startPort < 65000) findFreePort(startPort + 1).then(resolve, reject);
      else reject(new Error('Tidak ada port bebas'));
    });
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

/**
 * Penerima palsu: jawab accept, baca payload, lalu berperilaku sesuai mode.
 * @param {number} port
 * @param {'saved'|'drop'|'fail'} mode
 * @param {string} outDir
 */
function startFakePeer(port, mode, outDir) {
  const srv = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let want = null;
    let fileLeft = 0;
    let got = Buffer.alloc(0);
    let name = 'file.bin';

    const done = () => {
      if (mode === 'saved') {
        fs.mkdirSync(outDir, { recursive: true });
        const p = path.join(outDir, name);
        fs.writeFileSync(p, got);
        socket.write(frame({ type: 'transfer-saved', fileSize: got.length, savedTo: p, fallback: false }));
        socket.end();
      } else if (mode === 'fail') {
        socket.write(frame({ type: 'transfer-save-failed', reason: 'EACCES: simulasi gagal simpan' }));
        socket.end();
      } else {
        socket.destroy(); // tanpa ACK — seperti proses penerima mati
      }
    };

    socket.on('data', (chunk) => {
      if (fileLeft > 0) {
        got = Buffer.concat([got, chunk]);
        fileLeft -= chunk.length;
        if (fileLeft <= 0) done();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        if (want === null) want = buf.readUInt32BE(0);
        if (buf.length < 4 + want) return;
        const msg = JSON.parse(buf.slice(4, 4 + want).toString());
        buf = buf.slice(4 + want);
        want = null;
        if (msg.type === 'transfer-request') {
          socket.write(frame({ type: 'transfer-response', accepted: true, resumeOffset: 0 }));
        } else if (msg.type === 'file-start') {
          name = msg.fileName || name;
          fileLeft = msg.fileSize;
          if (buf.length > 0) {
            got = Buffer.concat([got, buf]);
            fileLeft -= buf.length;
            buf = Buffer.alloc(0);
            if (fileLeft <= 0) done();
          }
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const uploadDir = path.join(ROOT, 'uploads');
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(uploadDir, { recursive: true });

  const [srvPort, transferPort, peerSaved, peerDrop, peerFail] = await Promise.all([
    findFreePort(3210), findFreePort(3211), findFreePort(3220), findFreePort(3221), findFreePort(3222),
  ]);

  const peers = await Promise.all([
    startFakePeer(peerSaved, 'saved', path.join(ROOT, 'peer-saved')),
    startFakePeer(peerDrop, 'drop', path.join(ROOT, 'peer-drop')),
    startFakePeer(peerFail, 'fail', path.join(ROOT, 'peer-fail')),
  ]);

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(srvPort),
      TRANSFER_PORT: String(transferPort),
      LANDROP_UPLOAD_DIR: uploadDir,
      LANDROP_DATA_DIR: dataDir,
      LANDROP_ALLOW_SELF_TARGET: '1',
      LANDROP_SAVE_DIR: path.join(ROOT, 'received'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  // Tunggu server siap.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${srvPort}/me`);
      ready = r.ok;
    } catch (_) {
      await sleep(250);
    }
  }
  if (!ready) {
    console.error('❌ server LAN Drop tidak siap');
    process.exit(1);
  }

  const api = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${srvPort}${p}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {});
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  let pass = 0;
  let total = 0;
  const check = (label, ok, detail) => {
    total++;
    if (ok) pass++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  const runCase = async (mode, peerPort) => {
    const filePath = path.join(uploadDir, `uji-${mode}.jpg`);
    fs.writeFileSync(filePath, Buffer.alloc(FILE_SIZE, 9));

    const req = await api('/transfer/request', {
      targetIp: '127.0.0.1', targetPort: peerPort,
      fileName: `uji-${mode}.jpg`, fileSize: FILE_SIZE, targetName: `peer-${mode}`,
    });
    if (!req.json || !req.json.requestId) return {};

    let st = null;
    for (let i = 0; i < 40; i++) {
      const r = await api(`/transfer/status/${req.json.requestId}`);
      st = r.json;
      if (st && st.status !== 'pending') break;
      await sleep(100);
    }

    await api('/transfer/send-file', { requestId: req.json.requestId, filePath });

    let prog = null;
    for (let i = 0; i < 60; i++) {
      const r = await api(`/transfer/progress/${req.json.requestId}`);
      prog = r.json;
      if (prog && prog.status !== 'transferring') break;
      await sleep(100);
    }
    return prog || {};
  };

  const saved = await runCase('saved', peerSaved);
  check('penerima simpan + ACK → status completed', saved.status === 'completed', `status=${saved.status}`);
  check('penerima simpan + ACK → folder tujuan dilaporkan pengirim',
    !!saved.savedTo && saved.savedTo.includes('uji-saved.jpg'), `savedTo=${saved.savedTo || '-'}`);
  check('penerima simpan + ACK → file benar-benar ada di peer',
    fs.existsSync(path.join(ROOT, 'peer-saved', 'uji-saved.jpg')));

  const drop = await runCase('drop', peerDrop);
  check('penerima mati tanpa ACK → TIDAK boleh completed', drop.status === 'unconfirmed', `status=${drop.status}`);
  check('penerima mati tanpa ACK → ada alasan buat user', !!drop.reason, `reason=${drop.reason || '-'}`);
  check('penerima mati tanpa ACK → tidak ada file di peer',
    !fs.existsSync(path.join(ROOT, 'peer-drop', 'uji-drop.jpg')));

  const fail = await runCase('fail', peerFail);
  check('penerima gagal simpan → status failed', fail.status === 'failed', `status=${fail.status}`);
  check('penerima gagal simpan → alasan penerima diteruskan',
    fail.reason === 'EACCES: simulasi gagal simpan', `reason=${fail.reason || '-'}`);

  const hist = await api('/history');
  const entry = (hist.json || []).find((e) => e.fileName === 'uji-drop.jpg');
  check('riwayat mencatat status jujur (bukan completed)',
    !!entry && entry.status === 'unconfirmed', `riwayat=${entry ? entry.status : 'tidak ada'}`);

  const exited = new Promise((r) => server.on('exit', r));
  server.kill();
  for (const p of peers) p.close();
  await exited; // biar tidak berebut port/proses dengan skrip pemeriksa berikutnya
  await sleep(200);

  console.log(`\n${pass}/${total} pemeriksaan lolos.`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
