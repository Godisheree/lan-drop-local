// Paling atas, sebelum require lain: logbus membajak console.* supaya log
// startup modul-modul lain (discovery, transfer, tailscale) ikut terekam dan
// bisa dibaca ulang lewat GET /logs.
const logbus = require('./logbus');
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const discovery = require('./discovery');
const transfer = require('./transfer');
const tailscale = require('./tailscale');
const history = require('./history');
const settings = require('./settings');
const thumbnail = require('./thumbnail');
const { securityHeaders, rateLimit, sameOriginGuard, isAllowedTargetIp, isSelfTarget } = require('./security');
const { listLANIPv4, getDeviceName, getDataDir, getSaveDirRoot } = require('./platform');

// Generate device name dari hostname atau environment variable
const DEVICE_NAME = getDeviceName();

// ===================== Multer Setup =====================
const uploadsDir = process.env.LANDROP_UPLOAD_DIR || path.join(__dirname, '..', 'uploads-temp');
fs.mkdirSync(uploadsDir, { recursive: true });

// Batas ukuran upload default 2 GB (file video besar masih muat).
// Override: LANDROP_MAX_UPLOAD_MB=<angka>
const MAX_UPLOAD_MB = parseInt(process.env.LANDROP_MAX_UPLOAD_MB, 10) || 2048;

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 50,
    fields: 20,
    parts: 60,
  },
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
//
// Urutan penting: header keamanan & origin guard DULUAN, baru parser body.
// Kalau parser body yang pertama, request dengan JSON rusak dibalas HTML
// bawaan Express yang berisi stack trace + path absolut (bocor info).
app.use(securityHeaders);
app.use(sameOriginGuard);
app.use(express.json());

// Manifest & service worker butuh Content-Type & Cache-Control khusus.
// Diletakkan SEBELUM express.static supaya header-nya kita kendalikan.
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../public/manifest.webmanifest'));
});

app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  // no-cache supaya versi baru service worker cepat diterima browser.
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});

// Dashboard monitoring — halaman terpisah dari UI utama.
//
// UI utama dipakai dari HP buat kirim file (tombol besar, satu tangan);
// halaman ini dipakai dari layar lebar buat mantau (tabel padat, log live).
// Dipisah supaya shell PWA di HP tidak ikut mengangkut halaman admin.
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

// ===================== Discovery Routes =====================

// URL yang bisa dipakai perangkat lain untuk membuka halaman ini.
// Dipakai panel "Sambung" di frontend untuk QR + teks salin.
//
// Dua jenis alamat:
//   - LAN (Wi-Fi)  : hanya bisa dijangkau perangkat di WiFi yang sama.
//                     Nol setup — asalannya ("buka URL yang sama").
//   - Tailscale     : alamat CGNAT 100.64.0.0/10, bisa dijangkau dari
//                     mana saja selama perangkat lain ada di tailnet yang
//                     sama (HP di data seluler, laptop di kantor, dll).
//
// Keduanya ditampilkan, user yang memilih. Tailscale TIDAK ikut
// listLANIPv4() (interface-nya difilter sebagai virtual), jadi tidak
// mungkin dobel.
function getLanUrls() {
  const urls = listLANIPv4().map(({ name, address }) => ({
    ip: address,
    url: `http://${address}:${PORT}`,
    label: name,
    via: 'lan',
  }));

  const tsIP = tailscale.getSelfTailscaleIP();
  if (tsIP) {
    urls.push({
      ip: tsIP,
      url: `http://${tsIP}:${PORT}`,
      label: 'Tailscale',
      via: 'tailscale',
    });
  }

  return urls;
}

app.get('/me', (req, res) => {
  res.json({ deviceName: DEVICE_NAME, urls: getLanUrls() });
});

// GET /discovery/status — status intern discovery (read-only).
//
// Tujuannya: "device gak pernah muncul" harus punya jawaban yang jelas.
// Isinya HANYA status (tanpa path absolut, tanpa stack trace) — kelas data
// yang sama dengan /devices + /me.
app.get('/discovery/status', (req, res) => {
  res.json({
    deviceName: DEVICE_NAME,
    ...discovery.getDiagnostics(),
  });
});

