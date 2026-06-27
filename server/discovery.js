const dgram = require('dgram');
const os = require('os');

// ===================== Konstanta =====================
const DISCOVERY_PORT = 41234;
const BROADCAST_INTERVAL = 2000;
const DEVICE_TIMEOUT = 10000;
const CLEANUP_INTERVAL = 3000;

// ===================== Identitas Device =====================
const LAN_PORT = process.env.PORT || 3000;
const TRANSFER_PORT = parseInt(process.env.TRANSFER_PORT) || 3001;
const deviceId = `${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`;
const deviceName = os.hostname();

// ===================== State =====================
const knownDevices = new Map();
let broadcastInterval = null;
let cleanupInterval = null;
let sockets = [];

// ===================== Helper: Dapetin IP LAN =====================
function getLANIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal
        && !name.toLowerCase().includes('vmware')
        && !name.toLowerCase().includes('virtualbox')
        && !name.toLowerCase().includes('docker')
        && !name.toLowerCase().includes('vethernet')
        && !name.toLowerCase().includes('warp')) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// ===================== Broadcaster =====================
function startBroadcaster() {
  const sock = dgram.createSocket('udp4');
  const ip = getLANIP();
  const message = JSON.stringify({
    type: 'announce', deviceId, deviceName, ip, port: LAN_PORT, transferPort: TRANSFER_PORT
  });
  const buffer = Buffer.from(message);

  sock.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error('[Discovery] Broadcaster:', err.message);
  });

  // Bind ke random port, set broadcast, kirim tiap interval
  sock.bind(() => {
    sock.setBroadcast(true);
    sock.unref();
  });

  broadcastInterval = setInterval(() => {
    sock.send(buffer, 0, buffer.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
      if (err && err.code !== 'EADDRINUSE') console.error('[Discovery] Send error:', err.message);
    });
  }, BROADCAST_INTERVAL);

  sockets.push(sock);
  console.log(`[Discovery] Broadcasting as "${deviceName}" (${deviceId})`);
}

// ===================== Listener =====================
function startListener() {
  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.deviceId === deviceId) return;
      if (data.type !== 'announce') return;

      knownDevices.set(data.deviceId, {
        deviceName: data.deviceName,
        ip: data.ip,
        port: data.port,
        transferPort: data.transferPort || (data.port + 1),
        lastSeen: Date.now()
      });
    } catch (_) {}
  });

  sock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[Discovery] Port ${DISCOVERY_PORT} already in use (multiple instances?) — listener skipped`);
    } else {
      console.error('[Discovery] Listener error:', err.message);
    }
  });

  // Coba bind — kalo gagal (EADDRINUSE) biarin aja
  sock.bind(DISCOVERY_PORT, () => {
    console.log(`[Discovery] Listening for peers on port ${DISCOVERY_PORT}`);
  });

  sockets.push(sock);
}

// ===================== Cleanup Stale Devices =====================
function startCleanup() {
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, device] of knownDevices) {
      if (now - device.lastSeen > DEVICE_TIMEOUT) {
        console.log(`[Discovery] Device offline: ${device.deviceName} (${id})`);
        knownDevices.delete(id);
      }
    }
  }, CLEANUP_INTERVAL);

  cleanupInterval.unref();
}

// ===================== Public API =====================
function startDiscovery() {
  startBroadcaster();
  startListener();
  startCleanup();
}

function stopDiscovery() {
  if (broadcastInterval) clearInterval(broadcastInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  sockets.forEach(s => s.close());
  sockets = [];
}

function getDevices() {
  return Array.from(knownDevices.values());
}

module.exports = { startDiscovery, stopDiscovery, getDevices };
