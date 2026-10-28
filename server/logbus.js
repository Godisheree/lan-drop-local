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

/**
 * Apakah log juga dicetak ke terminal.
 *
 * Dulu tidak ada pilihan: setiap baris selalu keluar ke stdout. Sekarang
 * dashboard sudah jadi tempat membaca log (dan bisa disalin dari HP), jadi
 * terminal-nya dibuat diam — nyalakan kalau memang sedang menelusuri masalah:
 *
 *   node server/index.js --debug      (atau LANDROP_DEBUG=1)
 *
 * ponytail: satu saklar untuk semua level, bukan daftar level per flag.
 */
const DEBUG =
  ['1', 'true', 'ya', 'yes', 'on'].includes(String(process.env.LANDROP_DEBUG || '').trim().toLowerCase()) ||
  process.argv.includes('--debug');

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

// Pegangan ke console.log asli, diambil SEBELUM dibajak — dipakai notice().
const consoleLog = console.log.bind(console);

for (const [method, level] of Object.entries(LEVELS)) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    record(level, args);

    // Terminal cuma dipakai kalau diminta. Level `error` tetap dicetak:
    // kalau servernya sendiri gagal jalan (port dipakai, folder tidak bisa
    // ditulis), dashboard-nya belum ada untuk dibaca.
    if (DEBUG || level === 'error') original(...args);
  };
}

/**
 * Baris yang selalu tercetak ke terminal, walau log sedang diam.
 *
 * Dipakai untuk satu hal: menandai bahwa servernya sudah siap dan di alamat
 * mana dashboard-nya dibuka. Terminal yang diam membuat "sudah jalan" dan
 * "belum jalan" kelihatan sama — dan pertanyaan pertama setelah start selalu
 * "udah aktif belum, linknya mana?".
 *
 * @param {...any} args argumen seperti console.log
 */
function notice(...args) {
  record('info', args);
  consoleLog(...args);
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

module.exports = { tail, DEPTH, DEBUG, notice };
