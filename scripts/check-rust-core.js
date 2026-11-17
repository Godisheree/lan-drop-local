#!/usr/bin/env node
/**
 * Regression check: inti Rust (`rust/target/release/lan-drop-core`).
 *
 * Skrip ini menjalankan DUA instance binary Rust berdampingan dan menguji
 * perilakunya sebagai sistem, bukan sebagai kode: teks, file, resume setelah
 * koneksi putus, pembatalan, riwayat, dan penolakan target berbahaya.
 *
 * Kenapa terpisah dari `check-parity.js`: paritas hanya membandingkan bentuk
 * respons HTTP. Yang menentukan aplikasi ini hidup atau tidak adalah jalur TCP
 * — dan jalur itu tidak kelihatan dari endpoint mana pun.
 *
 * Usage: node scripts/check-rust-core.js
 *   Binari dibangun dulu: (cd rust && cargo build --release)
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'rust', 'target', 'release', 'lan-drop-core');
const TMP = path.join(os.tmpdir(), `landrop-rust-${crypto.randomBytes(4).toString('hex')}`);

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

/** Buka koneksi ke port transfer, kumpulkan frame yang datang. */
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
  });
}

function startInstance(name, dir, httpPort, transferPort, discoveryPort, extraEnv = {}, bin = BIN) {
  fs.mkdirSync(path.join(dir, 'save'), { recursive: true });
  const command = bin.endsWith('.js') ? process.execPath : bin;
  const args = bin.endsWith('.js') ? [bin] : [];
  const proc = spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      LANDROP_DATA_DIR: dir,
      LANDROP_SAVE_DIR: path.join(dir, 'save'),
      PORT: String(httpPort),
      TRANSFER_PORT: String(transferPort),
      DISCOVERY_PORT: String(discoveryPort),
      DEVICE_NAME: name,
      LANDROP_ALLOW_SELF_TARGET: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.resume();
  return proc;
}

async function api(port, route, { body, method } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch (_) {}
  return { status: res.status, body: parsed };
}

async function waitReady(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.status === 200) return true;
    } catch (_) { /* belum */ }
    await sleep(150);
  }
  return false;
}

/** Antrean permintaan masuk, dicocokkan lewat nama file. */
async function pendingId(port, fileName, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const { body } = await api(port, '/transfer/pending');
    const hit = (body || []).find((p) => p.fileName === fileName && p.status === 'pending')
      || (body || []).find((p) => p.fileName === fileName);
    if (hit) return hit.requestId;
    await sleep(100);
  }
  return null;
}

