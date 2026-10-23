// ===================== Platform Detection =====================
// Mendeteksi environment runtime: Windows vs Termux (Android)

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function isTermux() {
  // Termux selalu set PREFIX ke /data/data/com.termux/files/usr
  return !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux'));
}

function isWindows() {
  return process.platform === 'win32';
}

// ===================== Data Dir (history, part-meta) =====================
// WAJIB di luar folder install (Program Files read-only untuk non-admin).
function getDataDir() {
  if (process.env.LANDROP_DATA_DIR) return process.env.LANDROP_DATA_DIR;
  if (isWindows()) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'lan-drop');
  }
  return path.join(os.homedir(), '.lan-drop');
}

// ===================== Save Dir (file diterima) =====================
// Windows: file masuk ke D:\LAN-DROP dengan subfolder per kategori:
//   Pictures (foto) · Videos · Documents · Music · sisanya di root.
// Bisa dioverride lewat env LANDROP_SAVE_DIR (langsung ke folder itu, flat).
const WINDOWS_SAVE_DIR = 'D:\\LAN-DROP';
const WINDOWS_SAVE_CATEGORIES = { photo: 'Pictures', video: 'Videos', doc: 'Documents', audio: 'Music' };

function getWindowsSaveDir(category) {
  if (process.env.LANDROP_SAVE_DIR) return process.env.LANDROP_SAVE_DIR;
  const sub = WINDOWS_SAVE_CATEGORIES[category];
  return sub ? path.join(WINDOWS_SAVE_DIR, sub) : WINDOWS_SAVE_DIR;
}

// ===================== Ruang Disk Folder Simpan =====================

/**
 * Folder tempat file diterima mendarat (sebelum dibagi per kategori).
 * @returns {string}
 */
function getSaveDirRoot() {
  return isTermux()
    ? path.join(os.homedir(), 'storage', 'pictures')
    : getWindowsSaveDir('photo');
}

/**
 * Ruang bebas (byte) di filesystem tempat file diterima mendarat.
 *
 * Semua subfolder kategori ada di filesystem yang sama, jadi satu probe cukup.
 * Kalau folder simpan tidak ada (drive D: belum terpasang), resolveSaveDir()
 * jatuh ke data dir — jadi data dir ikut diprobe sebelum menyerah.
 *
 * @returns {number|null} byte bebas, atau null kalau tidak bisa diukur.
 *   Pemanggil harus fail-closed (anggap tidak muat).
 */
function getSaveDirFreeSpace() {
  for (const target of [getSaveDirRoot(), getDataDir()]) {
    let probe = target;

    // Folder-nya mungkin belum ada — naik ke leluhur terdekat yang ada.
    while (probe && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      probe = parent === probe ? null : parent;
    }
    if (!probe) continue;

    try {
      const stat = fs.statfsSync(probe);
      return stat.bavail * stat.bsize;
    } catch (_) {
      // Coba kandidat berikutnya.
    }
  }

  return null;
}

// ===================== LAN IP Selection =====================

