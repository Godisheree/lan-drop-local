/**
 * Pemeriksaan & pemanggilan ffmpeg.
 *
 * Dipisah dari transfer.js supaya modul lain (mis. thumbnail.js) bisa
 * memakainya tanpa mengimpor transfer.js — itu akan membuat import siklik
 * dan Presidents, hal yang harus dihindari di server.
 *
 * Ekstraksi ini bersifat "pure move": logika tidak diubah, hanya dipindah.
 */

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Lokasi umum ffmpeg di Windows (winget, manual install, dll)
const FFMPEG_CANDIDATES = [
  'ffmpeg',
  'ffmpeg.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg.Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.1.1-full_build', 'bin', 'ffmpeg.exe'),
  path.join(process.env.ProgramFiles || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(process.env.ProgramW6432 || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(os.homedir(), 'ffmpeg', 'bin', 'ffmpeg.exe'),
];

let _ffmpegPath = undefined; // undefined=belum cek, false=cek&gakada, string=path

/**
 * Cari ffmpeg di PATH dan lokasi umum. Hasilnya di-cache.
 * @returns {Promise<boolean>} true kalau ffmpeg ditemukan
 */
function checkFfmpeg() {
  return new Promise((resolve) => {
    console.log('[FFMPEG] checkFfmpeg: mulai scan ffmpeg...');
    (function tryNext(i) {
      if (i >= FFMPEG_CANDIDATES.length) {
        console.log('[FFMPEG] checkFfmpeg: SEMUA kandidat habis — ffmpeg TIDAK ditemukan');
        return resolve(false);
      }
      const candidate = FFMPEG_CANDIDATES[i];
      console.log(`[FFMPEG] checkFfmpeg: coba kandidat [${i}]: "${candidate}"`);
      const proc = spawn(candidate, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; if (result) { console.log(`[FFMPEG] checkFfmpeg: ✅ DITEMUKAN di "${candidate}"`); _ffmpegPath = candidate; resolve(true); } else { console.log(`[FFMPEG] checkFfmpeg: ❌ "${candidate}" gagal, lanjut next...`); tryNext(i + 1); } } };
      proc.on('error', () => done(false));
      proc.on('exit', (code) => { console.log(`[FFMPEG] checkFfmpeg: "${candidate}" exit code=${code}`); done(code === 0); });
    })(0);
  });
}

/**
 * Pastikan ffmpeg tersedia, lalu kembalikan path-nya.
 * @returns {Promise<string|null>} path ffmpeg, atau null kalau tidak ada
 */
async function getFfmpegPath() {
  if (_ffmpegPath === undefined) {
    const ok = await checkFfmpeg();
    _ffmpegPath = ok ? _ffmpegPath : false;
  }
  return _ffmpegPath || null;
}

/**
 * Path ffprobe yang pas dengan ffmpeg yang ditemukan.
 *
 * Kalau ffmpeg ada di lokasi kustom, ffprobe biasanya ada di direktori yang
 * sama. Kalau tidak ketemu, jatuh ke `ffprobe` di PATH.
 *
 * @returns {Promise<string>}
 */
async function getFfprobePath() {
  const ffmpegPath = await getFfmpegPath();
  if (!ffmpegPath) return 'ffprobe';
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => 'ffprobe' + m.slice(6));
}

/**
 * Jalankan ffmpeg dengan argumen yang diberikan.
 * @param {string[]} args
 * @param {Object} [opts]
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<{code: number, stderr: string}>}
 */
function runFfmpeg(args, opts = {}) {
  const { timeout = 20000 } = opts;

  return new Promise((resolve, reject) => {
    const proc = spawn(_ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => resolve({ code, stderr }));
  });
}

module.exports = {
  FFMPEG_CANDIDATES,
  checkFfmpeg,
  getFfmpegPath,
  getFfprobePath,
  runFfmpeg,
};
