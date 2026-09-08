const { execFile } = require('child_process');

// ===================== Konstanta =====================
const CACHE_TTL = 10000; // ms — jangan spam `tailscale status` tiap announce cycle

// ===================== State =====================
let cachedPeers = [];
let cachedSelfIP = null;
let lastFetch = 0;
let tailscaleMissingWarned = false;

// ===================== Jalanin `tailscale status --json` =====================
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
    if (!tailscaleMissingWarned) {
      console.log('[Tailscale] CLI gak ketemu / tailscaled gak jalan — skip tailnet discovery');
      tailscaleMissingWarned = true;
    }
    cachedPeers = [];
    cachedSelfIP = null;
    return;
  }
  tailscaleMissingWarned = false;

  cachedSelfIP = pickIPv4(status.Self && status.Self.TailscaleIPs);

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

function getSelfTailscaleIP() {
  return cachedSelfIP;
}

module.exports = { refreshTailscaleState, getTailscalePeers, getSelfTailscaleIP };
