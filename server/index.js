const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const discovery = require('./discovery');
const transfer = require('./transfer');

// ===================== Multer Setup =====================
const uploadsDir = process.env.LANDROP_UPLOAD_DIR || path.join(__dirname, '..', 'uploads-temp');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ===================== Discovery Routes =====================

app.get('/me', (req, res) => {
  res.json({ deviceName: os.hostname() });
});

app.get('/devices', (req, res) => {
  const devices = discovery.getDevices();
  res.json(devices);
});

// ===================== Transfer Routes =====================

// POST /transfer/request — kirim permintaan transfer ke device lain
app.post('/transfer/request', (req, res) => {
  const { targetIp, targetPort, fileName, fileSize } = req.body;

  if (!targetIp || !targetPort || !fileName || fileSize === undefined) {
    return res.status(400).json({ error: 'Missing fields: targetIp, targetPort, fileName, fileSize' });
  }

  try {
    const result = transfer.sendTransferRequest(targetIp, parseInt(targetPort), {
      fileName,
      fileSize,
      senderName: os.hostname(),
      senderId: `${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`
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

// POST /transfer/send-file — mulai streaming file setelah accepted
app.post('/transfer/send-file', (req, res) => {
  const { requestId, filePath } = req.body;

  if (!requestId || !filePath) {
    return res.status(400).json({ error: 'Missing fields: requestId, filePath' });
  }

  try {
    const result = transfer.startFileSend(requestId, filePath);
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

// ===================== Upload Route (Hari 5) =====================

// POST /transfer/upload — terima file dari browser, simpan sementara
app.post('/transfer/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const filePath = path.resolve(req.file.path);
  res.json({
    filePath,
    fileName: req.file.originalname,
    fileSize: req.file.size
  });
});

// ===================== Server Startup =====================

function getLANIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal
        && !name.toLowerCase().includes('vmware')
        && !name.toLowerCase().includes('virtualbox')
        && !name.toLowerCase().includes('docker')
        && !name.toLowerCase().includes('vethernet')
        && !name.toLowerCase().includes('warp')) {
        ips.push({ name, address: net.address });
      }
    }
  }
  return ips;
}

const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = getLANIPs();
  console.log(`LAN DROP server — Express on http://localhost:${PORT}`);
  if (ips.length === 0) {
    console.log('⚠️  No LAN IP found — check your WiFi connection');
  } else {
    ips.forEach(({ name, address }) => {
      console.log(`📡 ${name} → http://${address}:${PORT}`);
    });
  }
  console.log();

  discovery.startDiscovery();
  transfer.startTransferServer();
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
