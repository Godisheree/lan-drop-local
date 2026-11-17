const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('./platform');

// ===================== Settings =====================
// Setting per-device disimpan sebagai JSON di data dir, pola sama dengan
// history.js: cache di memori + tulis atomic (tmp + rename) yang di-debounce.

const dataFile = path.join(getDataDir(), 'settings.json');

// PIN bawaan dashboard. Ditampilkan apa adanya ke user selama belum diganti
// (lihat pin.js) — kalau disembunyikan, orang cuma lihat halaman terkunci dan
// tidak tahu harus ngapain.
const DEFAULT_PIN = '123456';

const DEFAULTS = {
  // Terima otomatis: kalau enabled, permintaan file dari peer diterima
  // tanpa modal. `peers` kosong = semua peer boleh; kalau diisi, hanya
  // nama perangkat di daftar itu.
  autoApprove: { enabled: false, peers: [] },

  // PIN buka /dashboard. Disimpan apa adanya (bukan hash): PIN ini cuma
  // pagar sopan-santun antar-tetangga Wi-Fi, bukan kredensial akun — kalau
  // penyerang sudah bisa baca file ini di disk, dia sudah punya mesinnya.
  // ponytail: plaintext di settings.json, ganti ke hash kalau nanti ada
  // sinkronisasi setting antar perangkat.
  dashboardPin: DEFAULT_PIN,

  // Kunci pairing perangkat (lihat server/access.js). Kosong = belum pernah
  // dibuat; `load()` yang mengisinya sekali lalu menyimpannya. Dibuat acak,
  // bukan diturunkan dari nama perangkat: nama perangkat bisa ditebak.
  accessKey: '',

  // Identitas pengirim yang bertahan antar restart. Dipakai sebagai bagian
  // kunci resume dan sebagai bagian identitas auto-approve, jadi harus stabil
  // (dulu: `${DEVICE_NAME}-${Math.random()}` yang berubah tiap request).
  deviceId: '',
};

/** PIN harus 4-8 angka; apa pun di luar itu jatuh ke PIN bawaan. */
function normalizePin(value) {
  const text = String(value == null ? '' : value).trim();
  return /^\d{4,8}$/.test(text) ? text : DEFAULT_PIN;
}

let cache = null;

// Kunci yang benar-benar diubah oleh proses INI. Dipakai `writeNow()` supaya
// dua server yang jalan bersamaan di satu data dir tidak saling menimpa:
// dulu seluruh objek ditulis dari cache memori, jadi instance yang sudah lama
// hidup (cache-nya masih PIN lama) menghapus PIN baru begitu ia menulis apa
// pun — gejalanya "PIN balik ke bawaan" tanpa sebab yang kelihatan.
const changedKeys = new Set();

function normalizeAutoApprove(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    peers: Array.isArray(v.peers)
      ? v.peers.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 50)
      : [],
  };
}

/** Kunci pairing harus hex panjang; selain itu dianggap tidak ada. */
function normalizeAccessKey(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return /^[0-9a-f]{32,64}$/.test(text) ? text : '';
}

function normalizeDeviceId(value) {
  const text = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9_-]{4,80}$/.test(text) ? text : '';
}

function newAccessKey() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex = 192 bit
}

function newDeviceId() {
  return crypto.randomBytes(6).toString('hex');
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    cache = {
      autoApprove: normalizeAutoApprove(raw && raw.autoApprove),
      dashboardPin: normalizePin(raw && raw.dashboardPin),
      accessKey: normalizeAccessKey(raw && raw.accessKey),
      deviceId: normalizeDeviceId(raw && raw.deviceId),
    };
  } catch (_) {
    cache = {
      autoApprove: normalizeAutoApprove(DEFAULTS.autoApprove),
      dashboardPin: DEFAULT_PIN,
      accessKey: '',
      deviceId: '',
    };
  }

  // Kunci/identitas yang belum ada dibuat SEKALI lalu ditulis ke disk.
  // Kalau tidak disimpan, tiap restart menghasilkan kunci baru dan semua
  // perangkat yang sudah dipasangkan mendadak ditolak.
  let changed = false;
  if (!cache.accessKey) {
    cache.accessKey = process.env.LANDROP_ACCESS_KEY
      ? normalizeAccessKey(process.env.LANDROP_ACCESS_KEY) || newAccessKey()
      : newAccessKey();
    changedKeys.add('accessKey');
    changed = true;
  }
  if (!cache.deviceId) {
    cache.deviceId = newDeviceId();
    changedKeys.add('deviceId');
    changed = true;
  }
  if (changed) writeNow();

  return cache;
}

