const dgram = require('dgram');
const os = require('os');
const tailscale = require('./tailscale');

// ===================== Konstanta =====================
// Port UDP discovery. Bisa diubah lewat env supaya dua instance bisa jalan
// di satu host (mis. untuk pengujian) tanpa saling berebut listener.
const DISCOVERY_PORT = parseInt(process.env.DISCOVERY_PORT) || 41234;
const BROADCAST_INTERVAL = 2000;
const TAILSCALE_ANNOUNCE_INTERVAL = 3000;
const REPLY_DEDUPE_TTL = 5000; // jangan reply ke IP yang sama dalam 5 detik terakhir
const DEVICE_TIMEOUT = 10000;
const CLEANUP_INTERVAL = 3000;

// ===================== Identitas Device =====================
const LAN_PORT = process.env.PORT || 3000;
const TRANSFER_PORT = parseInt(process.env.TRANSFER_PORT) || 3001;
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname() || 'LAN-Device';
const deviceId = `${DEVICE_NAME}-${Math.random().toString(36).slice(2, 8)}`;
const deviceName = DEVICE_NAME;

// ===================== State =====================
const knownDevices = new Map();
const recentReplies = new Map(); // ip -> timestamp terakhir kita reply-back
let broadcastIntervals = []; // satu interval per interface LAN
let tailscaleInterval = null;
let cleanupInterval = null;
let sockets = [];
let tailscaleSock = null; // socket khusus buat unicast (announce ke peer & reply-back)

// ===================== Helper: Dapetin IP LAN =====================
// Dipindah ke platform.js supaya sinkron dengan index.js — sebelumnya
// dua duplikat bisa memilih IP berbeda untuk device yang sama.
const { getLANIP, listLANInterfaces } = require('./platform');

// ===================== Broadcaster =====================
// Broadcast dikirim PER INTERFACE, ke alamat broadcast interface itu
// (192.168.1.7 → 192.168.1.255), bukan ke 255.255.255.255.
//
// Kenapa: 255.255.255.255 pakai default route, dan kalau Tailscale/VPN
// mengambil alih default route, broadcast jadi gagal (EHOSTUNREACH) —
// peer di WiFi yang sama jadi tidak pernah ditemukan. Socket per
// interface (bind ke IP interface itu) memastikan paket keluar lewat
// interface yang benar.
function startBroadcaster() {
  const ip = getLANIP();
  const message = JSON.stringify({
    type: 'announce', deviceId, deviceName, ip, port: LAN_PORT, transferPort: TRANSFER_PORT
  });
  const buffer = Buffer.from(message);

  const interfaces = listLANInterfaces();
  if (interfaces.length === 0) {
    // Tidak ada interface LAN → broadcast global sebagai upaya terakhir.
    startBroadcastSocket(null, '255.255.255.255', buffer);
    return;
  }

  for (const iface of interfaces) {
    startBroadcastSocket(iface.address, iface.broadcast, buffer);
  }
}

function startBroadcastSocket(bindAddress, broadcastAddress, buffer) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
      console.error('[Discovery] Broadcaster:', err.message);
    }
  });

  const start = () => {
    sock.setBroadcast(true);
    sock.unref();

    const interval = setInterval(() => {
      sock.send(buffer, 0, buffer.length, DISCOVERY_PORT, broadcastAddress, (err) => {
        if (err && err.code !== 'EADDRINUSE' && err.code !== 'EHOSTUNREACH') {
          console.error('[Discovery] Send error:', err.message);
        }
      });
    }, BROADCAST_INTERVAL);
    broadcastIntervals.push(interval);
  };

  if (bindAddress) {
    sock.bind(bindAddress, start);
  } else {
    sock.bind(start);
  }

  sockets.push(sock);
  console.log(`[Discovery] Broadcasting as "${deviceName}" (${deviceId}) → ${broadcastAddress}`);
}

// ===================== Tailscale Unicast Announce =====================
// Broadcast UDP gak nembus tailnet (WireGuard mesh, bukan broadcast domain),
// jadi kita kirim paket announce yang sama tapi unicast ke tiap peer tailnet.
// `ip` di paket ini WAJIB IP tailscale sendiri — bukan LAN IP — soalnya
// peer tailnet cuma bisa connect balik lewat situ.
function buildTailscaleMessage(selfIP) {
  return Buffer.from(JSON.stringify({
    type: 'announce', deviceId, deviceName, ip: selfIP, port: LAN_PORT, transferPort: TRANSFER_PORT, via: 'tailscale'
  }));
}

