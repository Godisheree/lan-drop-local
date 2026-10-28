/**
 * Penangkap log server (ring buffer 300 baris, in-memory).
 *
 * Kenapa ada: log server cuma nulis ke stdout — begitu terminal ditutup,
 * jejaknya hilang. Pertanyaan "kenapa peer-nya gak muncul" atau "transfer
 * gagal karena apa" jadi tidak bisa dijawab lagi, padahal jawabannya tadi
 * ada di layar. Dashboard butuh sumber yang bisa dibaca ulang kapan saja.
 *
 * Caranya: console.log/warn/error dibajak SEKALI di sini. Modul ini wajib
 * di-require paling awal di server/index.js supaya log modul lain (saat
 * require) ikut terekam. stdout tetap utuh — terminal user tidak berubah.
 *
 * ponytail: ring buffer in-memory. Batasnya: hilang saat proses restart dan
 * cuma 300 baris terakhir. Naikkan DEPTH, atau tulis juga ke file di data dir
 * kalau nanti butuh riwayat lintas restart.
 */
const util = require('util');

const DEPTH = 300;

const buffer = [];
let nextId = 1;

const LEVELS = { log: 'info', warn: 'warn', error: 'error' };

function record(level, args) {
  let text;
  try {
    text = util.format(...args);
  } catch (_) {
    // Argumen aneh (mis. objek dengan getter yang melempar) tidak boleh
    // menjatuhkan pemanggil console-nya.
    text = String(args[0]);
  }

  buffer.push({ id: nextId++, ts: Date.now(), level, text });
  if (buffer.length > DEPTH) buffer.splice(0, buffer.length - DEPTH);
}

for (const [method, level] of Object.entries(LEVELS)) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    record(level, args);
    original(...args);
  };
}

/**
 * Baris log dengan id lebih besar dari `sinceId`.
 *
 * Id naik monoton, jadi klien cukup menyimpan id terakhir yang dia punya —
 * polling tidak mengirim ulang baris lama.
 *
 * @param {number} [sinceId=0]
 * @returns {{lines: Array<{id: number, ts: number, level: string, text: string}>, lastId: number, depth: number}}
 */
function tail(sinceId = 0) {
  const since = Number(sinceId) || 0;
  return {
    lines: buffer.filter((line) => line.id > since),
    lastId: nextId - 1,
    depth: DEPTH,
  };
}

module.exports = { tail, DEPTH };
