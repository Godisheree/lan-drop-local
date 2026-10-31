#!/usr/bin/env node
/**
 * Uji dashboard monitoring (/dashboard) di server sungguhan.
 *
 * Yang diuji bukan "halamannya ada", tapi hal-hal yang bikin dashboard
 * berbohong:
 *   1. Endpoint yang dipakai kartu-kartunya benar-benar ada dan bentuknya
 *      sesuai (kalau field-nya berubah, dashboard nampil "—" tanpa error).
 *   2. `GET /logs?since=` benar-benar menyaring — kalau tidak, tiap 2 detik
 *      300 baris terkirim ulang dan dashboard-nya lag.
 *   3. Id log monoton, dan id lama yang lebih besar dari server (kasus server
 *      restart) terdeteksi sebagai "reset", bukan bikin log kosong selamanya.
 *   4. Setiap id yang diambil `public/js/dashboard.js` benar-benar ada di
 *      `public/dashboard.html` — ini yang bikin kartu kosong tanpa satu pun
 *      error di console.
 *   5. Service worker tetap memakai URL root sebagai shell offline, bukan
 *      /dashboard.
 *
 * Usage: node scripts/check-dashboard.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;

function check(name, passed, detail = '') {
  if (passed) {
    console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Frame protokol transfer: panjang 4 byte big-endian + JSON. */
function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      if (startPort < 65000) resolve(findFreePort(startPort + 1));
      else reject(new Error('Tidak ada port bebas'));
    });
  });
}

async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { status: res.status, type: res.headers.get('content-type') || '', text, json };
}

// ---------------------------------------------------------------------------

// Server sekali pakai: angkat → tunggu /status → tampung yang tercetak →
// matikan. Dipakai untuk satu pertanyaan saja: apa yang kelihatan di terminal?
async function spawnProbe(extraArgs = [], extraEnv = {}) {
  const root = path.join(os.tmpdir(), `landrop-dbg-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'save'), { recursive: true });

  const [PORT, TRANSFER_PORT, DISCOVERY_PORT] = await Promise.all([
    findFreePort(3520),
    findFreePort(3521),
    findFreePort(3522),
  ]);

  const env = {
    ...process.env,
    PORT: String(PORT),
    TRANSFER_PORT: String(TRANSFER_PORT),
    DISCOVERY_PORT: String(DISCOVERY_PORT),
    LANDROP_DATA_DIR: path.join(root, 'data'),
    LANDROP_SAVE_DIR: path.join(root, 'save'),
    DEVICE_NAME: 'Dashboard-Debug',
  };
  // "Default" harus benar-benar default: jangan ikut kalau shell-nya sudah
  // menyetel flag ini.
  delete env.LANDROP_DEBUG;
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, ['server/index.js', ...extraArgs], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));

  for (let i = 0; i < 60; i++) {
    try {
      if ((await get(`http://127.0.0.1:${PORT}/status`)).status === 200) break;
    } catch (_) {
      await sleep(250);
    }
  }
  await sleep(400); // baris terakhir (mis. error port) diberi waktu
  try {
    child.kill();
  } catch (_) {}
  await sleep(100);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {}
  return out;
}

