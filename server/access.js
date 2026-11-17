/**
 * Kunci akses perangkat (pairing) untuk LAN DROP.
 *
 * Kenapa ada: tanpa kunci, siapa pun di Wi-Fi yang sama bisa memanggil API
 * lokal dan berlaku sebagai "pengguna perangkat ini" — menerima kiriman atas
 * nama pemilik, membaca teks masuk, dan membatalkan transfer yang sedang
 * jalan. Halaman UI tidak bisa jadi penjaga, karena halaman UI-nya sendiri
 * terbuka untuk siapa saja yang tahu alamatnya.
 *
 * Model yang dipakai: satu kunci acak per perangkat (dibuat sekali, disimpan
 * di settings.json). Kunci itu ikut di dalam URL yang dipindai lewat QR
 * ("Sambung"), jadi tetap nol langkah setup:
 *
 *   - Browser di perangkat ini: waktu membuka `/`, server langsung memberi
 *     cookie berisi kunci (permintaan datang dari alamat mesin ini sendiri).
 *   - Perangkat lain: memindai QR → URL memuat `?k=<kunci>` → server
 *     memasang cookie lalu mengalihkan ke alamat bersih.
 *   - Siapa pun yang tidak punya kunci: API menjawab 401, UI menampilkan
 *     layar "pasangkan dulu". Halaman statis tetap terbuka (isinya cuma
 *     kerangka aplikasi, bukan data).
 *
 * Kunci TIDAK menggantikan PIN dashboard. PIN menjaga halaman pantau
 * (riwayat, log, thumbnail); kunci ini menjaga jalur tulis dan data transfer.
 * Sesi PIN tetap diterima di semua endpoint supaya dashboard dari perangkat
 * lain bisa memantau.
 */

const crypto = require('crypto');
const settings = require('./settings');
const pin = require('./pin');
const { getOwnAddresses } = require('./platform');

const COOKIE_NAME = 'landrop_key';
const HEADER_NAME = 'x-landrop-key';

// Cookie pairing berumur panjang: memindai QR sekali tidak boleh berarti
// memindai ulang tiap kali browser ditutup. 30 hari, HttpOnly, SameSite=Lax.
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// Cache daftar alamat mesin ini — enumerasi interface tidak murah dan
// dipanggil untuk tiap request.
let ownAddressCache = { at: 0, list: [] };
const OWN_ADDRESS_TTL = 5000;

function ownAddresses() {
  const now = Date.now();
  if (now - ownAddressCache.at < OWN_ADDRESS_TTL) return ownAddressCache.list;

  let list = [];
  try {
    list = getOwnAddresses().map(normalizeAddress);
  } catch (_) {
    list = [];
  }
  ownAddressCache = { at: now, list };
  return list;
}

/**
 * Buang prefix IPv4-mapped IPv6 dan zona interface (`fe80::1%wlan0`).
 * @param {string} address
 * @returns {string}
 */
function normalizeAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  const plain = mapped ? mapped[1] : value;
  return plain.split('%')[0];
}

/**
 * Apakah permintaan datang dari mesin ini sendiri?
 *
 * Dipakai HANYA untuk dua hal: memberi cookie pairing otomatis ke browser
 * lokal, dan menampilkan hint PIN bawaan. Bukan gerbang keamanan utama —
 * jalur data tetap memeriksa kunci/cookie.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isLocalRequest(req) {
  const raw = (req && req.socket && req.socket.remoteAddress) || '';
  const addr = normalizeAddress(raw);
  if (!addr) return false;

  if (addr === '::1' || addr === '::' || addr === 'localhost') return true;
  if (addr.startsWith('127.')) return true;

  return ownAddresses().includes(addr);
}

/**
 * Permintaan datang dari loopback (proses di mesin ini sendiri)?
 *
 * Sengaja TIDAK memakai ownAddresses(): alamat LAN milik mesin ini bukan
 * loopback — kalau ikut dianggap lokal, tamu Wi-Fi yang menghubungi IP LAN
 * server akan lolos tanpa kunci.
 *
 * Kenapa loopback boleh tanpa kunci: proses di mesin ini sudah bisa membaca
 * settings.json (berisi kunci itu sendiri) dan folder simpan, jadi menolaknya
 * tidak menambah keamanan sedikit pun — yang terjadi cuma TUI, skrip e2e, dan
 * curl dari mesin sendiri ikut rusak.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isLoopback(req) {
  const addr = normalizeAddress((req && req.socket && req.socket.remoteAddress) || '');
  return addr === '::1' || addr === '::' || addr === 'localhost' || addr.startsWith('127.');
}

/** Baca kunci yang dikirim klien: header, query, atau cookie. */
function presentedKey(req) {
  const header = req.get ? req.get(HEADER_NAME) : null;
  if (header) return String(header).trim();

  const query = req.query && typeof req.query === 'object' ? req.query.k : null;
  if (query) return String(query).trim();

  return pin.readCookie(req, COOKIE_NAME);
}