// Tailscale memberi device alamat CGNAT 100.64.0.0/10. Di Windows
// interface-nya bernama "Tailscale" (udah ke-filter di VIRTUAL_IFACE_HINTS),
// TAPI di Android aplikasi Tailscale dari Play Store bikin interface TUN
// bernama "tun0" — jadi HANYA bisa dikenali dari rentang alamatnya.
function isTailscaleIPv4(addr) {
  const parts = String(addr || '').split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// Interface yang bukan jalur LAN sesungguhnya. Nama lowercase, dicek substring.
const VIRTUAL_IFACE_HINTS = ['vmware', 'virtualbox', 'docker', 'vethernet', 'warp', 'tailscale'];

// Di Android, interface WiFi named wlan0/wlan1. VPN tunnel (tun0, wg0) sering
// urut lebih dulu di os.networkInterfaces() despite bukan jalur LAN.
const WIFI_IFACE_HINTS = ['wlan', 'wl'];

// 169.254.0.0/16 = link-local / APIPA (self-assigned, gak reachable device lain)
function isLinkLocalIPv4(addr) {
  const parts = addr.split('.').map(Number);
  return parts[0] === 169 && parts[1] === 254;
}

// Netmask /32 = point-to-point, ciri tunnel VPN (tun0, wg0, tap0). Address
// seperti ini hanya hidup di interface itu — peer di LAN tidak bisa
// menjangkau address tersebut, jadi advertise IP itu pasti TIMEOUT.
function isPointToPoint(net) {
  return net.netmask === '255.255.255.255';
}

function isVirtualIface(name) {
  const lower = name.toLowerCase();
  return VIRTUAL_IFACE_HINTS.some((hint) => lower.includes(hint));
}

function isWifiIface(name) {
  const lower = name.toLowerCase();
  return WIFI_IFACE_HINTS.some((hint) => lower.includes(hint));
}

// Semua IPv4 yang layak dipakai sebagai alamat peer LAN, sudah diurutkan:
// WiFi dulu, lalu interface lain. Index.js dipakai untuk log startup,
// discovery.js untuk broadcast — keduanya butuh urutan yang sama.
// Hitung alamat broadcast dari IP + netmask (192.168.1.7/24 → 192.168.1.255).
function computeBroadcastAddress(address, netmask) {
  if (!netmask) return '255.255.255.255';
  const ipParts = address.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);
  if (ipParts.length !== 4 || maskParts.length !== 4) return '255.255.255.255';
  return ipParts
    .map((octet, i) => (octet | (~maskParts[i] & 255)))
    .join('.');
}

// Semua interface LAN yang layak dipakai sebagai alamat peer, lengkap dengan
// netmask & alamat broadcast-nya. Index.js dipakai untuk log startup,
// discovery.js untuk broadcast per-interface.
function listLANInterfaces() {
  const nets = os.networkInterfaces();
  const found = [];

  for (const name of Object.keys(nets)) {
    if (isVirtualIface(name)) continue;
    for (const net of nets[name]) {
      // Node >= 18 balikin 'IPv4' (string), Node lama balikin 4 (number).
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (!isIPv4 || net.internal) continue;
      if (isLinkLocalIPv4(net.address) || isPointToPoint(net)) continue;
      // Alamat Tailscale (CGNAT) bukan alamat LAN — ditampilkan terpisah
      // di panel Sambung. Kalau ikut masuk sini, HP Android (interface
      // "tun0") bakal nampilin alamat Tailscale sebagai "Wi-Fi".
      if (isTailscaleIPv4(net.address)) continue;
      found.push({
        name,
        address: net.address,
        netmask: net.netmask,
        broadcast: computeBroadcastAddress(net.address, net.netmask),
      });
    }
  }

  // WiFi dulu, lalu interface lain.
  return found.sort((a, b) => (isWifiIface(b.name) ? 1 : 0) - (isWifiIface(a.name) ? 1 : 0));
}

// Semua IPv4 yang layak dipakai sebagai alamat peer LAN (urutan sama dengan
// listLANInterfaces).
function listLANIPv4() {
  return listLANInterfaces().map(({ name, address }) => ({ name, address }));
}

// Alamat LAN utama untuk advertise.
//
// PENTUM: kalau tidak ada interface LAN yang bisa dipakai (mis. HP cuma di
// data seluler + Tailscale), fungsi ini mengembalikan NULL — BUKAN string
// 'localhost'. Alasannya: 'localhost' pernah ikut tersiarkan di paket
// announce, lalu peer mengira itu alamat yang bisa dihubungi — padahal
// 'localhost' berarti "mesin ini sendiri" → kiriman mendarat di server
// pengirim, bukan di peer. Tidak ada alamat = tidak ada jalur LAN.
function getLANIP() {
  const ips = listLANIPv4();
  return ips.length > 0 ? ips[0].address : null;
}