async function waitStatus(port, requestId, wanted, tries = 120) {
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

/**
 * Sesi PIN dashboard. `savedTo` dan `thumbnailId` sengaja disembunyikan dari
 * pemanggil tanpa sesi, jadi cek ini harus login dulu — bukan menembak
 * endpoint dan berharap field-nya ada.
 */
async function pinSession(port) {
  const res = await fetch(`http://127.0.0.1:${port}/dashboard/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '123456' }),
  });
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0])
    .join('; ');
  return { ok: res.ok, cookie: cookies };
}

async function apiWith(port, route, cookie) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { cookie } });
  let parsed = null;
  try { parsed = await res.json(); } catch (_) {}
  return { status: res.status, body: parsed };
}

async function upload(port, fileName, payload) {
  const boundary = `----landrop${crypto.randomBytes(4).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf-8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const res = await fetch(`http://127.0.0.1:${port}/transfer/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, payload, tail]),
  });
  return res.ok ? (await res.json()).files[0] : null;
}

function ffmpegAvailable() {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
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
  fs.mkdirSync(aDir, { recursive: true });
  fs.mkdirSync(bDir, { recursive: true });

  const aHttp = await findFreePort(3410);
  const aTcp = await findFreePort(3411);
  const aDisc = await findFreePort(34244);
  const bHttp = await findFreePort(3450);
  const bTcp = await findFreePort(3451);
  const bDisc = await findFreePort(34644);

  const a = startInstance('MesinA', aDir, aHttp, aTcp, aDisc);
  const b = startInstance('MesinB', bDir, bHttp, bTcp, bDisc);
  const cleanup = () => {
    for (const proc of [a, b]) { try { proc.kill('SIGKILL'); } catch (_) {} }
  };
  process.on('exit', cleanup);

  try {
    const [readyA, readyB] = await Promise.all([waitReady(aHttp), waitReady(bHttp)]);
    check('dua instance Rust hidup', readyA && readyB, `${aHttp}/${bHttp}`);
    if (!readyA || !readyB) return;

    // ── 1. Gerbang akses ────────────────────────────────────────────────────
    // Dari loopback kunci memang tidak diminta (pemilik mesin); yang diuji di
    // sini jalur LAN, tempat tetangga Wi-Fi bisa menyambung.
    const lanIp = Object.values(os.networkInterfaces()).flat()
      .find((net) => net && net.family === 'IPv4' && !net.internal);
    const blocked = await fetch(`http://${lanIp ? lanIp.address : '127.0.0.1'}:${aHttp}/status`)
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .catch(() => ({ status: 0, body: null }));
    check('/status tanpa kunci → 401 + pairing',
      blocked.status === 401 && blocked.body && blocked.body.pairing === true,
      `${blocked.status}`);

    const key = JSON.parse(fs.readFileSync(path.join(aDir, 'settings.json'), 'utf8')).accessKey;
    const keyed = await api(aHttp, '/status', {
      body: undefined,
      method: 'GET',
    });
    check('/status dari loopback boleh tanpa kunci', keyed.status === 200);
    check('deviceName dari env dihormati', keyed.body && keyed.body.deviceName === 'MesinA',
      keyed.body && keyed.body.deviceName);

    // ── 2. Teks ────────────────────────────────────────────────────────────
    const textReq = await api(aHttp, '/transfer/request-text', {
      body: { targetIp: '127.0.0.1', targetPort: bTcp, fileName: 'Teks' },
    });
    const textId = textReq.body && textReq.body.requestId;
    check('permintaan teks dibuat', textReq.status === 200 && !!textId, `${textReq.status}`);
    check('teks diterima otomatis oleh peer dikenal',
      (await waitStatus(aHttp, textId, ['accepted'])) === 'accepted');

    const sent = await api(aHttp, '/transfer/send-text', {
      body: { requestId: textId, text: 'halo dari inti rust' },
    });
    check('kirim teks', sent.status === 200, `${sent.status}`);

    let texts = [];
    for (let i = 0; i < 40; i++) {
      texts = (await api(bHttp, '/transfer/text')).body || [];
      if (texts.length) break;
      await sleep(100);
    }
    check('teks mendarat di penerima', texts.length === 1 && texts[0].text === 'halo dari inti rust',
      JSON.stringify(texts[0] || null));
    if (texts.length) await api(bHttp, `/transfer/text/${texts[0].id}/ack`, { body: {} });
    check('pengirim melihat teks selesai',
      (await waitStatus(aHttp, textId, ['completed'])) === 'completed');

    // ── 3. File 1 MB — jalur lengkap ───────────────────────────────────────
    const big = crypto.randomBytes(1024 * 1024);
    const uploaded = await upload(aHttp, 'besar.bin', big);
    check('upload multipart', !!uploaded && uploaded.fileSize === big.length);

    const fileReq = await api(aHttp, '/transfer/request', {
      body: {
        targetIp: '127.0.0.1', targetPort: bTcp, fileName: 'besar.bin',
        fileSize: big.length, targetName: 'MesinB', resumeId: 'auto-1',
      },
    });
    const fileId = fileReq.body && fileReq.body.requestId;
    check('permintaan file masuk antrean penerima', !!await pendingId(bHttp, 'besar.bin'));
    const accepted = await api(bHttp, '/transfer/respond', {
      body: { requestId: await pendingId(bHttp, 'besar.bin'), accept: true },
    });
    check('penerima menyetujui', accepted.status === 200);
    check('pengirim melihat persetujuan',
      (await waitStatus(aHttp, fileId, ['accepted'])) === 'accepted');

    const sendFile = await api(aHttp, '/transfer/send-file', {
      body: { requestId: fileId, filePath: uploaded.filePath },
    });
    check('kirim file dimulai', sendFile.status === 200, `${sendFile.status}`);

    const target = path.join(bDir, 'save', 'besar.bin');
    for (let i = 0; i < 200 && !fs.existsSync(target); i++) await sleep(50);
    const landed = fs.existsSync(target) ? fs.readFileSync(target) : null;
    check('file 1 MB mendarat identik',
      !!landed && crypto.createHash('sha1').update(landed).digest('hex')
        === crypto.createHash('sha1').update(big).digest('hex'));
    check('pengirim melihat file selesai',
      (await waitStatus(aHttp, fileId, ['completed'])) === 'completed');
    check('file upload dibersihkan setelah dikirim', !fs.existsSync(uploaded.filePath));

    // ── 3b. Thumbnail & konversi video ─────────────────────────────────────
    // PNG 8x8 (diperkecil lewat ffmpeg kalau tersedia) harus bisa diambil
    // lewat id dari riwayat penerima, dan yang keluar harus JPEG sungguhan.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
      'base64',
    );
    const pngUp = await upload(aHttp, 'gambar.png', png);
    const pngReq = await api(aHttp, '/transfer/request', {
      body: {
        targetIp: '127.0.0.1', targetPort: bTcp, fileName: 'gambar.png',
        fileSize: png.length, targetName: 'MesinB', resumeId: 'thumb-1',
      },
    });
    await api(bHttp, '/transfer/respond', {
      body: { requestId: await pendingId(bHttp, 'gambar.png'), accept: true },
    });
    await waitStatus(aHttp, pngReq.body.requestId, ['accepted']);
    await api(aHttp, '/transfer/send-file', {
      body: { requestId: pngReq.body.requestId, filePath: pngUp.filePath },
    });
    const session = await pinSession(bHttp);
    check('login PIN dashboard berhasil', session.ok && session.cookie.includes('landrop_dash'),
      session.cookie);
    let thumbId = null;
    for (let i = 0; i < 100 && !thumbId; i++) {
      const hist = (await apiWith(bHttp, '/history', session.cookie)).body || [];
      thumbId = (hist.find((h) => h.fileName === 'gambar.png') || {}).thumbnailId || null;
      if (!thumbId) await sleep(100);
    }
    check('riwayat penerima menyimpan thumbnailId', !!thumbId, `${thumbId}`);
    if (thumbId) {
      const res = await fetch(`http://127.0.0.1:${bHttp}/thumbnail/${thumbId}`, {
        headers: { cookie: session.cookie },
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      check('thumbnail bisa diambil dan berupa JPEG',
        res.ok && bytes.length > 0 && bytes[0] === 0xff && bytes[1] === 0xd8,
        `status=${res.status} tipe=${res.headers.get('content-type')} ${bytes.length}B`);
      const naked = await api(bHttp, `/thumbnail/${thumbId}`);
      check('thumbnail tanpa kunci/PIN ditolak walau dari loopback',
        naked.status === 401, `${naked.status}`);
      const bogus = await apiWith(bHttp, `/thumbnail/${'0'.repeat(16)}`, session.cookie);
      check('id thumbnail tak dikenal → 404', bogus.status === 404, `${bogus.status}`);
    }

    // Video .avi harus sampai sebagai .mp4 kalau ffmpeg ada; kalau tidak,
    // apa adanya. Yang diuji: berkasnya sampai dan bisa dibaca penerima.
    if (ffmpegAvailable()) {
      const aviPath = path.join(TMP, 'uji.avi');
      const made = spawnSync('ffmpeg', [
        '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'testsrc=duration=1:size=160x120:rate=10',
        '-c:v', 'mpeg4', aviPath,
      ], { stdio: 'ignore' });
      if (made.status === 0 && fs.existsSync(aviPath)) {
        const aviBuf = fs.readFileSync(aviPath);
        const aviUp = await upload(aHttp, 'uji.avi', aviBuf);
        const aviReq = await api(aHttp, '/transfer/request', {
          body: {
            targetIp: '127.0.0.1', targetPort: bTcp, fileName: 'uji.avi',
            fileSize: aviBuf.length, targetName: 'MesinB', resumeId: 'video-1',
          },
        });
        await api(bHttp, '/transfer/respond', {
          body: { requestId: await pendingId(bHttp, 'uji.avi'), accept: true },
        });
        await waitStatus(aHttp, aviReq.body.requestId, ['accepted']);
        await api(aHttp, '/transfer/send-file', {
          body: { requestId: aviReq.body.requestId, filePath: aviUp.filePath },
        });
        const mp4Path = path.join(bDir, 'save', 'uji.mp4');
        for (let i = 0; i < 300 && !fs.existsSync(mp4Path); i++) await sleep(100);
        check('video .avi sampai sebagai .mp4 di penerima',
          fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 0,
          fs.existsSync(mp4Path) ? `${fs.statSync(mp4Path).size} byte` : 'tidak ada');
        check('pengirim melihat transfer video selesai',
          (await waitStatus(aHttp, aviReq.body.requestId, ['completed'])) === 'completed');
      }
    }

    // ── 4. Riwayat di kedua sisi ───────────────────────────────────────────
    const histA = (await api(aHttp, '/history')).body || [];
    const histB = (await api(bHttp, '/history')).body || [];
    check('riwayat pengirim mencatat "send"',
      histA.some((h) => h.direction === 'send' && h.status === 'completed'), `${histA.length} entri`);
    check('riwayat penerima mencatat "receive"',
      histB.some((h) => h.direction === 'receive' && h.status === 'completed'), `${histB.length} entri`);

    // ── 5. Resume: koneksi putus di tengah, lanjut dari offset ──────────────
    const total = 400 * 1024;
    const half = 100 * 1024;
    const payload = Buffer.alloc(total);
    for (let i = 0; i < total; i++) payload[i] = i % 251;

    const first = await connect(bTcp);
    first.socket.write(frame({
      type: 'transfer-request', fileName: 'lanjut.bin', fileSize: total,
      senderName: 'MesinA', senderId: 'aaaaaaaaaaaa', resumeId: 'resume-1', kind: 'file',
    }));
    const firstId = await pendingId(bHttp, 'lanjut.bin');
    check('permintaan resume pertama masuk antrean', !!firstId);
    await api(bHttp, '/transfer/respond', { body: { requestId: firstId, accept: true } });
    for (let i = 0; i < 40 && !first.frames.length; i++) await sleep(50);
    first.socket.write(frame({ type: 'file-start', fileName: 'lanjut.bin', fileSize: total }));
    first.socket.write(payload.slice(0, half));
    await sleep(400);
    first.socket.destroy();
    await sleep(400);

    const second = await connect(bTcp);
    second.socket.write(frame({
      type: 'transfer-request', fileName: 'lanjut.bin', fileSize: total,
      senderName: 'MesinA', senderId: 'aaaaaaaaaaaa', resumeId: 'resume-1', kind: 'file',
    }));
    const secondId = await pendingId(bHttp, 'lanjut.bin');
    check('permintaan resume kedua masuk antrean', !!secondId);
    await api(bHttp, '/transfer/respond', { body: { requestId: secondId, accept: true } });
    for (let i = 0; i < 60 && !second.frames.length; i++) await sleep(50);
    const response = second.frames.find((f) => f.type === 'transfer-response');
    check('penerima menjawab dengan offset hasil resume',
      response && response.accepted === true && response.resumeOffset === half,
      response ? `offset=${response.resumeOffset}` : 'tanpa balasan');

    second.socket.write(frame({ type: 'file-start', fileName: 'lanjut.bin', fileSize: total }));
    second.socket.write(payload.slice(half));
    const resumedPath = path.join(bDir, 'save', 'lanjut.bin');
    for (let i = 0; i < 200 && !fs.existsSync(resumedPath); i++) await sleep(50);
    const resumed = fs.existsSync(resumedPath) ? fs.readFileSync(resumedPath) : null;
    check('file hasil resume utuh dan benar',
      !!resumed && resumed.length === total && resumed.equals(payload),
      resumed ? `${resumed.length} byte` : 'tidak ada');
    for (let i = 0; i < 40 && !second.frames.some((f) => f.type === 'transfer-saved'); i++) await sleep(50);
    check('penerima mengirim konfirmasi transfer-saved',
      second.frames.some((f) => f.type === 'transfer-saved'), JSON.stringify(second.frames.slice(-1)));
    second.socket.destroy();

    // ── 6. Batal menghapus partial, bukan menyisakannya ────────────────────
    const third = await connect(bTcp);
    third.socket.write(frame({
      type: 'transfer-request', fileName: 'batal.bin', fileSize: 300 * 1024,
      senderName: 'MesinA', senderId: 'bbbbbbbbbbbb', resumeId: 'cancel-1', kind: 'file',
    }));
    const thirdId = await pendingId(bHttp, 'batal.bin');
    await api(bHttp, '/transfer/respond', { body: { requestId: thirdId, accept: true } });
    for (let i = 0; i < 40 && !third.frames.length; i++) await sleep(50);
    third.socket.write(frame({ type: 'file-start', fileName: 'batal.bin', fileSize: 300 * 1024 }));
    third.socket.write(Buffer.alloc(64 * 1024, 7));
    await sleep(300);
    await api(bHttp, `/transfer/cancel/${thirdId}`, { body: { role: 'receive' } });
    await sleep(300);
    const leftovers = fs.readdirSync(path.join(bDir, 'save')).filter((f) => f.endsWith('.landrop-part'));
    check('pembatalan tidak menyisakan partial', leftovers.length === 0, leftovers.join(','));
    third.socket.destroy();

    // ── 7. Target berbahaya ditolak sebelum menyambung ─────────────────────
    const linkLocal = await api(aHttp, '/transfer/request', {
      body: { targetIp: '169.254.169.254', targetPort: 80, fileName: 'x', fileSize: 1 },
    });
    check('target link-local ditolak', linkLocal.status === 400, `${linkLocal.status}`);
    const publicIp = await api(aHttp, '/transfer/request', {
      body: { targetIp: '8.8.8.8', targetPort: 80, fileName: 'x', fileSize: 1 },
    });
    check('target internet publik ditolak', publicIp.status === 400, `${publicIp.status}`);

    // ── 8. Rute data lain tetap hidup ──────────────────────────────────────
    for (const route of ['/me', '/devices', '/discovery/status', '/transfer/active', '/system/disk']) {
      const res = await api(aHttp, route);
      check(`GET ${route} → 200`, res.status === 200, `${res.status}`);
    }
    check('kunci akses dipakai dari settings.json', typeof key === 'string' && key.length === 48);

    // Dashboard membaca /logs dengan sesi PIN. Kalau ring buffer-nya kosong
    // selamanya, halaman pantau tidak pernah bisa menjelaskan apa yang terjadi.
    // Sesi PIN hidup per instance — token instance B tidak berlaku di A.
    const sessionA = await pinSession(aHttp);
    const logs = await apiWith(aHttp, '/logs', sessionA.cookie);
    check('/logs berisi aktivitas transfer', Array.isArray(logs.body.lines) && logs.body.lines.length > 0,
      `${(logs.body.lines || []).length} baris`);

    // ── 9. Interop: Rust ↔ Node di protokol yang sama ──────────────────────
    // Ini inti dari strategi strangler: dua implementasi harus bisa saling
    // kirim. Tanpa cek ini, "kontrak identik" cuma klaim di dokumen.
    const nDir = path.join(TMP, 'node');
    const nHttp = await findFreePort(3480);
    const nTcp = await findFreePort(3481);
    const nDisc = await findFreePort(34944);
    const node = startInstance('MesinNode', nDir, nHttp, nTcp, nDisc, {}, path.join(ROOT, 'server', 'index.js'));
    try {
      check('instance Node hidup', await waitReady(nHttp), `${nHttp}`);

      // Rust → Node (teks)
      const toNode = await api(aHttp, '/transfer/request-text', {
        body: { targetIp: '127.0.0.1', targetPort: nTcp, fileName: 'Teks' },
      });
      check('Rust→Node: permintaan teks diterima',
        (await waitStatus(aHttp, toNode.body.requestId, ['accepted'])) === 'accepted');
      await api(aHttp, '/transfer/send-text', {
        body: { requestId: toNode.body.requestId, text: 'dari rust' },
      });
      let nodeTexts = [];
      for (let i = 0; i < 60; i++) {
        nodeTexts = (await api(nHttp, '/transfer/text')).body || [];
        if (nodeTexts.length) break;
        await sleep(100);
      }
      check('Rust→Node: teks mendarat', nodeTexts.length === 1 && nodeTexts[0].text === 'dari rust',
        JSON.stringify(nodeTexts[0] || null));
      if (nodeTexts.length) await api(nHttp, `/transfer/text/${nodeTexts[0].id}/ack`, { body: {} });

      // Node → Rust (file 256 KB)
      const payload2 = crypto.randomBytes(256 * 1024);
      const upNode = await upload(nHttp, 'balik.bin', payload2);
      const fromNode = await api(nHttp, '/transfer/request', {
        body: {
          targetIp: '127.0.0.1', targetPort: aTcp, fileName: 'balik.bin',
          fileSize: payload2.length, targetName: 'MesinA', resumeId: 'interop-1',
        },
      });
      const rustPending = await pendingId(aHttp, 'balik.bin');
      check('Node→Rust: permintaan file masuk antrean Rust', !!rustPending);
      await api(aHttp, '/transfer/respond', { body: { requestId: rustPending, accept: true } });
      check('Node→Rust: Rust menyetujui',
        (await waitStatus(nHttp, fromNode.body.requestId, ['accepted'])) === 'accepted');
      await api(nHttp, '/transfer/send-file', {
        body: { requestId: fromNode.body.requestId, filePath: upNode.filePath },
      });
      const backPath = path.join(aDir, 'save', 'balik.bin');
      for (let i = 0; i < 200 && !fs.existsSync(backPath); i++) await sleep(50);
      const back = fs.existsSync(backPath) ? fs.readFileSync(backPath) : null;
      check('Node→Rust: byte sampai identik',
        !!back && crypto.createHash('sha1').update(back).digest('hex')
          === crypto.createHash('sha1').update(payload2).digest('hex'));
    } finally {
      try { node.kill('SIGKILL'); } catch (_) {}
    }
  } finally {
    cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${passes} lulus, ${failures} gagal`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
