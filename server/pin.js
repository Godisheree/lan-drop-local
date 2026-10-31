const crypto = require('crypto');
const settings = require('./settings');

// ===================== PIN Dashboard =====================
//
// Tujuan: orang yang nyambung ke Wi-Fi yang sama tidak bisa semabarangan
// membuka /dashboard (riwayat transfer, nama peer, isi log).
//
// UI kirim file TIDAK dikunci — itu pintu masuk utama dan harus tetap
// sekali-buka dari HP. Yang dijaga cuma halaman pantau.
//
// Sesi disimpan di memori (Map), bukan di disk: restart server = semua
// browser diminta masukkan PIN lagi. Itu perilaku yang diinginkan — kalau
// sesi ikut ke disk, "logout" jadi tidak ada artinya karena token bisa
// hidup lebih lama dari niat user mencabutnya.

const COOKIE_NAME = 'landrop_dash';

// Sesi di server cuma bertahan 24 jam (jaring pengaman kalau browser tidak
// pernah ditutup), dan cookie-nya SESSION cookie: hilang begitu browser
// ditutup. 30 hari terlalu panjang buat token yang lewat HTTP polos — sekali
// kesadap di Wi-Fi terbuka, sesinya kepakai sebulan.
const TTL_SECONDS = 24 * 60 * 60; // 24 jam

const sessions = new Map(); // token -> waktu kedaluwarsa (ms)

function getPin() {
  return settings.getDashboardPin();
}

/** Masih PIN bawaan (`123456`)? Dipakai UI buat nampilin hint + peringatan. */
function isDefaultPin() {
  return getPin() === settings.DEFAULT_PIN;
}

/**
 * Bandingkan PIN dengan waktu konstan supaya panjang/isi PIN tidak bocor
 * lewat perbedaan waktu balasan.
 */
function verify(input) {
  const given = Buffer.from(String(input == null ? '' : input).trim());
  const real = Buffer.from(getPin());
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + TTL_SECONDS * 1000);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

/** Semua sesi mati — dipanggil saat PIN diganti. */
function revokeAll() {
  sessions.clear();
}

/** Baca satu cookie tanpa dependency `cookie-parser`. */
function readCookie(req, name) {
  const raw = (req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch (_) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

function isAuthorized(req) {
  return isValidSession(readCookie(req, COOKIE_NAME));
}

/**
 * Header Set-Cookie.
 *
 * Tanpa `Secure`: LAN DROP jalan di http polos, dan cookie bertanda `Secure`
 * tidak akan pernah dikirim balik oleh browser di http — login-nya malah
 * rusak. Tanpa `Max-Age` (kecuali diminta): cookie jadi SESSION cookie —
 * browser ditutup, PIN diminta lagi. `maxAgeSeconds = 0` dipakai logout buat
 * menyuruh browser menghapus cookie-nya.
 */
function cookieHeader(token, maxAgeSeconds) {
  const base = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  return maxAgeSeconds == null ? base : `${base}; Max-Age=${maxAgeSeconds}`;
}

/**
 * Apakah permintaan datang dari perangkat yang menjalankan server ini?
 *
 * Dipakai buat hint PIN: `127.0.0.1`/`::1` hanya bisa dari laptop pemilik.
 * Termasuk bentuk IPv4-mapped (`::ffff:127.0.0.1`) yang muncul saat Node
 * mendengarkan dual-stack, dan `::ffff:7f...` versi heksadesimal.
 */
function isLoopback(req) {
  const addr = (req && req.socket && req.socket.remoteAddress) || '';
  if (addr === '::1') return true;
  if (addr.startsWith('::ffff:')) return addr.slice(7).startsWith('127.');
  return addr.startsWith('127.');
}

module.exports = {
  COOKIE_NAME,
  TTL_SECONDS,
  getPin,
  isDefaultPin,
  verify,
  createSession,
  isValidSession,
  destroySession,
  revokeAll,
  readCookie,
  isAuthorized,
  isLoopback,
  cookieHeader,
};
