const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { isTailscaleIPv4 } = require('./platform');

// ===================== Konstanta =====================
const CACHE_TTL = 10000; // ms — jangan spam `tailscale status` tiap announce cycle

// ===================== State =====================
let cachedPeers = [];
let lastFetch = 0;
let cliMissingWarned = false;
let selfIp = null; // alamat Tailscale terakhir yang terdeteksi

// ===================== IP tailscale sendiri — TANPA CLI =====================
// Gak semua platform punya `tailscale` CLI (misal Tailscale app resmi di
// Android/Termux cuma kasih VPN interface, gak ada binary CLI). Tapi begitu
// tailscaled/app-nya nyala, device SELALU dapet alamat CGNAT 100.64.0.0/10
// di salah satu network interface-nya — jadi cukup scan, gak perlu shell out.
function getSelfTailscaleIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Node >= 18 balikin 'IPv4' (string), Node lama balikin 4 (number).
      // Termux sering masih pakai Node lama — dua-duanya harus kena.
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && isTailscaleIPv4(net.address)) return net.address;
    }
  }
  return null;
}

/**
 * Pantau alamat Tailscale sendiri, log begitu muncul / berubah.
 *
 * Kenapa perlu dipantau (bukan cuma dicetak saat startup): di Android/Termux
 * aplikasinya sering dinyalakan SETELAH server jalan, jadi log startup
 * sudah lewat. Dengan pemantau, alamat tetap muncul begitu Tailscale aktif.
 *
 * @returns {string|null} alamat Tailscale sekarang
 */
function watchSelfTailscaleIP() {
  const ip = getSelfTailscaleIP();
  if (ip === selfIp) return ip;

  if (ip) {
    console.log(`[Tailscale] Alamat Tailscale terdeteksi: ${ip} — device ini bisa dijangkau lewat tailnet (HP/Termux juga, tanpa CLI)`);
  } else if (selfIp) {
    console.log('[Tailscale] Alamat Tailscale hilang — Tailscale dimatikan atau belum terhubung');
  }
  selfIp = ip;
  return ip;
}

// ===================== Peer list — best-effort lewat CLI =====================
// Ini opsional: device yang gak punya CLI (HP/Termux) gak bisa proaktif nyari
// peer duluan, tapi tetep BISA ditemuin lewat mekanisme reply-back di discovery.js.

// Lokasi umum binary `tailscale`. Di Windows Tailscale memang terinstall
// ke "C:\Program Files\Tailscale" tapi TIDAK selalu ada di PATH — tanpa
// daftar ini, device yang Tailscale-nya aktif tetap dikira "CLI gak ada"
// padahal peer tailnet bisa ditemukan.
const TAILSCALE_CLI_CANDIDATES = [
  'tailscale',
  'tailscale.exe',
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Tailscale', 'tailscale.exe') : null,
  process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Tailscale', 'tailscale.exe') : null,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Tailscale', 'tailscale.exe') : null,
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/snap/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
].filter(Boolean);

let cachedCliPath = null; // null = belum dicek, false = tidak ada, string = path

/**
 * Cari binary `tailscale` (PATH + lokasi install umum).
 * @returns {Promise<string|null>}
 */
function findTailscaleCli() {
  if (cachedCliPath !== null) return Promise.resolve(cachedCliPath || null);

  return new Promise((resolve) => {
    let index = 0;
    (function tryNext() {
      if (index >= TAILSCALE_CLI_CANDIDATES.length) {
        cachedCliPath = false;
        return resolve(null);
      }
      const candidate = TAILSCALE_CLI_CANDIDATES[index++];
      execFile(candidate, ['version'], { timeout: 4000 }, (err) => {
        if (!err) {
          cachedCliPath = candidate;
          return resolve(candidate);
        }
        tryNext();
      });
    })();
  });
}

async function runTailscaleStatus() {
  const cli = await findTailscaleCli();
  if (!cli) return null;

  return new Promise((resolve) => {
    execFile(cli, ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
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
  // Pantau alamat sendiri dulu — jalan tiap siklus announce (3 detik),
  // bukan cuma saat server start. Ini yang bikin Tailscale di HP (Play Store
  // app, tanpa CLI) tetap terdeteksi walau nyala belakangan.
  watchSelfTailscaleIP();

  const now = Date.now();
  if (now - lastFetch < CACHE_TTL) return;
  lastFetch = now;

  const status = await runTailscaleStatus();
  if (!status) {
    if (!cliMissingWarned) {
      console.log('[Tailscale] CLI `tailscale` tidak ada di device ini (normal di Android/Termux) — tidak bisa proaktif mencari peer tailnet, tapi alamat sendiri tetap terdeteksi dan peer yang punya CLI tetap bisa menemukan kita lewat reply-back');
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

module.exports = { refreshTailscaleState, getTailscalePeers, getSelfTailscaleIP, watchSelfTailscaleIP, isTailscaleIPv4, findTailscaleCli };
