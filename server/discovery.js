const dgram = require('dgram');
const tailscale = require('./tailscale');

// Helper platform (IP LAN, nama device) — WAJIB di-require di atas karena
// dipakai untuk nilai konstanta di bawah.
const { getLANIP, listLANInterfaces, getDeviceName, isUsablePeerAddress } = require('./platform');

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
const DEVICE_NAME = getDeviceName();
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

// Diagnostik — dipakai endpoint /discovery/status supaya masalah
// "device gak pernah muncul" punya jawaban, bukan cuma gejalaptom kosong.
const broadcasterState = []; // { address, broadcast, bound, lastSentAt, lastError }
const listenerState = { port: DISCOVERY_PORT, bound: false, error: null };
let lastAnnounceAt = 0;
let selfIpMissingWarned = false;
const lastErrorLogAt = new Map(); // dedupe log error: "iface|kode" -> timestamp

// ===================== Helper: dapetin IP LAN =====================
// Dipindah ke platform.js supaya sinkron dengan index.js — sebelumnya
// dua duplikat bisa memilih IP berbeda untuk device yang sama.

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
    // Tidak ada interface LAN → tidak ada jalur LAN yang bisa disiarkan.
    // Bundle lama menyiarkan ip:'localhost' di sini, dan peer lalu menganggap
    // itu alamat yang bisa dihubungi — padahal itu mesinnya sendiri.
    console.warn('[Discovery] Tidak ada interface LAN — peer hanya bisa dijangkau lewat Tailscale');
    return;
  }

  for (const iface of interfaces) {
    startBroadcastSocket(iface.address, iface.broadcast, buffer);
  }
}

