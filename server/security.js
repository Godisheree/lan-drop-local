/**
 * Lapisan keamanan HTTP untuk LAN DROP.
 *
 * Semua helper di file ini stateless kecuali rate limiter (in-memory Map)
 * dan sengaja TIDAK menambah dependency baru — app ini jualan "no setup",
 * jadi tiap dependency baru = satu langkah instalasi lebih.
 *
 * Catatan penting: LAN DROP tidak punya autentikasi (semua endpoint terbuka
 * buat pasangan di jaringan yang sama — itu memang desain "zero setup").
 * Kontrol di sini bukan pengganti autentikasi, tapi menutup jalur abuse yang
 * paling murah dieksploitasi: header yang hilang, request yang di-flood,
 * dan POST lintas-origin dari halaman web lain.
 */

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_REQUESTS = 120;

// ===================== Security Headers =====================

/**
 * Header keamanan dasar untuk semua response.
 *
 * CSP di sini aman karena frontend sama sekali gak pakai inline script
 * (index.html cuma memuat js/vendor/qrcode.js + js/main.js). 'unsafe-inline'
 * di style-src dipakai buat style yang diset runtime lewat JS.
 */
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
}

// ===================== Rate Limit =====================

/**
 * Rate limiter sederhana (fixed window per IP, in-memory).
 *
 * Cukup untuk menahan flood dari satu host di LAN. Kalau butuh limit
 * terdistribusi (multi-instance), ganti dengan store bersama.
 *
 * @param {Object} [options]
 * @param {number} [options.windowMs=60000] panjang window
 * @param {number} [options.max=120] jumlah request per window per IP
 * @param {string} [options.message] pesan error 429
 * @returns {import('express').RequestHandler}
 */
function rateLimit(options = {}) {
  const {
    windowMs = DEFAULT_WINDOW_MS,
    max = DEFAULT_MAX_REQUESTS,
    message = 'Terlalu banyak permintaan. Coba lagi sebentar.',
  } = options;

  const hits = new Map(); // ip -> { count, resetAt }

  // Bersihin entry kadaluwarsa supaya Map gak tumbuh tanpa batas.
  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, windowMs);
  if (typeof cleaner.unref === 'function') cleaner.unref();

  return function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();

    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// ===================== Origin Guard (anti-CSRF sederhana) =====================

/**
 * Tolak request yang datang dari origin lain.
 *
 * Browser ngirim header Origin untuk POST lintas-origin. Kalau Origin !=
 * Host, berarti halaman web lain yang memanggil API LAN DROP — misalnya
 * halaman berita yang diam-diam nge-hapus riwayat transfer.
 *
 * Request tanpa header Origin (curl, native app, script) tetap lewat:
 * guard ini bukan autentikasi, dia cuma menutup jalur CSRF dari browser.
 */
function sameOriginGuard(req, res, next) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const origin = req.get('origin');
  if (!origin) return next(); // bukan request dari browser

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (_) {
    return res.status(403).json({ error: 'Forbidden: origin tidak valid' });
  }

  const host = req.get('host');
  if (originHost !== host) {
    return res.status(403).json({ error: 'Forbidden: cross-origin request ditolak' });
  }
  next();
}

// ===================== Validasi Target IP =====================

const net = require('net');

// CGNAT 100.64.0.0/10 — dipakai Tailscale.
const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

// Link-local 169.254.0.0/16 — dipakai cloud metadata (169.254.169.254).
// Bukan target peer yang wajar, jadi diblokir seluruhnya.
const LINK_LOCAL_IPV4 = /^169\.254\./;

/**
 * Hostname yang diizinkan hanya kalau operator daftarkan sendiri lewat
 * `LANDROP_PEERS` (format "Nama@ip:port@transferPort").
 *
 * Kenapa hostname mentah tidak boleh: nama kayak "metadata.google.internal"
 * atau "evil.example" bisa diselundupkan lewat paket announce UDP palsu,
 * lalu server membuka koneksi ke sana = SSRF. Jadi hostname harus datang
 * dari config yang dipercaya (env), bukan dari jaringan.
 */
