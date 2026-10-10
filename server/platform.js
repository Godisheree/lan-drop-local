// ===================== Platform Detection =====================
// Mendeteksi environment runtime: Windows vs Termux (Android)

const os = require('os');

function isTermux() {
  // Termux selalu set PREFIX ke /data/data/com.termux/files/usr
  return !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux'));
}

function isWindows() {
  return process.platform === 'win32';
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

module.exports = { isTermux, isWindows, listLANIPv4, getLANIP, isLinkLocalIPv4, isPointToPoint };