async function main() {
  const root = path.join(os.tmpdir(), `landrop-dashboard-${process.pid}`);
  const dataDir = path.join(root, 'data');
  const saveDir = path.join(root, 'save');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(saveDir, { recursive: true });

  const [PORT, TRANSFER_PORT, DISCOVERY_PORT] = await Promise.all([
    findFreePort(3510),
    findFreePort(3511),
    findFreePort(3512),
  ]);
  const base = `http://127.0.0.1:${PORT}`;

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      TRANSFER_PORT: String(TRANSFER_PORT),
      DISCOVERY_PORT: String(DISCOVERY_PORT),
      LANDROP_DATA_DIR: dataDir,
      LANDROP_SAVE_DIR: saveDir,
      DEVICE_NAME: 'Dashboard-Test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const cleanup = () => {
    try {
      child.kill();
    } catch (_) {}
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) {}
  };

  try {
    // 1. Server siap
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = (await get(`${base}/status`)).status === 200;
      } catch (_) {
        await sleep(250);
      }
    }
    check('server jalan dan /status membalas', ready, ready ? `${base}/status` : logs.join('').slice(-300));
    if (!ready) return;

    // 2. Halaman dashboard
    const page = await get(`${base}/dashboard`);
    check('/dashboard membalas HTML', page.status === 200 && page.type.includes('text/html'), `HTTP ${page.status}`);
    check(
      'halaman memuat script dashboard + pane log',
      page.text.includes('/js/dashboard.js') && page.text.includes('id="logPane"')
    );
    check('halaman tidak diindex mesin pencari', page.text.includes('name="robots" content="noindex"'));

    // 3. /status — semua yang dipakai kartu "Status server"
    const st = (await get(`${base}/status`)).json || {};
    check('status: nama perangkat', st.deviceName === 'Dashboard-Test', String(st.deviceName));
    check('status: port HTTP cocok', st.port === PORT, `${st.port} vs ${PORT}`);
    check('status: port transfer cocok', st.transferPort === TRANSFER_PORT);
    check('status: port discovery terisi', Number.isInteger(st.discoveryPort));
    check('status: uptime & startedAt masuk akal', st.uptimeSeconds >= 0 && st.startedAt <= Date.now());
    check('status: folder simpan & data', typeof st.saveDir === 'string' && typeof st.dataDir === 'string');
    check('status: versi dari package.json', /^\d+\.\d+\.\d+$/.test(String(st.version || '')), String(st.version));
    // commit boleh null (bukan repo git, mis. hasil build Electron)
    check(
      'status: commit 7 karakter atau null',
      st.commit === null || /^[0-9a-f]{7}$/.test(String(st.commit)),
      String(st.commit)
    );

    // 4. /logs — heart of the live log
    const first = (await get(`${base}/logs?since=0`)).json || {};
    check('logs: bentuk {lines, lastId, depth}', Array.isArray(first.lines) && Number.isInteger(first.lastId) && first.depth === 300);
    check('logs: berisi log startup server', first.lines.length > 0, `${first.lines.length} baris`);
    check(
      'logs: tiap baris punya id/ts/level/text',
      first.lines.every((l) => Number.isInteger(l.id) && Number.isInteger(l.ts) && ['info', 'warn', 'error'].includes(l.level) && typeof l.text === 'string')
    );

    const second = (await get(`${base}/logs?since=${first.lastId}`)).json || {};
    check('logs: since=<lastId> tidak mengulang baris lama', second.lines.length === 0, `${second.lines.length} baris`);
    check('logs: lastId tidak pernah turun', second.lastId >= first.lastId, `${second.lastId} >= ${first.lastId}`);

    // Server restart = id balik ke 1. Klien harus bisa mengenalinya: lastId
    // yang lebih kecil dari id yang dia simpan. Di sini id selalu naik, jadi
    // yang bisa diuji: id baris pertama baris > 0 dan unik.
    const ids = first.lines.map((l) => l.id);
    check('logs: id unik & naik monoton', new Set(ids).size === ids.length && ids.every((id, i) => i === 0 || id > ids[i - 1]));

    // 5. Endpoint lain yang dipakai kartu dashboard
    const devices = (await get(`${base}/devices`)).json;
    check('devices: array', Array.isArray(devices));

    const disc = (await get(`${base}/discovery/status`)).json || {};
    check(
      'discovery: {interfaces, listener, peers, tailscale, ready}',
      Array.isArray(disc.interfaces) &&
        typeof disc.ready === 'boolean' &&
        disc.listener &&
        disc.peers &&
        disc.tailscale
    );

    const disk = (await get(`${base}/system/disk`)).json || {};
    check('disk: free angka & ada path', disk.free > 0 && typeof disk.path === 'string', `${disk.free} byte`);

    const auto = (await get(`${base}/settings/auto-approve`)).json || {};
    check('auto-approve: {enabled, peers[]}', typeof auto.enabled === 'boolean' && Array.isArray(auto.peers));

    const hist = await get(`${base}/history`);
    check('history: array', Array.isArray(hist.json));

    const active = await get(`${base}/transfer/active`);
    check('transfer/active: array saat idle', Array.isArray(active.json) && active.json.length === 0);

    // 5b. Transfer masuk sungguhan: soket ke port transfer + frame
    // transfer-request. Ini yang harus terlihat di kartu "Transfer aktif"
    // sebagai arah TERIMA, dan tombol Batal-nya harus benar-benar
    // membersihkannya. Soket dibiarkan terbuka — server membuang entri
    // pending begitu pengirim terputus, jadi kalau ditutup duluan tidak ada
    // yang bisa diperiksa.
    const peer = net.connect(TRANSFER_PORT, '127.0.0.1');
    await new Promise((resolve, reject) => {
      peer.once('connect', resolve);
      peer.once('error', reject);
    });
    peer.write(
      frame({
        type: 'transfer-request',
        fileName: 'uji-dashboard.txt',
        fileSize: 2048,
        senderName: 'Peer-Uji',
        senderId: 'peer-uji',
        kind: 'file',
      })
    );
    await sleep(300);

    const incoming = (await get(`${base}/transfer/active`)).json || [];
    check('transfer/active: transfer masuk terlihat', incoming.length === 1, `${incoming.length} baris`);
    check(
      'transfer/active: arah terima + nama file + peer benar',
      incoming[0] &&
        incoming[0].direction === 'receive' &&
        incoming[0].fileName === 'uji-dashboard.txt' &&
        incoming[0].peer === 'Peer-Uji',
      JSON.stringify(incoming[0] || null)
    );
    check('transfer/active: masih menunggu konfirmasi', incoming[0] && incoming[0].status === 'pending');
    check(
      'transfer/active: bawa fileSize + bytesTransferred (buat hitung kecepatan & sisa waktu)',
      typeof incoming[0].fileSize === 'number' && typeof incoming[0].bytesTransferred === 'number',
      JSON.stringify({ fileSize: incoming[0].fileSize, bytesTransferred: incoming[0].bytesTransferred })
    );

    // 5c. Tombol Batal di kartu transfer = POST /transfer/cancel (role receive)
    const cancel = await fetch(`${base}/transfer/cancel/${incoming[0].requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'receive' }),
    });
    check('cancel transfer masuk dibalas 200', cancel.status === 200, `HTTP ${cancel.status}`);

    await sleep(300);
    const afterCancel = (await get(`${base}/transfer/active`)).json || [];
    check('setelah dibatalkan, kartu transfer aktif kosong lagi', afterCancel.length === 0, `${afterCancel.length} baris`);

    peer.destroy();

    // Log server harus mencatat kejadian di atas — itu gunanya dashboard.
    const logAfter = (await get(`${base}/logs?since=${first.lastId}`)).json || {};
    const newTexts = logAfter.lines.map((l) => l.text);
    check(
      'logs: kejadian tadi tercatat (transfer masuk + dibatalkan)',
      newTexts.some((t) => t.includes('uji-dashboard.txt')) && newTexts.some((t) => /dibatalkan/i.test(t)),
      newTexts.join(' | ').slice(0, 200)
    );

    // 6. Paritas DOM: tiap id yang dicari dashboard.js harus ada di HTML
    const jsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'dashboard.js'), 'utf-8');
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf-8');
    const jsIds = [...jsSrc.matchAll(/byId\('([^']+)'\)/g)].map((m) => m[1]);
    const htmlIds = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const missing = jsIds.filter((id) => !htmlIds.has(id));
    check('setiap id di dashboard.js ada di dashboard.html', missing.length === 0, missing.join(', ') || `${jsIds.length} id`);

    // 7. Aturan repo: tidak ada HTML dari string
    check(
      'dashboard.js tidak memakai innerHTML/insertAdjacentHTML',
      !/innerHTML|outerHTML|insertAdjacentHTML/.test(jsSrc)
    );

    // 8. Service worker: shell offline tetap URL root, /dashboard tidak di-cache
    const swSrc = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf-8');
    check('sw: hanya navigasi root yang mengisi shell', /const isShell = url\.pathname === '\/'/.test(swSrc));
    check(
      'sw: /dashboard & /logs tidak pernah di-cache',
      /NEVER_CACHE = \[[^\]]*'\/dashboard'/.test(swSrc) && /NEVER_CACHE = \[[^\]]*'\/logs'/.test(swSrc)
    );

    // 9. Terminal: diam secara default, ramai kalau diminta.
    // Server di atas dijalankan TANPA flag — stdout-nya sendiri jadi buktinya.
    const plain = logs.join('');
    check(
      'terminal: default cuma mencetak tanda "aktif" + alamat dashboard',
      /✅ LAN DROP aktif — dashboard: http:\/\/(localhost|127\.0\.0\.1):\d+\/dashboard/.test(plain) &&
        !/\[Server\] Port|📡|🔒/.test(plain),
      plain.split('\n').filter(Boolean).join(' | ') || '(kosong)'
    );
    check(
      'terminal: log tetap masuk dashboard walau terminal nyaris diam',
      first.lines.length > 0 && first.lines.some((l) => /LAN DROP aktif/.test(l.text)),
      `${first.lines.length} baris`
    );

    const dbgOut = await spawnProbe(['--debug']);
    check(
      'terminal: --debug mencetak banner lengkap (alamat, port, tailscale)',
      /\[Server\] Port .*listen di 0\.0\.0\.0/.test(dbgOut) && /LAN DROP aktif/.test(dbgOut),
      dbgOut.split('\n').filter(Boolean).length + ' baris'
    );

    const envOut = await spawnProbe([], { LANDROP_DEBUG: '1' });
    check(
      'terminal: LANDROP_DEBUG=1 sama seperti --debug',
      /\[Server\] Port .*listen di 0\.0\.0\.0/.test(envOut),
      envOut.split('\n').filter(Boolean).length + ' baris'
    );

    // Satu-satunya yang tetap keluar tanpa flag: kalau ada masalah. Diuji dengan
    // sengaja menabrakkan port HTTP ke server yang sedang jalan — sekarang itu
    // bukan lagi proses mati, server pindah ke port kosong di atasnya dan
    // perpindahan itu tetap tercetak tanpa perlu flag debug.
    const clashOut = await spawnProbe([], { PORT: String(PORT) });
    check(
      'terminal: port terpakai → pindah port otomatis & tetap tercetak tanpa flag',
      /sudah dipakai aplikasi lain/.test(clashOut) && /LAN DROP aktif/.test(clashOut),
      (clashOut.split('\n').find((l) => /sudah dipakai aplikasi lain/.test(l)) || '(tidak ada)').trim()
    );
  } finally {
    cleanup();
  }
}

main()
  .catch((err) => {
    failures++;
    console.error(`  FAIL  skrip error: ${err.stack || err.message}`);
  })
  .then(() => {
    console.log(
      failures === 0 ? '\nSemua pemeriksaan dashboard lolos.' : `\n${failures} pemeriksaan dashboard GAGAL.`
    );
    process.exitCode = failures === 0 ? 0 : 1;
  });