function trustedPeerHostnames() {
  const raw = process.env.LANDROP_PEERS;
  if (!raw) return new Set();

  const trusted = new Set();
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split('@');
    const addrPart = parts[1];
    if (!addrPart) continue;
    const colon = addrPart.lastIndexOf(':');
    const host = colon === -1 ? addrPart : addrPart.slice(0, colon);
    if (host && net.isIP(host) === 0) trusted.add(host.toLowerCase());
  }
  return trusted;
}

/**
 * IPv4 yang boleh dihubungi: LAN privat, loopback, atau CGNAT Tailscale.
 * @param {string} addr
 * @returns {boolean}
 */
function isAllowedIPv4(addr) {
  if (LINK_LOCAL_IPV4.test(addr)) return false; // metadata cloud — selalu tolak
  return PRIVATE_IPV4.some((re) => re.test(addr));
}

/**
 * IPv6 yang boleh dihubungi: loopback (::1), unique-local (fc00::/7,
 * termasuk fd7a: = Tailscale), dan link-local (fe80::/10).
 * @param {string} addr
 * @returns {boolean}
 */
function isAllowedIPv6(addr) {
  // IPv4-mapped (::ffff:192.168.1.5) → perlakukan sebagai IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return isAllowedIPv4(mapped[1]);

  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;

  const first = lower.split(':')[0];
  const hextet = parseInt(first, 16);
  if (!Number.isFinite(hextet)) return false;

  if ((hextet & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique-local)
  if ((hextet & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

/**
 * Cek apakah target peer boleh dihubungi.
 *
 * Default: HANYA alamat IP LAN/Tailscale (private, loopback, CGNAT). Ini
 * menutup SSRF ke metadata cloud (169.254.169.254) dan ke host publik
 * yang gak ada hubungannya dengan LAN.
 *
 * Hostname hanya boleh kalau operator daftarkan lewat LANDROP_PEERS —
 * nama dari jaringan (mis. hasil paket announce) ditolak, karena bisa
 * diarahkan ke host apa saja.
 *
 * Kalau memang perlu peer di luar (port-forward, VPN custom), set
 * LANDROP_ALLOW_PUBLIC_TARGETS=1.
 *
 * @param {string} targetIp
 * @returns {boolean}
 */
function isAllowedTargetIp(targetIp) {
  const value = String(targetIp || '').trim();
  if (!value) return false;

  if (process.env.LANDROP_ALLOW_PUBLIC_TARGETS === '1') return true;

  // Buang kurung siku IPv6 (mis. "[::1]")
  let addr = value;
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);

  const family = net.isIP(addr);
  if (family === 4) return isAllowedIPv4(addr);
  if (family === 6) return isAllowedIPv6(addr);

  // Bukan IP literal → hanya kalau ada di LANDROP_PEERS.
  return trustedPeerHostnames().has(addr.toLowerCase());
}

/**
 * Apakah target menunjuk ke perangkat ini sendiri?
 *
 * Peer yang alamatnya 'localhost'/127.x berarti "mesin ini" — kiriman akan
 * mendarat di server pengirim, bukan di peer (bug nyata: user mengira
 * "kirimnya nyasar"). Lebih baik ditolak dengan pesan jelas.
 *
 * Escape hatch: LANDROP_ALLOW_SELF_TARGET=1 (dipakai scripts/e2e.js &
 * scripts/check-routes.js yang menjalankan dua instance di 127.0.0.1).
 *
 * @param {string} targetIp
 * @returns {boolean}
 */
function isSelfTarget(targetIp) {
  if (process.env.LANDROP_ALLOW_SELF_TARGET === '1') return false;

  const value = String(targetIp || '').trim().toLowerCase();
  if (!value) return false;
  if (value === 'localhost' || value === 'localhost.localdomain') return true;
  if (value === '::1' || value === '[::1]') return true;
  if (/^127\./.test(value)) return true;

  // Alamat interface milik server ini (mis. 192.168.1.4).
  const { getOwnAddresses } = require('./platform');
  const own = getOwnAddresses().map((a) => a.toLowerCase());
  return own.includes(value);
}

module.exports = {
  securityHeaders,
  rateLimit,
  sameOriginGuard,
  isAllowedTargetIp,
  isSelfTarget,
};