// Commit yang sedang dijalankan, dibaca langsung dari .git (tanpa shell-out).
// Null kalau bukan repo git (mis. hasil build Electron/NSIS) — dashboard
// menampilkannya sebagai "—".
//
// Kenapa berguna: instance yang sudah jalan memakai kode saat dia di-start,
// jadi server lama bikin bug yang sudah difix kelihatan belum difix.
function readCommit() {
  try {
    const gitDir = path.join(__dirname, '..', '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);

    const refPath = path.join(gitDir, ...head.slice(4).trim().split('/'));
    return fs.readFileSync(refPath, 'utf-8').trim().slice(0, 7);
  } catch (_) {
    return null;
  }
}

// GET /status — identitas proses server (read-only).
app.get('/status', (req, res) => {
  let version = '';
  try {
    version = require('../package.json').version;
  } catch (_) {}

  const uptimeSeconds = Math.round(process.uptime());

  res.json({
    deviceName: DEVICE_NAME,
    version,
    commit: readCommit(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    uptimeSeconds,
    startedAt: Date.now() - uptimeSeconds * 1000,
    port: Number(PORT),
    transferPort: transfer.TRANSFER_PORT,
    discoveryPort: discovery.getDiagnostics().listener.port,
    saveDir: getSaveDirRoot(),
    dataDir: getDataDir(),
  });
});

// GET /logs?since=<id> — log server terakhir (ring buffer, read-only).
//
// `since` = id terakhir yang sudah dimiliki klien, jadi polling cukup
// mengirim baris baru — bukan 300 baris berulang tiap 2 detik.
app.get('/logs', (req, res) => {
  res.json(logbus.tail(parseInt(req.query.since, 10) || 0));
});

// GET /transfer/active — transfer yang sedang berjalan (kirim & terima).
app.get('/transfer/active', (req, res) => {
  res.json(transfer.getActiveTransfers());
});

// GET /devices — daftar peer.
//
// `?via=lan|tailscale` memilih jalur alamat yang dipakai: kalau user buka
// aplikasi lewat link Tailscale, peer juga dijangkau lewat Tailscale.
// Tanpa parameter ini, jalur LAN yang dipakai.
app.get('/devices', (req, res) => {
  res.json(discovery.getDevices(req.query.via));
});

// ===================== Transfer Routes =====================

// Rate limit untuk endpoint yang mengubah state / transferring data.
// Device di LAN yang normal cuma polling ringan, jadi batasnya longgar
// (1200 request / menit per IP) — cukup buat banyak batch file beruntun
// (1 batch 50 file ≈ 100 POST) tanpa nabrak limit.
const transferLimiter = rateLimit({ windowMs: 60 * 1000, max: 1200 });

// Endpoint destruktif (hapus riwayat) — batas lebih ketat.
const destructiveLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

// POST /transfer/request — kirim permintaan transfer ke device lain
app.post('/transfer/request', transferLimiter, (req, res) => {
  const { targetIp, targetPort, fileName, fileSize, batchId, targetName } = req.body;

  if (!targetIp || !targetPort || !fileName || fileSize === undefined) {
    return res.status(400).json({ error: 'Missing fields: targetIp, targetPort, fileName, fileSize' });
  }

  // Cuma boleh menghubungi peer di LAN/Tailscale. Tanpa ini, endpoint ini
  // jadi SSRF: server bisa dipaksa buka koneksi ke host mana saja
  // (mis. metadata cloud) atas nama device lain.
  if (!isAllowedTargetIp(targetIp)) {
    return res.status(400).json({ error: 'Target IP ditolak: hanya alamat LAN/Tailscale yang diizinkan' });
  }

  if (isSelfTarget(targetIp)) {
    return res.status(400).json({ error: 'Target menunjuk ke perangkat ini sendiri — peer tidak ditemukan?' });
  }

  try {
    const result = transfer.sendTransferRequest(targetIp, parseInt(targetPort), {
      fileName,
      fileSize,
      batchId, // optional: grouping request multi-file
      peerName: targetName, // untuk history
      senderName: DEVICE_NAME,
      senderId: `${DEVICE_NAME}-${Math.random().toString(36).slice(2, 8)}`
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /transfer/pending — cek request masuk
app.get('/transfer/pending', (req, res) => {
  res.json(transfer.getPendingRequests());
});

// POST /transfer/respond — accept/reject request
app.post('/transfer/respond', transferLimiter, (req, res) => {
  const { requestId, accept } = req.body;

  if (!requestId || accept === undefined) {
    return res.status(400).json({ error: 'Missing fields: requestId, accept' });
  }

  try {
    const result = transfer.respondToRequest(requestId, accept);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /transfer/status/:requestId — cek status request yg dikirim
app.get('/transfer/status/:requestId', (req, res) => {
  const status = transfer.getRequestStatus(req.params.requestId);
  if (!status) {
    return res.status(404).json({ error: 'Request not found' });
  }
  res.json(status);
});

// ===================== Hari 4 — Streaming Endpoints =====================

// POST /transfer/request-text — kirim permintaan transfer teks
app.post('/transfer/request-text', transferLimiter, (req, res) => {
  const { targetIp, targetPort, fileName } = req.body;

  if (!targetIp || !targetPort || !fileName) {
    return res.status(400).json({ error: 'Missing fields: targetIp, targetPort, fileName' });
  }

  if (!isAllowedTargetIp(targetIp)) {
    return res.status(400).json({ error: 'Target IP ditolak: hanya alamat LAN/Tailscale yang diizinkan' });
  }

  if (isSelfTarget(targetIp)) {
    return res.status(400).json({ error: 'Target menunjuk ke perangkat ini sendiri — peer tidak ditemukan?' });
  }

  try {
    const result = transfer.sendTransferRequest(targetIp, parseInt(targetPort), {
      fileName,
      fileSize: 0,
      kind: 'text',
      senderName: DEVICE_NAME,
      senderId: `${DEVICE_NAME}-${Math.random().toString(36).slice(2, 8)}`
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /transfer/cancel/:requestId — batalin transfer (sisi pengirim 'send' / penerima 'receive')
app.post('/transfer/cancel/:requestId', transferLimiter, (req, res) => {
  const { requestId } = req.params;
  const { role } = req.body; // 'send' atau 'receive'
  try {
    if (role === 'receive') {
      transfer.cancelIncomingTransfer(requestId);
    } else {
      transfer.cancelOutgoingTransfer(requestId);
    }
    res.json({ requestId, status: 'cancelled' });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /transfer/send-text — kirim isi teks setelah accepted
app.post('/transfer/send-text', transferLimiter, async (req, res) => {
  const { requestId, text } = req.body;

  if (!requestId || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing fields: requestId, text' });
  }

  try {
    const result = await transfer.startTextSend(requestId, text);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /transfer/text — polling teks masuk (langsung dihapus setelah diambil)
app.get('/transfer/text', (req, res) => {
  res.json(transfer.getReceivedTexts());
});

// POST /transfer/text/:id/ack — tandai teks selesai ditampilkan, hapus dari queue
app.post('/transfer/text/:id/ack', (req, res) => {
  const removed = transfer.consumeReceivedText(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Text not found' });
  res.json({ ok: true });
});

// POST /transfer/send-file — mulai streaming file setelah accepted
app.post('/transfer/send-file', transferLimiter, async (req, res) => {
  const { requestId, filePath } = req.body;

  if (!requestId || !filePath) {
    return res.status(400).json({ error: 'Missing fields: requestId, filePath' });
  }

  try {
    const result = await transfer.startFileSend(requestId, filePath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /transfer/progress/:requestId — polling progress transfer
app.get('/transfer/progress/:requestId', (req, res) => {
  const progress = transfer.getTransferProgress(req.params.requestId);
  if (!progress) {
    return res.status(404).json({ error: 'Progress not found' });
  }
  res.json(progress);
});

// GET /thumbnail/:id — thumbnail foto/video dari file yang sudah diterima.
//
// Path file TIDAK pernah datang dari URL: id dipetakan server ke daftar
// file yang sudah dia terima. Jadi tidak ada path traversal.
app.get('/thumbnail/:id', async (req, res) => {
  const id = String(req.params.id || '');

  // Id harus hex 16 karakter — tolak yang lain tanpa menyentuh filesystem.
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid thumbnail id' });
  }

  try {
    const result = await thumbnail.getThumbnailById(id);
    if (!result) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(result.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /system/disk — ruang disk bebas di folder simpan.
//
// Dipakai receiver untuk menolak file besar yang tidak muat, dengan pesan
// yang jelas — lebih baik ditolak di awal daripada gagal di tengah transfer.
app.get('/system/disk', (req, res) => {
  try {
    const { getSaveDirRoot, getSaveDirFreeSpace } = require('./platform');

    const targetDir = getSaveDirRoot();
    const free = getSaveDirFreeSpace();
    if (free === null) throw new Error('unavailable');

    return res.json({ free, total: null, path: targetDir });
  } catch (err) {
    // Tidak bisa diukur (mis. filesystem virtual) — biarkan client yang
    // menentukan sendiri apakah perlu memeriksa.
    res.status(501).json({ error: 'Disk space unavailable' });
  }
});

// ===================== Upload Route (Hari 5) =====================

// POST /transfer/upload — terima file dari browser, simpan sementara
app.post('/transfer/upload', transferLimiter, upload.array('file', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const files = req.files.map(f => ({
    filePath: path.resolve(f.path),
    fileName: f.originalname,
    fileSize: f.size
  }));
  res.json({ files });
});

// ===================== Settings =====================

// GET /settings/auto-approve — status terima otomatis
app.get('/settings/auto-approve', (req, res) => {
  res.json(settings.getAutoApprove());
});

// POST /settings/auto-approve — nyalain/matiin terima otomatis
//
// Dilindungi sameOriginGuard (middleware global): POST lintas-origin dari
// halaman web lain ditolak, jadi halaman asing tidak bisa menyalakan mode
// ini dari browser orang lain.
app.post('/settings/auto-approve', transferLimiter, (req, res) => {
  const { enabled, peers } = req.body || {};

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Field "enabled" harus boolean' });
  }
  if (peers !== undefined && !Array.isArray(peers)) {
    return res.status(400).json({ error: 'Field "peers" harus array nama perangkat' });
  }

  res.json(settings.setAutoApprove({ enabled, peers }));
});

// ===================== History =====================

// GET /history — riwayat transfer (terbaru di depan)
app.get('/history', (req, res) => {
  res.json(history.list());
});

// POST /history/clear — hapus semua riwayat
app.post('/history/clear', destructiveLimiter, (req, res) => {
  history.clear();
  res.json({ ok: true });
});

// ===================== Global Error Handler =====================
// Handler global (HARUS 4 argumen, di Registered TERAKHIR) supaya SEMUA
// error — dari route mana pun — dibalas JSON yang bersih.
//
// Tanpa ini, Express balas HTML bawaan yang isinya stack trace + path
// absolut: itu bocor struktur folder server ke siapa pun yang bisa njangkau
// port HTTP.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Batas multer
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File melebihi batas ${MAX_UPLOAD_MB} MB` });
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FIELD_COUNT') {
    return res.status(413).json({ error: 'Jumlah file/part melebihi batas yang diizinkan' });
  }

  // Body JSON rusak / terlalu besar
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Format JSON tidak valid' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request terlalu besar' });
  }

  // Error lain: log di server, balas pesan generik (tanpa detail internal).
  console.error(`[Server] ${req.method} ${req.originalUrl} — ${err.message}`);
  res.status(500).json({ error: 'Terjadi kesalahan di server' });
});

// ===================== Server Startup =====================

const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = listLANIPv4();
  console.log(`LAN DROP server — Express on http://localhost:${PORT}`);
  console.log(`[Server] Nama perangkat: ${DEVICE_NAME}` + (
    process.env.DEVICE_NAME ? '' : '  (ubah dengan DEVICE_NAME="nama kamu" untuk menamain sendiri)'
  ));
  if (ips.length === 0) {
    console.log('⚠️  No LAN IP found — check your WiFi connection');
  } else {
    ips.forEach(({ name, address }) => {
      console.log(`📡 ${name} → http://${address}:${PORT}`);
    });
  }

  discovery.startDiscovery();
  transfer.startTransferServer();

  const tsIP = tailscale.getSelfTailscaleIP();
  if (tsIP) {
    console.log(`🔒 Tailscale → http://${tsIP}:${PORT}`);
  } else {
    console.log('🔒 Tailscale belum terdeteksi — nyalakan Tailscale dulu (HP: aplikasi Play Store juga bisa). Kalau aktif belakangan, alamatnya muncul otomatis di log ini.');
  }

  console.log(`[Server] Port ${PORT} (HTTP) & ${transfer.TRANSFER_PORT} (transfer) listen di 0.0.0.0 — device lain di jaringan yang sama bisa menghubungi`);
  console.log('[Server] Device kedua harus menjalankan LAN DROP-nya sendiri supaya dua arah (kirim & terima)');

  // Satu-satunya baris yang tetap tercetak saat log sedang diam: tanda "sudah
  // aktif" + alamat dashboard-nya. Ditaruh paling akhir supaya artinya benar —
  // semua listener sudah jalan saat baris ini keluar.
  const otherAddr = (ips[0] && ips[0].address) || tsIP;
  logbus.notice(
    `✅ LAN DROP aktif — dashboard: http://localhost:${PORT}/dashboard` +
      (otherAddr ? `  •  dari perangkat lain: http://${otherAddr}:${PORT}/dashboard` : '')
  );
});

// ===================== Graceful Shutdown =====================
function shutdown() {
  console.log('\n[Server] Shutting down...');
  discovery.stopDiscovery();
  transfer.stopTransferServer();
  // Tulis apa pun yang masih menunggu di timer debounce (riwayat). Setting
  // auto-approve sudah ditulis begitu diubah — tidak ada yang menggantung.
  try {
    history.flushNow();
  } catch (_) {}
  server.close(() => {
    console.log('[Server] Stopped.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
