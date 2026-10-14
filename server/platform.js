// ===================== Platform Detection =====================
// Mendeteksi environment runtime: Windows vs Termux (Android)

const os = require('os');
const path = require('path');

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

// ===================== LAN IP Selection =====================

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
function listLANIPv4() {
  const nets = os.networkInterfaces();
  const found = [];

  for (const name of Object.keys(nets)) {
    if (isVirtualIface(name)) continue;
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (isLinkLocalIPv4(net.address) || isPointToPoint(net)) continue;
      found.push({ name, address: net.address });
    }
  }

  return found.sort((a, b) => (isWifiIface(b.name) ? 1 : 0) - (isWifiIface(a.name) ? 1 : 0));
}

// Alamat LAN utama untuk advertise. Fallback 'localhost' kalau tidak ada
// interface yang bisa dipakai — pemanggil harus forgive nilai ini.
function getLANIP() {
  const ips = listLANIPv4();
  return ips.length > 0 ? ips[0].address : 'localhost';
}

module.exports = { isTermux, isWindows, getDataDir, getWindowsSaveDir, WINDOWS_SAVE_DIR, WINDOWS_SAVE_CATEGORIES, listLANIPv4, getLANIP, isLinkLocalIPv4, isPointToPoint };
