const { execFile } = require('child_process');
const os = require('os');

// ===================== Konstanta =====================
const CACHE_TTL = 10000; // ms — jangan spam `tailscale status` tiap announce cycle

// ===================== State =====================
let cachedPeers = [];
let lastFetch = 0;
let cliMissingWarned = false;

// Tailscale's IPv4 CGNAT range: 100.64.0.0 – 100.127.255.255
function isTailscaleIPv4(addr) {
  const parts = addr.split('.').map(Number);
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// ===================== IP tailscale sendiri — TANPA CLI =====================
// Gak semua platform punya `tailscale` CLI (misal Tailscale app resmi di
// Android/Termux cuma kasih VPN interface, gak ada binary CLI). Tapi begitu
// tailscaled/app-nya nyala, device SELALU dapet alamat CGNAT 100.64.0.0/10
// di salah satu network interface-nya — jadi cukup scan, gak perlu shell out.
function getSelfTailscaleIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && isTailscaleIPv4(net.address)) return net.address;
    }
  }
  return null;
}

// ===================== Peer list — best-effort lewat CLI =====================
// Ini opsional: device yang gak punya CLI (HP/Termux) gak bisa proaktif nyari
// peer duluan, tapi tetep BISA ditemuin lewat mekanisme reply-back di discovery.js.
function runTailscaleStatus() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch (_) {
        resolve(null);
      }
    });
  });
}

// ===================== Helper: pilih alamat IPv4 doang =====================
// TailscaleIPs isinya campur IPv4 (100.x.x.x) & IPv6 (fd7a:...) — socket kita
// udp4, jadi WAJIB filter yang IPv4 aja atau kirimnya bakal EINVAL.
function pickIPv4(ips) {
  return (ips || []).find((ip) => !ip.includes(':')) || null;
}

// ===================== Refresh cache (dipanggil tiap announce cycle, tapi throttled) =====================
async function refreshTailscaleState() {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL) return;
  lastFetch = now;

  const status = await runTailscaleStatus();
  if (!status) {
    if (!cliMissingWarned) {
      console.log('[Tailscale] CLI `tailscale` gak ketemu di device ini — gak bisa proaktif nyari peer, tapi tetep bisa DIKETEMUin peer lain lewat reply-back');
      cliMissingWarned = true;
    }
    cachedPeers = [];
    return;
  }
  cliMissingWarned = false;

  const peers = [];
  const peerMap = status.Peer || {};
  for (const key of Object.keys(peerMap)) {
    const p = peerMap[key];
    if (!p || !p.Online) continue;
    const ip = pickIPv4(p.TailscaleIPs);
    if (!ip) continue;
    peers.push({ ip, hostname: p.HostName || p.DNSName || 'tailnet-device' });
  }
  cachedPeers = peers;
}

function getTailscalePeers() {
  return cachedPeers;
}

module.exports = { refreshTailscaleState, getTailscalePeers, getSelfTailscaleIP, isTailscaleIPv4 };