/**
 * Semua alamat IP milik device ini (semua interface).
 * Dipakai untuk menolak peer yang menunjuk ke diri sendiri.
 * @returns {string[]}
 */
function getOwnAddresses() {
  const nets = os.networkInterfaces();
  const own = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal && net.address) own.push(net.address);
    }
  }
  return own;
}

/**
 * Apakah alamat ini layak dipakai sebagai alamat peer?
 *
 * Loopback (127.x / ::1) TIDAK layak: itu artinya "mesik ini sendiri".
 * Link-local (169.254/16) juga tidak — dipakai metadata cloud.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isUsablePeerAddress(ip) {
  const value = String(ip || '').trim();
  if (!value) return false;
  if (value === '0.0.0.0' || value === '::') return false;
  if (value === 'localhost' || value === 'localhost.localdomain') return false;
  if (isLinkLocalIPv4(value)) return false;

  // Loopback IPv4 / IPv6
  if (/^127\./.test(value)) return false;
  const lower = value.toLowerCase();
  if (lower === '::1' || lower === '[::1]') return false;
  if (lower.startsWith('::ffff:127.')) return false;

  return true;
}

// ===================== Device Name =====================
// Nama device yang muncul di UI dan di paket announce.
//
// Prioritas:
//   1. $DEVICE_NAME (kalau operator mau namain sendiri)
//   2. os.hostname() — di Windows/desktop ini sudah bagus ("DESKTOP-GK51EBL")
//   3. Android/Termux: hostname default-nya "localhost" (BEDA setiap device,
//      dan nggak informatif) → pakai model HP dari `getprop` ("OPPO A38")
const MAX_DEVICE_NAME_LENGTH = 40;

function detectAndroidModel() {
  try {
    const out = execFileSync('getprop', ['ro.product.model'], { timeout: 1500, encoding: 'utf8' });
    const model = String(out || '').trim();
    return model || null;
  } catch (_) {
    return null;
  }
}

/**
 * Bersihkan nama device: buang karakter kontrol, rapatkan spasi, potong panjang.
 * @param {string} value
 * @returns {string}
 */
function sanitizeDeviceName(value) {
  return String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH);
}

let cachedDeviceName = null;

/**
 * Resolusi nama device (fungsi murni — bisa diuji tanpa mengubah process).
 *
 * @param {Object} [options]
 * @param {string} [options.env] nilai $DEVICE_NAME
 * @param {string} [options.hostname] os.hostname()
 * @param {string} [options.model] model HP (dari getprop)
 * @returns {string}
 */
function resolveDeviceName(options = {}) {
  const env = options.env !== undefined ? options.env : process.env.DEVICE_NAME;
  const fromEnv = sanitizeDeviceName(env);
  if (fromEnv) return fromEnv;

  const host = sanitizeDeviceName(
    options.hostname !== undefined ? options.hostname : os.hostname()
  );
  if (host && host !== 'localhost' && host !== 'localhost.localdomain') return host;

  const model = sanitizeDeviceName(
    options.model !== undefined ? options.model : detectAndroidModel()
  );
  return model || 'Android';
}

function getDeviceName() {
  if (cachedDeviceName) return cachedDeviceName;
  cachedDeviceName = resolveDeviceName();
  return cachedDeviceName;
}

module.exports = { isTermux, isWindows, getDataDir, getWindowsSaveDir, getSaveDirRoot, getSaveDirFreeSpace, WINDOWS_SAVE_DIR, WINDOWS_SAVE_CATEGORIES, listLANIPv4, listLANInterfaces, getLANIP, getOwnAddresses, isUsablePeerAddress, getDeviceName, resolveDeviceName, sanitizeDeviceName, isLinkLocalIPv4, isPointToPoint, isTailscaleIPv4 };