function startBroadcastSocket(bindAddress, broadcastAddress, buffer) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const state = {
    address: bindAddress,
    broadcast: broadcastAddress,
    bound: false,
    lastSentAt: 0,
    lastError: null,
  };
  broadcasterState.push(state);

  sock.on('error', (err) => {
    state.lastError = err.code || err.message;
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
      console.error('[Discovery] Broadcaster:', err.message);
    }
  });

  const start = () => {
    state.bound = true;
    sock.setBroadcast(true);
    sock.unref();

    const interval = setInterval(() => {
      state.lastSentAt = Date.now();
      sock.send(buffer, 0, buffer.length, DISCOVERY_PORT, broadcastAddress, (err) => {
        if (err) {
          state.lastError = err.code || err.message;
          // Log error broadcast DENGAN PENJELASAN — dulu diemkan, jadi user
          // cuma lihat "device gak muncul" tanpa tahu kenapa.
          logBroadcastError(state, err);
          return;
        }
        state.lastError = null;
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

/**
 * Log error broadcast dengan penjelasan + dedupe.
 *
 * Error yang sering muncul:
 *   EHOSTUNREACH — Tailscale/VPN mengambil alih default route
 *   EACCES       — firewall/izin soket
 *   ENETUNREACH  — interface mati
 *
 * Dedupe per (interface, kode): log pertama langsung, berikutnya max sekali
 * per menit — supaya log Termux tidak dibanjiri tiap 2 detik.
 */
function logBroadcastError(state, err) {
  const key = `${state.broadcast}|${state.lastError}`;
  const now = Date.now();
  const last = lastErrorLogAt.get(key) || 0;
  if (now - last < 60000) return;
  lastErrorLogAt.set(key, now);

  const hints = {
    EHOSTUNREACH: 'VPN/Tailscale ambil alih default route — broadcast LAN gagal',
    EACCES: 'firewall atau izin soket menolak broadcast',
    ENETUNREACH: 'interface LAN tidak aktif',
    EPERM: 'izin broadcast tidak diberikan di sistem',
  };
  const hint = hints[state.lastError] || 'broadcast gagal';

  console.warn(`[Discovery] Broadcast ke ${state.broadcast} gagal: ${state.lastError} — ${hint}`);
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
  if (!selfIP) {
    // Tidak tahu alamat tailnet sendiri → tidak ada yang bisa disiarkan
    // sebagai "alamatku" (menyiarkan alamat lain = bohong).
    if (!selfIpMissingWarned) {
      console.warn('[Discovery] Alamat Tailscale sendiri belum terdeteksi — belum bisa membalas peer via tailnet (HP: pastikan aplikasi Tailscale benar-benar connected)');
      selfIpMissingWarned = true;
    }
    return;
  }
  if (!tailscaleSock) return;
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

      // Jalur (LAN atau Tailscale) ditentukan dari ALAMAT SUMBER paket —
      // bukan dari field `via` di payload. Alamat sumber adalah satu-satunya
      // alamat yang dijamin bisa dihubungi balik lewat jalur tersebut.
      //
      // Pengecualian: kalau sumbernya loopback (peer di host yang sama —
      // contoh dua instance di satu mesin), hint `via` di payload dipakai.
      const source = normalizeAddress(rinfo.address);
      const payloadVia = data.via === 'tailscale' ? 'tailscale' : 'lan';
      const via = tailscale.isTailscaleIPv4(source)
        ? 'tailscale'
        : isLoopbackAddress(source)
          ? payloadVia
          : 'lan';

      // Alamat peer: pakai yang dipayload kalau layak, kalau tidak pakai
      // alamat sumber. Jadi `ip: 'localhost'` (HP tanpa interface LAN) tidak
      // pernah tersimpan sebagai alamat peer.
      const payloadIp = String(data.ip || '');
      const ip = isUsablePeerAddress(payloadIp) ? payloadIp : source;

      upsertPeer(data.deviceId, {
        deviceName: data.deviceName,
        ip,
        port: data.port,
        transferPort: data.transferPort,
        via,
      });
      lastAnnounceAt = Date.now();

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
    listenerState.error = err.code || err.message;
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Discovery] Port ${DISCOVERY_PORT} sudah dipakai instance lain — listener discovery DILEWATI. Peer hanya ketemu lewat LANDROP_PEERS atau unicast Tailscale.`);
    } else {
      console.error('[Discovery] Listener error:', err.message);
    }
  });

  // Coba bind — kalo gagal (EADDRINUSE) biarin aja
  sock.bind(DISCOVERY_PORT, () => {
    listenerState.bound = true;
    listenerState.error = null;
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
      deviceId: `static-${ipPart}-${port}`,
      deviceName: namePart,
      addresses: {
        lan: { ip: ipPart, port, transferPort },
      },
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

/**
 * Normalisasi alamat sumber paket (buang prefix IPv4-mapped IPv6).
 * @param {string} address
 * @returns {string}
 */
function normalizeAddress(address) {
  const value = String(address || '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped ? mapped[1] : value;
}

/**
 * Apakah alamat ini loopback (peer di host yang sama)?
 * @param {string} address
 * @returns {boolean}
 */
function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '::1' || value === '127.0.0.1' || /^127\./.test(value) || value.startsWith('::ffff:127.');
}

// ===================== Peer list =====================
// Satu peer bisa punya DUA alamat: LAN (192.168.x.x) dan Tailscale
// (100.x.x.x). Keduanya arrive lewat announce yang sama (deviceId sama),
// jadi kalau cuma disimpan sebagai satu field `ip`, yang terakhir datang
// menimpa yang sebelumnya — IP peer berubah-ubah tiap detik dan kiriman
// bisa lewat jalur yang tidak_expected.
//
// Jadi alamat disimpan TERPISAH per jalur, dan frontend memilih jalurnya
// sesuai link yang dipakai user (LAN atau Tailscale).
function upsertPeer(deviceId, info) {
  const existing = knownDevices.get(deviceId);
  const peer = existing || { deviceId, deviceName: info.deviceName, addresses: {} };
  if (info.deviceName) peer.deviceName = info.deviceName;

  const bucket = info.via === 'tailscale' ? 'tailscale' : 'lan';
  peer.addresses[bucket] = {
    ip: info.ip,
    port: info.port,
    transferPort: info.transferPort || (info.port + 1),
  };
  peer.lastSeen = Date.now();

  knownDevices.set(deviceId, peer);
  return peer;
}

/**
 * Daftar peer sesuai jalur yang diminta.
 *
 * @param {'lan'|'tailscale'|'local'} preferVia
 *   - 'lan' / 'tailscale' → pakai jalur itu, fallback ke yang lain
 *   - 'local' → dipakai saat aplikasi dibuka lewat localhost/127.x: alamat
 *     loopback cuma berarti "mesin ini", jadi peer lebih masuk akal dijangkau
 *     lewat Tailscale dulu (HP yang lagi di data seluler).
 */
function getDevices(preferVia) {
  const order = preferVia === 'tailscale'
    ? ['tailscale', 'lan']
    : preferVia === 'local'
      ? ['tailscale', 'lan']
      : ['lan', 'tailscale'];

  return Array.from(knownDevices.values()).map((peer) => {
    for (const bucket of order) {
      const addr = peer.addresses[bucket];
      if (!addr) continue;
      return {
        deviceName: peer.deviceName,
        ip: addr.ip,
        port: addr.port,
        transferPort: addr.transferPort,
        via: bucket,
        fallback: bucket !== order[0],
        lastSeen: peer.lastSeen,
      };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Status discovery untuk endpoint /discovery/status.
 *
 * Isinya HANYA status internal (tanpa path absolut, tanpa nama file, tanpa
 * stack trace) — kelas data yang sama dengan /devices + /me.
 *
 * @returns {Object}
 */
function getDiagnostics() {
  const interfaces = broadcasterState.map((s) => ({
    address: s.address,
    broadcast: s.broadcast,
    bound: s.bound,
    lastSentAt: s.lastSentAt,
    lastError: s.lastError,
  }));

  const ts = tailscale.getTailscaleInfo();

  return {
    ready: interfaces.some((i) => i.bound && !i.lastError)
      && (listenerState.bound || knownDevices.size > 0),
    interfaces,
    listener: {
      port: listenerState.port,
      bound: listenerState.bound,
      error: listenerState.error,
    },
    peers: {
      count: knownDevices.size,
      lastAnnounceAt,
    },
    tailscale: {
      selfIp: ts.selfIp,
      cliFound: ts.cliFound,
      peerCount: ts.peerCount,
    },
  };
}

module.exports = { startDiscovery, stopDiscovery, getDevices, getDiagnostics };