function sendTailscaleAnnounceTo(ip) {
  const selfIP = tailscale.getSelfTailscaleIP();
  if (!selfIP || !tailscaleSock) return;
  const buffer = buildTailscaleMessage(selfIP);
  tailscaleSock.send(buffer, 0, buffer.length, DISCOVERY_PORT, ip, (err) => {
    if (err) console.error(`[Discovery] Tailscale send to ${ip} failed:`, err.message);
  });
}

function startTailscaleAnnounce() {
  tailscaleSock = dgram.createSocket('udp4');

  tailscaleSock.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error('[Discovery] Tailscale announcer:', err.message);
  });

  tailscaleSock.bind(() => tailscaleSock.unref());
  sockets.push(tailscaleSock);

  // Proaktif: kalau CLI `tailscale` ada di device ini, kirim announce ke
  // semua peer yang kekonfirmasi online. Device yang gak punya CLI (mis.
  // Android/Termux) bakal peers-nya kosong terus — gapapa, dia tetep bisa
  // KETEMU lewat reply-back di listener pas ada peer lain yang nyapa duluan.
  tailscaleInterval = setInterval(async () => {
    await tailscale.refreshTailscaleState();
    tailscale.getTailscalePeers().forEach(({ ip }) => sendTailscaleAnnounceTo(ip));
  }, TAILSCALE_ANNOUNCE_INTERVAL);

  console.log('[Discovery] Tailscale unicast announcer started');
}

// ===================== Listener =====================
function startListener() {
  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.deviceId === deviceId) return;
      if (data.type !== 'announce') return;

      knownDevices.set(data.deviceId, {
        deviceName: data.deviceName,
        ip: data.ip,
        port: data.port,
        transferPort: data.transferPort || (data.port + 1),
        via: data.via || 'lan',
        lastSeen: Date.now()
      });

      // Reply-back: kalau paket dateng dari alamat tailscale (CGNAT
      // 100.64.0.0/10), langsung balas announce kita juga ke situ. Ini bikin
      // device yang gak punya CLI `tailscale` (mis. Android/Termux) tetep
      // bisa KETEMU — asal ada peer lain yang proaktif nyapa duluan.
      if (tailscale.isTailscaleIPv4(rinfo.address)) {
        const lastReplied = recentReplies.get(rinfo.address) || 0;
        if (Date.now() - lastReplied > REPLY_DEDUPE_TTL) {
          recentReplies.set(rinfo.address, Date.now());
          sendTailscaleAnnounceTo(rinfo.address);
        }
      }
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
      // Peer statis (didaftarkan manual) tidak pernah expire.
      if (device.static) continue;
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
  startTailscaleAnnounce();
  startListener();
  startCleanup();
  seedStaticPeers();
}

/**
 * Peer statis lewat env `LANDROP_PEERS`.
 *
 * Format: "Nama@ip:port@transferPort,Nama2@ip:port@transferPort"
 *
 * Contoh: "Laptop@192.168.1.5:3000@3001"
 *
 * Berguna untuk dua hal:
 *   1. Jaringan yang memblokir UDP broadcast — peer bisa didaftarkan manual.
 *   2. Pengujian otomatis: dua instance di satu host tidak bisa saling
 *      menemukan lewat broadcast (satu listener UDP per port).
 *
 * Peer statis tidak pernah expire.
 */
function seedStaticPeers() {
  const raw = process.env.LANDROP_PEERS;
  if (!raw) return;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Nama@ip:port@transferPort → 3 bagian terpecah '@'
    const parts = trimmed.split('@');
    const namePart = parts[0];
    const addrPart = parts[1];
    const transferPortPart = parts[2];
    if (!namePart || !addrPart) continue;

    // Pisahkan ip dan port dari "ip:port"
    const colon = addrPart.lastIndexOf(':');
    if (colon === -1) continue;
    const ipPart = addrPart.slice(0, colon);
    const port = parseInt(addrPart.slice(colon + 1), 10) || 3000;
    if (!ipPart) continue;

    const transferPort = parseInt(transferPortPart, 10) || port + 1;

    knownDevices.set(`static-${ipPart}-${port}`, {
      deviceName: namePart,
      ip: ipPart,
      port,
      transferPort,
      via: 'lan',
      lastSeen: Date.now(),
      static: true,
    });

    console.log(`[Discovery] Peer statis terdaftar: ${namePart} (${ipPart}:${port}, transfer ${transferPort})`);
  }
}

function stopDiscovery() {
  broadcastIntervals.forEach(i => clearInterval(i));
  broadcastIntervals = [];
  if (tailscaleInterval) clearInterval(tailscaleInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  sockets.forEach(s => s.close());
  sockets = [];
  tailscaleSock = null;
  recentReplies.clear();
}

function getDevices() {
  return Array.from(knownDevices.values());
}

module.exports = { startDiscovery, stopDiscovery, getDevices };
