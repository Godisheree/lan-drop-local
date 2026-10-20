/**
 * Thumbnail server-side untuk foto & video yang diterima.
 *
 * Kenapa harus di server? File yang diterima ada di filesystem mesin server,
 * sedangkan browser perangkat lain tidak punya akses `file://`. Jadi untuk
 * penerima, server-side adalah satu-satunya opsi. (Untuk pengirim, file ada
 * di `uploads-temp` server sendiri — juga bisa, tapi nilainya lebih kecil.)
 *
 * Prinsip keamanan:
 *   1. Path file TIDAK PERNAH datang dari URL. Client cuma mengirim id
 *      opaque; server yang memetakan id -> path dari daftar file yang
 *      sudah dia RECEIVE. Ini menutup path traversal sepenuhnya.
 *   2. Hanya ekstensi media yang diproses (whitelist).
 *   3. ffmpeg dijalankan dengan `-nostdin` + `-protocol_whitelist file`
 *      supaya file dari peer tidak bisa menarik resource dari jaringan.
 *
 * Tanpa dependency baru: memakai ffmpeg yang sudah ada untuk transcode.
 * Kalau ffmpeg tidak tersedia, gambar yang formatnya didukung browser
 * dikembalikan apa adanya — browser yang menskalakan.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getDataDir } = require('./platform');
const { getFfmpegPath, runFfmpeg } = require('./ffmpeg');

// Ekstensi yang bisa di-thumbnail.
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.avif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.3gp', '.mpeg', '.mpg', '.ts', '.flv'];

// Format gambar yang bisa langsung ditampilkan browser tanpa ffmpeg.
const BROWSER_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

const MAX_ORIGINAL_BYTES = 12 * 1024 * 1024; // 12 MB
const THUMB_WIDTH = 480;
const CACHE_MAX_FILES = 300;

// Peta id -> path absolut. diisi oleh server saat file diterima.
const pathById = new Map();
/** @type {Map<string, Promise<{buffer: Buffer, contentType: string}|null>>} */
const inFlight = new Map();

/**
 * Id opaque & deterministik untuk sebuah path.
 * @param {string} absPath
 * @returns {string}
 */
function idForPath(absPath) {
  return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

/**
 * @param {string} fileName
 * @returns {boolean} true kalau file ini bisa di-thumbnail
 */
function isThumbnailable(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return PHOTO_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Daftarkan file yang sudah diterima supaya bisa di-thumbnail.
 * @param {string} absPath
 * @returns {string} id untuk dipakai di URL
 */
function registerFile(absPath) {
  const id = idForPath(absPath);
  pathById.set(id, absPath);
  return id;
}

/**
 * Cari id untuk sebuah path (kalau sudah pernah didaftarkan).
 * @param {string} absPath
 * @returns {string|null}
 */
function findId(absPath) {
  for (const [id, value] of pathById) {
    if (value === absPath) return id;
  }
  return null;
}

/**
 * @returns {string} folder cache thumbnail
 */
function cacheDir() {
  return path.join(getDataDir(), 'thumbs');
}

/**
 * Bersihkan cache thumbnail lama (batas jumlah file).
 */
function pruneCache() {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir)
      .map((name) => {
        const full = path.join(dir, name);
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime);

    const excess = files.length - CACHE_MAX_FILES;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(files[i].full); } catch (_) {}
    }
  } catch (_) {
    // Pruning gagal bukan masalah fatal.
  }
}

/**
 * Ambil satu frame dari video, atau gambar itself.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<boolean>} true kalau berhasil
 */
async function renderWithFfmpeg(inputPath, outputPath) {
  const ffmpegPath = await getFfmpegPath();
  if (!ffmpegPath) return false;

  const isVideo = VIDEO_EXTENSIONS.includes(path.extname(inputPath).toLowerCase());

  const args = [
    '-nostdin',
    '-loglevel', 'error',
    // Batasi demuxer ke file lokal — cegah file dari peer menarik resource
    // dari jaringan (mis. playlist m3u8, atau http:// di dalam container).
    '-protocol_whitelist', 'file',
  ];

  if (isVideo) {
    // Ambil frame di detik ke-1; kalau videonya lebih pendek, ambil frame awal.
    args.push('-ss', '1');
  }

  args.push(
    '-i', inputPath,
    '-vf', `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
    '-frames:v', '1',
    '-q:v', '5',
    '-y', outputPath
  );

  try {
    const { code } = await runFfmpeg(args, { timeout: 20000 });
    if (code === 0 && fs.existsSync(outputPath)) {
      return fs.statSync(outputPath).size > 0;
    }
  } catch (err) {
    console.warn('[thumbnail] ffmpeg gagal:', err.message);
  }
  return false;
}

/**
 * Ambil thumbnail untuk sebuah file.
 *
 * @param {string} absPath
 * @returns {Promise<{buffer: Buffer, contentType: string}|null>}
 */
async function ensureThumbnail(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;

  const id = idForPath(absPath);
  const dir = cacheDir();
  const cached = path.join(dir, `${id}.jpg`);

  // Sudah ada di cache?
  try {
    if (fs.existsSync(cached)) {
      const buffer = fs.readFileSync(cached);
      if (buffer.length > 0) return { buffer, contentType: 'image/jpeg' };
    }
  } catch (_) {
    // Cache rusak — regenerate.
  }

  // Dedupe: 10 request bersamaan untuk file yang sama hanya menjalankan
  // ffmpeg sekali.
  if (inFlight.has(id)) return inFlight.get(id);

  const job = (async () => {
    const ext = path.extname(absPath).toLowerCase();

    // Fallback tanpa ffmpeg: gambar yang didukung browser dikembalikan apa
    // adanya. Browser yang menskalakan ukurannya.
    const isBrowserImage = BROWSER_IMAGE_EXTENSIONS.includes(ext);

    if (!isBrowserImage) {
      // Video (atau format lain) butuh ffmpeg. Kalau tidak ada, tidak ada
      // thumbnail — UI jatuh ke emoji.
      const produced = await renderWithFfmpeg(absPath, cached);
      if (!produced) return null;
    } else {
      // Coba ffmpeg dulu (hasil lebih kecil & terkompresi baik).
      const produced = await renderWithFfmpeg(absPath, cached);
      if (!produced) {
        // Fallback: kirim file asli.
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > MAX_ORIGINAL_BYTES) return null;
          const buffer = fs.readFileSync(absPath);
          const contentType = ext === '.gif' ? 'image/gif'
            : ext === '.webp' ? 'image/webp'
            : ext === '.bmp' ? 'image/bmp'
            : 'image/jpeg';
          return { buffer, contentType };
        } catch (_) {
          return null;
        }
      }
    }

    try {
      const buffer = fs.readFileSync(cached);
      pruneCache();
      return { buffer, contentType: 'image/jpeg' };
    } catch (_) {
      return null;
    }
  })().finally(() => {
    inFlight.delete(id);
  });

  inFlight.set(id, job);
  return job;
}

/**
 * Ambil thumbnail berdasarkan id.
 * @param {string} id
 * @returns {Promise<{buffer: Buffer, contentType: string}|null>}
 */
async function getThumbnailById(id) {
  const absPath = pathById.get(id);
  if (!absPath) return null;
  return ensureThumbnail(absPath);
}

module.exports = {
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isThumbnailable,
  idForPath,
  registerFile,
  findId,
  getThumbnailById,
  ensureThumbnail,
  pruneCache,
};