/**
 * Bandingkan dua kunci dengan waktu konstan, supaya panjang/isi kunci tidak
 * bocor lewat selisih waktu balasan.
 */
function keyMatches(given) {
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(settings.getAccessKey()));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Punya kunci yang benar? */
function hasKey(req) {
  return keyMatches(presentedKey(req));
}

/**
 * Boleh memakai API?
 *
 * Ya kalau: punya kunci perangkat, ATAU sedang login dashboard (PIN).
 * `LANDROP_ACCESS_KEY` bisa menimpa kunci supaya skrip e2e/pengujian punya
 * nilai yang diketahui tanpa membaca settings.json.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function hasAccess(req) {
  if (hasKey(req)) return true;
  if (isLoopback(req)) return true;
  try {
    return pin.isAuthorized(req);
  } catch (_) {
    return false;
  }
}

/** Header Set-Cookie berisi kunci pairing. */
function accessCookieHeader(key, maxAgeSeconds = COOKIE_MAX_AGE) {
  return `${COOKIE_NAME}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/**
 * Middleware gerbang API.
 *
 * Balasannya sengaja menyebut `pairing: true`: frontend memakainya untuk
 * menampilkan layar "pindai QR", bukan toast error biasa.
 *
 * @type {import('express').RequestHandler}
 */
function requireAccess(req, res, next) {
  if (hasAccess(req)) return next();
  return res.status(401).json({
    // Server mengirim pesan Inggris (konvensi repo: teks untuk user diterjemahkan
    // di frontend lewat i18n). `pairing: true` yang dipakai UI untuk memilih layar.
    error: 'This device is not paired. Scan the QR code in the "Connect" panel '
      + 'of the device running LAN DROP.',
    pairing: true,
  });
}

/**
 * Gerbang yang HANYA menerima kunci perangkat atau sesi PIN — loopback tidak
 * dihitung.
 *
 * Dipakai untuk thumbnail: isinya cuplikan gambar file yang pernah diterima,
 * dan aturan repo ini sudah menetapkan isi seperti itu di balik PIN. Proses
 * lokal bukan alasan untuk melonggarkan (PNG di folder simpan tetap bisa
 * dibaca langsung dari filesystem — gerbang ini soal jalur HTTP, bukan soal
 * apa yang bisa dilakukan root).
 *
 * @type {import('express').RequestHandler}
 */
function requireDeviceKey(req, res, next) {
  if (hasKey(req) || pin.isAuthorized(req)) return next();
  return res.status(401).json({
    error: 'Device key or dashboard PIN required',
    pairing: true,
  });
}

/**
 * Middleware bootstrap: beri cookie pairing ke browser lokal, dan tukar
 * `?k=` di URL jadi cookie (supaya kunci tidak tertinggal di address bar,
 * riwayat browser, atau screenshot).
 *
 * Hanya berlaku untuk GET halaman — endpoint API tidak dialihkan.
 *
 * @type {import('express').RequestHandler}
 */
function bootstrapPairing(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const url = req.path || '/';
  const isPage = url === '/' || url === '/index.html' || url.endsWith('.html');
  if (!isPage) return next();

  const queryKey = req.query && typeof req.query === 'object' ? req.query.k : null;

  // `?k=` diperiksa DULU, sebelum "sudah punya kunci". Kalau tidak, kunci di
  // URL ikut terbaca sebagai kunci yang sudah dimiliki, middleware lolos tanpa
  // memasang cookie, dan semua API berikutnya 401 — halaman terbuka, datanya
  // kosong, tanpa penjelasan.
  if (queryKey) {
    if (!keyMatches(queryKey)) {
      return res.status(403).json({ error: 'Access key does not match. Scan the QR code again.', pairing: true });
    }
    res.set('Set-Cookie', accessCookieHeader(settings.getAccessKey()));
    // Alamat bersih: kunci sudah pindah ke cookie.
    const query = { ...req.query };
    delete query.k;
    const params = new URLSearchParams(query).toString();
    return res.redirect(302, params ? `${url}?${params}` : url);
  }

  // Sudah punya kunci yang benar? Tidak ada yang perlu dipasang.
  if (hasKey(req)) return next();

  // Hanya loopback yang dapat cookie otomatis — lihat isLoopback().
  if (isLoopback(req)) {
    res.set('Set-Cookie', accessCookieHeader(settings.getAccessKey()));
  }
  return next();
}

module.exports = {
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  normalizeAddress,
  isLocalRequest,
  isLoopback,
  hasKey,
  hasAccess,
  accessCookieHeader,
  requireAccess,
  requireDeviceKey,
  bootstrapPairing,
};
