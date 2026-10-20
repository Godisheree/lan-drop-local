const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const discovery = require('./discovery');
const transfer = require('./transfer');
const tailscale = require('./tailscale');
const history = require('./history');
const thumbnail = require('./thumbnail');
const { listLANIPv4 } = require('./platform');

// Generate device name from hostname atau environment variable
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname() || 'LAN-Device';

// ===================== Multer Setup =====================
const uploadsDir = process.env.LANDROP_UPLOAD_DIR || path.join(__dirname, '..', 'uploads-temp');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
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

app.use(express.static(path.join(__dirname, '../public')));

// ===================== Discovery Routes =====================

// URL LAN yang bisa dipakai perangkat lain untuk membuka halaman ini.
// Dipakai panel "Sambung" di frontend untuk QR + teks salin.
function getLanUrls() {
  return listLANIPv4().map(({ name, address }) => ({
    ip: address,
    url: `http://${address}:${PORT}`,
    label: name,
  }));
}

app.get('/me', (req, res) => {
  res.json({ deviceName: DEVICE_NAME, urls: getLanUrls() });
});

app.get('/devices', (req, res) => {
  const devices = discovery.getDevices();
  res.json(devices);
});

// ===================== Transfer Routes =====================

// POST /transfer/request — kirim permintaan transfer ke device lain
app.post('/transfer/request', (req, res) => {
  const { targetIp, targetPort, fileName, fileSize, batchId, targetName } = req.body;

  if (!targetIp || !targetPort || !fileName || fileSize === undefined) {
    return res.status(400).json({ error: 'Missing fields: targetIp, targetPort, fileName, fileSize' });
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
app.post('/transfer/respond', (req, res) => {
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
app.post('/transfer/request-text', (req, res) => {
  const { targetIp, targetPort, fileName } = req.body;

  if (!targetIp || !targetPort || !fileName) {
    return res.status(400).json({ error: 'Missing fields: targetIp, targetPort, fileName' });
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
app.post('/transfer/cancel/:requestId', (req, res) => {
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
app.post('/transfer/send-text', async (req, res) => {
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
app.post('/transfer/send-file', async (req, res) => {
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
    const { getWindowsSaveDir } = require('./platform');
    const { isTermux } = require('./platform');

    // Folder tujuan: Windows pakai D:\LAN-DROP, Termux pakai shared storage,
    // sisanya data dir.
    let targetDir;
    if (isTermux()) {
      targetDir = path.join(os.homedir(), 'storage', 'pictures');
    } else {
      targetDir = getWindowsSaveDir('photo');
    }

    // Kalau foldernya belum ada, cek parent-nya.
    let probe = targetDir;
    while (probe && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }

    const stat = fs.statfsSync(probe);
    return res.json({
      free: stat.bavail * stat.bsize,
      total: stat.blocks * stat.bsize,
      path: targetDir,
    });
  } catch (err) {
    // Tidak bisa diukur (mis. filesystem virtual) — biarkan client yang
    // menentukan sendiri apakah perlu memeriksa.
    res.status(501).json({ error: 'Disk space unavailable' });
  }
});

// ===================== Upload Route (Hari 5) =====================

// POST /transfer/upload — terima file dari browser, simpan sementara
app.post('/transfer/upload', upload.array('file', 50), (req, res) => {
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

// ===================== History =====================

// GET /history — riwayat transfer (terbaru di depan)
app.get('/history', (req, res) => {
  res.json(history.list());
});

// POST /history/clear — hapus semua riwayat
app.post('/history/clear', (req, res) => {
  history.clear();
  res.json({ ok: true });
});

// ===================== Server Startup =====================

const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = listLANIPv4();
  console.log(`LAN DROP server — Express on http://localhost:${PORT}`);
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
  if (tsIP) console.log(`🔒 Tailscale → http://${tsIP}:${PORT}`);
  console.log();
});

// ===================== Graceful Shutdown =====================
function shutdown() {
  console.log('\n[Server] Shutting down...');
  discovery.stopDiscovery();
  transfer.stopTransferServer();
  server.close(() => {
    console.log('[Server] Stopped.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