/**
 * Tulis ke disk SEKARANG, bukan lewat timer.
 *
 * `history.js` sengaja di-debounce 300 ms karena batch transfer bisa memicu
 * banyak entri sekaligus. Setting tidak begitu: satu perubahan = satu klik
 * user, jadi menundanya cuma menciptakan jendela di mana nilai sudah berubah
 * di UI tapi belum ada di disk — dan proses yang mati di jendela itu (Ctrl+C,
 * tutup jendela Electron) membuat toggle kembali ke keadaan semula seolah
 * tidak pernah dinyalakan.
 */
function readDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeNow() {
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    // Mulai dari isi disk, bukan dari cache: instance lain mungkin sudah
    // menulis kunci yang proses ini tidak pernah sentuh.
    const merged = readDisk();
    for (const key of changedKeys) merged[key] = cache[key];
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, dataFile);
  } catch (_) {
    // Disk penuh / read-only — biarkan nilai tetap hidup di memori.
  }
}

function getAutoApprove() {
  return load().autoApprove;
}

/**
 * @param {{enabled?: boolean, peers?: string[]}} patch
 * @returns {{enabled: boolean, peers: string[]}}
 */
function setAutoApprove(patch) {
  const current = load().autoApprove;
  cache.autoApprove = normalizeAutoApprove({
    enabled: patch && patch.enabled !== undefined ? patch.enabled : current.enabled,
    peers: patch && patch.peers !== undefined ? patch.peers : current.peers,
  });
  changedKeys.add('autoApprove');
  writeNow();
  return cache.autoApprove;
}

/**
 * Boleh diterima otomatis dari perangkat ini?
 *
 * `senderName` adalah klaim pengirim di dalam frame transfer-request, jadi
 * nama saja tidak cukup: siapa pun bisa menyamar dengan nama perangkat yang
 * ada di allowlist. Karena itu `senderIp` (alamat asli socket, tidak bisa
 * dipalsukan) ikut diperiksa terhadap alamat yang benar-benar diumumkan
 * perangkat bernama itu lewat discovery.
 *
 * Dua bentuk entri allowlist:
 *   - "Nama"         → nama harus cocok DAN alamat pengirim harus alamat yang
 *                      diumumkan perangkat bernama itu (discovery).
 *   - "Nama@ip"      → nama DAN alamat harus cocok persis. Dipakai kalau
 *                      discovery tidak jalan (jaringan blokir broadcast).
 *
 * @param {string} senderName
 * @param {string} [senderIp]
 * @param {(name: string) => string[]} [knownIps] sumber alamat dari discovery
 * @returns {boolean}
 */
function isAutoApprovePeer(senderName, senderIp, knownIps) {
  const { enabled, peers } = getAutoApprove();
  if (!enabled) return false;

  const name = String(senderName || '').trim();
  // Normalisasi alamat: buang prefix IPv4-mapped IPv6.
  const ip = String(senderIp || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (peers.length === 0) return true;

  const advertised = typeof knownIps === 'function' && name ? knownIps(name) : [];
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/^::ffff:/, '');

  return peers.some((entry) => {
    const text = String(entry || '').trim();
    const at = text.lastIndexOf('@');
    if (at === -1) {
      if (text !== name) return false;
      // Tanpa IP di allowlist, alamat pengirim harus salah satu yang
      // diumumkan perangkat bernama itu. Discovery mati = tidak lolos.
      if (!ip) return false;
      return advertised.some((addr) => normalize(addr) === ip);
    }
    if (text.slice(0, at) !== name) return false;
    return normalize(text.slice(at + 1)) === ip;
  });
}

function getDashboardPin() {
  return load().dashboardPin;
}

/** Kunci pairing perangkat ini. */
function getAccessKey() {
  return load().accessKey;
}

/** Identitas pengirim yang stabil antar restart. */
function getDeviceId() {
  return load().deviceId;
}

/**
 * Ganti PIN dashboard. Sesi yang sedang login dimatikan di pemanggil
 * (`pin.revokeAll()`) supaya browser lama ikut minta PIN baru.
 */
function setDashboardPin(value) {
  const next = normalizePin(value);
  load().dashboardPin = next;
  changedKeys.add('dashboardPin');
  writeNow();
  return next;
}

module.exports = {
  getAutoApprove,
  setAutoApprove,
  isAutoApprovePeer,
  getDashboardPin,
  setDashboardPin,
  getAccessKey,
  getDeviceId,
  DEFAULT_PIN,
  DEFAULTS,
};
