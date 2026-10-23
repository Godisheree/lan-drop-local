const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { isTermux, isWindows, getDataDir, getWindowsSaveDir, getSaveDirFreeSpace, WINDOWS_SAVE_DIR, WINDOWS_SAVE_CATEGORIES, isTailscaleIPv4 } = require('./platform');
const thumbnail = require('./thumbnail');
const history = require('./history');
const settings = require('./settings');

// ===================== Konstanta =====================
const TRANSFER_PORT = parseInt(process.env.TRANSFER_PORT) || 3001;

// Resume: partial file disimpan di folder tujuan dengan suffix .landrop-part,
// lalu di-rename jadi nama asli pas transfer selesai (rename dalam satu
// folder = atomic, gak ada copy). Partial kedaluwarsa setelah 7 hari.
const PART_SUFFIX = '.landrop-part';
const RESUME_TTL = 7 * 24 * 60 * 60 * 1000;      // partial bisa dilanjutin 7 hari
const UPLOAD_TTL = 7 * 24 * 60 * 60 * 1000;       // upload sampah dibersihin 7 hari

// ===================== Upload Path Allowlist (keamanan) =====================
// File yang dikirim ke peer SELALU berasal dari /transfer/upload, jadi path-nya
// wajib berada di dalam folder upload. Tanpa guard ini, endpoint
// /transfer/send-file bisa dipakai buat membocorkan file apa pun di disk
// (path dari body request dipakai mentah-mentah).
//
// Folder upload: $LANDROP_UPLOAD_DIR (dipakai Electron) atau ./uploads-temp.
// Nilainya harus sama persis dengan yang dipakai server/index.js.
const UPLOADS_ROOT = path.resolve(
  process.env.LANDROP_UPLOAD_DIR || path.join(__dirname, '..', 'uploads-temp')
);

/**
 * Pastikan path file berada di dalam folder upload.
 *
 * Dua lapis:
 *   1. Cek leksikal — path.resolve + path.relative. Menolak traversal
 *      ("../../etc/passwd") dan path absolut di luar folder.
 *   2. Cek kanonik — fs.realpathSync. Menutup symlink/junction di dalam
 *      folder upload yang mengarah ke luar (butuh akses tulis lokal, tapi
 *      murah dicek dan tidak boleh dilewati).
 *
 * @param {string} filePath
 * @returns {string} path absolut yang sudah tervalidasi
 */
function assertInsideUploads(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const rel = path.relative(UPLOADS_ROOT, resolved);
  // rel kosong = path-nya folder upload itu sendiri (bukan file)
  // rel diawali '..' = keluar folder upload
  // rel absolut = di drive/path lain
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Invalid file path: di luar folder upload');
  }

  // Cek kanonik (kalau file-nya ada).
  try {
    const realRoot = fs.realpathSync(UPLOADS_ROOT);
    const realFile = fs.realpathSync(resolved);
    const realRel = path.relative(realRoot, realFile);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error('Invalid file path: di luar folder upload');
    }
  } catch (err) {
    // File belum ada → biarkan pemanggil yang-report "File not found".
    if (err.code !== 'ENOENT') {
      throw new Error('Invalid file path: di luar folder upload');
    }
  }

  return resolved;
}

// ===================== State =====================
const pendingRequests = new Map(); // requestId -> { socket, parser, fileName, fileSize, senderName, senderId, status, createdAt }
const outgoingRequests = new Map(); // requestId -> { socket, parserHandler, status, targetIp, targetPort, fileName, fileSize, text?, createdAt }
const transferProgress = new Map(); // requestId -> { fileName, fileSize, bytesTransferred, status, savePath? }
let receivedTexts = []; // { id, senderName, text, timestamp } — teks masuk, diambil frontend via polling
const TEXT_TTL = 10 * 60 * 1000; // teks diterima dibersihkan setelah 10 menit
let tcpServer = null;

// ===================== Frame Parser =====================
class FrameParser {
  constructor(onMessage) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.expectedLen = null;
  }

  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (true) {
      if (this.expectedLen === null) {
        if (this.buffer.length < 4) return;
        this.expectedLen = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.slice(4);
      }

      if (this.buffer.length < this.expectedLen) return;

      const payload = this.buffer.slice(0, this.expectedLen);
      this.buffer = this.buffer.slice(this.expectedLen);
      this.expectedLen = null;

      try {
        const obj = JSON.parse(payload.toString());
        this.onMessage(obj);
      } catch (_) {}
    }
  }
}

// ===================== Helper: Kirim Frame =====================
function sendFramedMessage(socket, obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  socket.write(Buffer.concat([header, payload]));
}

// ===================== Auto-Save: Klasifikasi File =====================
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.3gp', '.mpeg', '.mpg'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus'];
const DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt'];

function classifyFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (PHOTO_EXTENSIONS.includes(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (DOC_EXTENSIONS.includes(ext)) return 'doc';
  return 'other';
}

// ===================== Auto-Save: Directory Resolution =====================
// Dulu Windows pakai path relatif ke folder project/instalasi — salah, dan
// kalau app keinstall di Program Files, nulis ke situ bisa gagal EPERM.
function getTermuxStorageDir(category) {
  // category: 'pictures' | 'movies' | 'music' | 'downloads' | 'shared/Documents'
  // (nama symlink asli dari termux-setup-storage — harus huruf kecil)
  const dir = path.join(os.homedir(), 'storage', category);
  if (fs.existsSync(dir)) {
    return dir;
  }
  console.warn(`[Transfer] ~/storage/${category} tidak ditemukan (mungkin termux-setup-storage belum dijalankan). Fallback ke folder internal.`);
  return null;
}

// Folder tujuan akhir per file: photo → Pictures, video → Videos, sisanya
// → Downloads (mirip klasifikasi Termux). Fallback ke data dir kalau platform
// gak nyediain folder yang bisa ditulis.
function resolveSaveDir(safeName) {
  const fileType = classifyFileType(safeName);
  let dir = null;
  if (isWindows()) {
    dir = getWindowsSaveDir(fileType);
  } else if (isTermux()) {
    // Symlink hasil termux-setup-storage (HURUF KECIL — Android/Linux
    // case-sensitive, beda sama Windows): pictures, movies, music,
    // downloads, dcim, shared (=/sdcard). Documents gak punya symlink
    // sendiri → pakai shared/Documents.
    const category = fileType === 'photo' ? 'pictures'
      : fileType === 'video' ? 'movies'
      : fileType === 'audio' ? 'music'
      : fileType === 'doc' ? 'shared/Documents'
      : 'downloads';
    dir = getTermuxStorageDir(category);
  }
  if (!dir) dir = path.join(getDataDir(), 'downloads');
  return dir;
}

// ===================== Resume: identitas transfer & partial =====================
// Key = identitas stabil (pengirim + file). Dipakai penerima buat nyocokin
// partial pas pengirim ngirim ulang file yang sama (setelah putus/retry).
function makeTransferKey(senderName, batchId, fileName, fileSize) {
  return crypto.createHash('sha1')
    .update(`${senderName || ''}|${batchId || ''}|${fileName || ''}|${fileSize || 0}`)
    .digest('hex')
    .slice(0, 16);
}

function getPartMetaPath(key) {
  return path.join(getDataDir(), 'parts', `${key}.json`);
}

function readPartMeta(key) {
  try {
    const p = getPartMetaPath(key);
    if (!fs.existsSync(p)) return null;
    const meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!meta || Date.now() - (meta.updatedAt || 0) > RESUME_TTL) return null;
    return meta;
  } catch (_) {
    return null;
  }
}

function writePartMeta(key, meta) {
  try {
    fs.mkdirSync(path.join(getDataDir(), 'parts'), { recursive: true });
    const tmp = getPartMetaPath(key) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...meta, updatedAt: Date.now() }));
    fs.renameSync(tmp, getPartMetaPath(key));
  } catch (_) {}
}

function deletePartMeta(key) {
  try { fs.unlinkSync(getPartMetaPath(key)); } catch (_) {}
}

// Nama file aman buat filesystem (reserved chars Windows, trailing dot)
function sanitizeFileName(name) {
  let n = path.basename(String(name || 'file'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!n || n === '.' || n === '..') n = 'file';
  return n.slice(0, 200);
}

// Pastikan folder simpan + subfolder kategori ada sejak startup. Kalau drive
// D: gak kesambung (di-cabut, belum ke-map, laptop baru), user langsung tau
// dari log — bukan pas file 500MB lagi nyampe baru error. Kalau gagal,
// transfer tetap jalan pakai fallback $LANDROP_DATA_DIR/downloads.
function ensureSaveDirExists() {
  if (!isWindows()) return; // Termux: dicek per-file (shared storage opsional)
  if (process.env.LANDROP_SAVE_DIR) {
    // Override eksplisit → flat, gak bikin subfolder kategori
    try {
      fs.mkdirSync(process.env.LANDROP_SAVE_DIR, { recursive: true });
      console.log(`[Transfer] Folder simpan siap: ${process.env.LANDROP_SAVE_DIR}`);
    } catch (err) {
      console.warn(`[Transfer] Gagal bikin folder simpan: ${err.message}`);
    }
    return;
  }
  try {
    // Root + semua subfolder sekaligus
    fs.mkdirSync(WINDOWS_SAVE_DIR, { recursive: true });
    for (const sub of Object.values(WINDOWS_SAVE_CATEGORIES)) {
      fs.mkdirSync(path.join(WINDOWS_SAVE_DIR, sub), { recursive: true });
    }
    console.log(`[Transfer] Folder simpan siap: ${WINDOWS_SAVE_DIR} (${Object.values(WINDOWS_SAVE_CATEGORIES).join(', ')})`);
  } catch (err) {
    console.warn(`[Transfer] Gagal bikin folder simpan ${WINDOWS_SAVE_DIR}: ${err.message} — fallback ke ${path.join(getDataDir(), 'downloads')}`);
  }
}

// Bersihin upload & partial yang udah kedaluwarsa — biar storage Termux
// gak penuh sampah transfer yang gak pernah diselesaikan.
function cleanupStale() {
  const uploadsDir = process.env.LANDROP_UPLOAD_DIR || path.join(__dirname, '..', 'uploads-temp');
  const partsDir = path.join(getDataDir(), 'parts');
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(uploadsDir)) {
      try {
        const st = fs.statSync(path.join(uploadsDir, f));
        if (st.isFile() && now - st.mtimeMs > UPLOAD_TTL) fs.unlinkSync(path.join(uploadsDir, f));
      } catch (_) {}
    }
  } catch (_) {}
  try {
    for (const f of fs.readdirSync(partsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(partsDir, f), 'utf-8'));
        if (now - (meta.updatedAt || 0) > RESUME_TTL) {
          if (meta.partPath) fs.unlinkSync(meta.partPath);
          fs.unlinkSync(path.join(partsDir, f));
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// ===================== Video Transcoding =====================
// Format video lama/yang mungkin gak di-support native HP → konversi ke H.264 .mp4
const NEEDS_TRANSCODE = ['.mpeg', '.mpg', '.avi', '.mkv', '.webm', '.mov', '.3gp', '.flv', '.ts'];

// Deteksi & pemanggilan ffmpeg lived di server/ffmpeg.js - dipakai juga oleh
// server/thumbnail.js. Dipisah supaya thumbnail.js tidak perlu mengimpor
// transfer.js (itu akan bikin import siklik).
const { getFfmpegPath, getFfprobePath, runFfmpeg } = require('./ffmpeg');

function transcodeToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // -nostdin: ffmpeg gak boleh baca dari stdin (celah interaktif).
    // -protocol_whitelist file: ffmpeg probing KONTEN, bukan ekstensi — file
    //   dari peer bisa jadi playlist M3U8 yang bikin ffmpeg ambil URL attacker
    //   (SSRF ke metadata cloud). Whitelist cuma izinkan protokol file:.
    const args = [
      '-nostdin',
      '-protocol_whitelist', 'file',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y', outputPath
    ];
    runFfmpeg(args).then(({ code, stderr }) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    }, reject);
  });
}

function remuxToM4a(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Output: MP3 container. Audio MP3 → copy murni tanpa re-encode.
    // Kenapa MP3, bukan M4A? Karena audio asli file-file ini adalah MP3,
    // dan container M4A (format ipod) tidak support MP3 — cuma AAC/ALAC.
    // Dengan MP3 container, copy murni jadi super cepat dan lossless.
    const args = [
      '-nostdin',
      '-protocol_whitelist', 'file',
      '-i', inputPath,
      '-c:a', 'copy',         // copy audio stream tanpa re-encode (lossless)
      '-vn',                  // buang semua stream video (cover art, dll)
      '-y', outputPath
    ];
    runFfmpeg(args).then(({ code, stderr }) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    }, reject);
  });
}

function getStreamInfo(filePath) {
  return new Promise((resolve) => {
    // ffprobe biasanya di PATH atau satu direktori dengan ffmpeg
    getFfprobePath().then((ffprobePath) => {
      const proc = spawn(ffprobePath, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-protocol_whitelist', 'file',
        filePath
      ], { timeout: 10000 });

      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.on('error', () => resolve(null));
      proc.on('exit', (code) => {
        if (code === 0) {
          try { resolve(JSON.parse(stdout)); } catch (_) { resolve(null); }
        } else {
          resolve(null);
        }
      });
    }, () => resolve(null));
  });
}

async function transcodeIfNeeded(filePath, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  console.log(`[TRANSCODE] transcodeIfNeeded: file="${fileName}", ext="${ext}"`);
  if (!NEEDS_TRANSCODE.includes(ext)) {
    console.log(`[TRANSCODE] ext "${ext}" TIDAK ada di NEEDS_TRANSCODE — skip transcode, kirim original`);
    return { filePath, fileName, fileSize: null, wasProcessed: false };
  }
  console.log(`[TRANSCODE] ext "${ext}" TERMASUK NEEDS_TRANSCODE — lanjut cek ffmpeg`);

  // Cek ffmpeg availability sekali aja (di-cache di server/ffmpeg.js).
  const ffmpegPath = await getFfmpegPath();
  if (!ffmpegPath) {
    console.log('[TRANSCODE] ffmpeg TIDAK tersedia — skip konversi video, kirim original');
    return { filePath, fileName, fileSize: null, wasProcessed: false };
  }
  console.log(`[TRANSCODE] ffmpeg tersedia di "${ffmpegPath}" — lanjut konversi`);

  // ===== Fix: Multer simpan file tanpa ekstensi, ffmpeg perlu ekstensi untuk deteksi format =====
  let inputPath = filePath;
  const inputExt = path.extname(filePath).toLowerCase();
  let tempLinkedPath = null;
  if (inputExt !== ext) {
    console.log(`[TRANSCODE] Input file gak punya ekstensi "${ext}" — bikin temp file dengan ekstensi`);
    tempLinkedPath = filePath + ext;
    try {
      fs.linkSync(filePath, tempLinkedPath);
      console.log(`[TRANSCODE] Hardlink dibuat: ${tempLinkedPath}`);
    } catch (_) {
      try {
        fs.symlinkSync(filePath, tempLinkedPath);
        console.log(`[TRANSCODE] Symlink dibuat: ${tempLinkedPath}`);
      } catch (_) {
        fs.copyFileSync(filePath, tempLinkedPath);
        console.log(`[TRANSCODE] Copy fallback: ${tempLinkedPath}`);
      }
    }
    inputPath = tempLinkedPath;
  }

  const outName = path.basename(fileName, ext) + '.mp4';
  const outDir = path.dirname(filePath);
  const outPath = path.join(outDir, outName);

  // Probe stream info biar tau ada video atau cuma audio
  const probe = await getStreamInfo(inputPath);

  const ffprobeFailed = !probe;
  let hasRealVideo, hasAttachedPic, hasAudio;

  if (ffprobeFailed) {
    console.log('[TRANSCODE] ffprobe gagal — fallback ke transcode .mp4 (tidak punya info stream)');
    hasRealVideo = false; hasAttachedPic = false; hasAudio = false;
  } else {
    hasRealVideo = probe?.streams?.some(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) || false;
    hasAttachedPic = probe?.streams?.some(s => s.codec_type === 'video' && s.disposition?.attached_pic === 1) || false;
    hasAudio = probe?.streams?.some(s => s.codec_type === 'audio') || false;
    console.log(`[TRANSCODE] Probe: hasRealVideo=${hasRealVideo}, hasAttachedPic=${hasAttachedPic}, hasAudio=${hasAudio}, streams=${probe?.streams?.length || 0}`);
  }

  if (!hasRealVideo && hasAudio) {
    // Audio-only (atau cuma ada album art): remux ke MP3
    const audioOutName = path.basename(fileName, ext) + '.mp3';
    const audioOutPath = path.join(outDir, audioOutName);
    console.log(`[Transfer] Audio-only file (album art ${hasAttachedPic ? 'ditemukan' : 'tidak ada'}) — remux ${fileName} → ${audioOutName}...`);
    try {
      const start = Date.now();
      await remuxToM4a(inputPath, audioOutPath);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const stat = fs.statSync(audioOutPath);
      console.log(`[Transfer] ✅ Remux selesai (${elapsed}s): ${audioOutName} (${stat.size} bytes)`);
      return { filePath: audioOutPath, fileName: audioOutName, fileSize: stat.size, wasProcessed: true };
    } catch (err) {
      console.warn(`[Transfer] Remux gagal: ${err.message} — kirim original`);
      try { fs.unlinkSync(audioOutPath); } catch (_) {}
      return { filePath, fileName, fileSize: null, wasProcessed: false };
    }
  }

  try {
    console.log(`[Transfer] Mengonversi ${fileName} → ${outName}...`);
    const start = Date.now();
    await transcodeToMp4(inputPath, outPath);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const stat = fs.statSync(outPath);
    console.log(`[Transfer] ✅ Konversi selesai (${elapsed}s): ${outName} (${stat.size} bytes)`);
    return { filePath: outPath, fileName: outName, fileSize: stat.size, wasProcessed: true };
  } catch (err) {
    console.warn(`[Transfer] Konversi video gagal: ${err.message} — kirim original`);
    // Hapus file output kalau ada
    try { fs.unlinkSync(outPath); } catch (_) {}
    return { filePath, fileName, fileSize: null, wasProcessed: false };
  } finally {
    // Bersihin temp file/link
    if (tempLinkedPath) {
      try { fs.unlinkSync(tempLinkedPath); console.log(`[TRANSCODE] Temp file dibersihkan: ${tempLinkedPath}`); } catch (_) {}
    }
  }
}

// ===================== Raw Receive: baca file dari socket setelah handshake =====================
function startRawReceive(requestId, req) {
  const { socket } = req;

  // Lepas frame parser listener
  if (socket._parserHandler) {
    socket.removeListener('data', socket._parserHandler);
  }

  // Phase 1: baca satu frame metadata (file-start) dulu — actual fileSize + fileName
  let buf = Buffer.alloc(0);
  let expectedLen = null;

  const metaHandler = (data) => {
    buf = Buffer.concat([buf, data]);
    if (expectedLen === null) {
      if (buf.length < 4) return;
      expectedLen = buf.readUInt32BE(0);
      buf = buf.slice(4);
    }
    if (buf.length < expectedLen) return;

    // Dapet satu frame — parse
    try {
      const meta = JSON.parse(buf.slice(0, expectedLen).toString());
      if (meta.type === 'text') {
        // ===== Teks: baca sisa payload, simpan in-memory, TANPA tulis ke disk =====
        socket.removeListener('data', metaHandler);
        const textLength = meta.length || Infinity; // byte length payload UTF-8
        let chunks = [buf.slice(expectedLen)]; // data yang udah ikut dalam buffer
        let collected = chunks[0].length;
        let finished = false;

        // Teks bisa kepisah di beberapa packet TCP — kumpulin sampai lengkap
        const textHandler = (data) => {
          const need = textLength - collected;
          if (need <= 0) return;
          chunks.push(data.length > need ? data.slice(0, need) : data);
          collected += data.length > need ? need : data.length;
          if (collected >= textLength) {
            socket.removeListener('data', textHandler);
            finishText();
          }
        };
        socket.on('data', textHandler);
        socket.on('end', finishText); // fallback: socket nutup tanpa length eksplisit

        function finishText() {
          if (finished) return;
          finished = true;
          socket.removeListener('data', textHandler);
          const text = Buffer.concat(chunks).toString('utf-8');
          receivedTexts.push({ id: requestId, senderName: req.senderName, text, timestamp: Date.now() });
          if (receivedTexts.length > 50) receivedTexts.shift(); // batas kapasitas

          const p = transferProgress.get(requestId);
          if (p) { p.status = 'completed'; p.bytesTransferred = text.length; }
          req.status = 'completed';
          history.add({ direction: 'receive', fileName: 'Teks', fileSize: 0, peer: req.senderName });
          console.log(`[Transfer] ✅ ${requestId} — teks diterima (${text.length} chars) dari ${req.senderName}`);
          socket.end();
        }

        // Kalau teks singkat sudah kebaca semua di buffer awal
        if (collected >= textLength) {
          socket.removeListener('data', textHandler);
          finishText();
        }
      } else if (meta.type === 'file-start') {
        socket.removeListener('data', metaHandler);

        const actualSize = meta.fileSize;
        const safeName = sanitizeFileName(meta.fileName || req.fileName || 'file');
        // Key resume: pakai dari request frame (nama+size upload asli) supaya
        // stabil walaupun isinya dikonversi ffmpeg di sisi pengirim
        const transferKey = req.transferKey || makeTransferKey(req.senderName, req.batchId, safeName, actualSize);
        req.transferKey = transferKey;

        // ===== Guard ukuran nyata (transfer yang diterima otomatis) =====
        //
        // decideAutoAccept() hanya melihat ukuran yang DIKLAIM pengirim di
        // frame transfer-request. Ukuran yang benar-benar ditulis datang dari
        // frame ini, dan bisa jauh lebih besar (pengirim jahat, atau
        // transcoding ffmpeg di sisi pengirim yang membesarkan file).
        // Tanpa cek ulang, "fail-closed" cuma berlaku untuk pengirim jujur.
        if (!Number.isFinite(Number(actualSize)) || Number(actualSize) <= 0) {
          console.warn(`[Transfer] ⏸️ ${requestId} — ukuran file tidak masuk akal (${actualSize}), transfer dibatalkan`);
          socket.end();
          pendingRequests.delete(requestId);
          return;
        }

        // ===== Tujuan akhir: stream LANGSUNG ke folder tujuan =====
        // Dulu: tulis ke cwd/downloads dulu, lalu move ke folder tujuan.
        //   1. Windows, app install di Program Files → mkdirSync di cwd (folder
        //      install) bisa EPERM → throw di dalam 'data' handler → server mati.
        //   2. Android/Termux → rename lintas filesystem (internal → shared
        //      storage) gagal EXDEV → copy penuh + unlink, double I/O tiap file.
        // Sekarang: sekali tulis langsung ke tujuan, partial pakai suffix.
        let saveDir = resolveSaveDir(safeName);
        try {
          fs.mkdirSync(saveDir, { recursive: true });
        } catch (mkdirErr) {
          console.warn(`[Transfer] Folder tujuan ${saveDir} gagal dibuat (${mkdirErr.message}) — fallback ke folder internal`);
          saveDir = path.join(getDataDir(), 'downloads');
          fs.mkdirSync(saveDir, { recursive: true });
        }

        let displayName = safeName;
        let finalPath = path.join(saveDir, displayName);
        let partPath = finalPath + PART_SUFFIX;

        // ===== Resume: cek partial dari percobaan sebelumnya =====
        let startBytes = 0;
        const partMeta = readPartMeta(transferKey);
        if (partMeta && partMeta.actualFileSize === actualSize && partMeta.partPath) {
          try {
            const partSize = fs.statSync(partMeta.partPath).size;
            startBytes = Math.min(partMeta.bytesWritten, partSize);
            if (startBytes > 0) {
              partPath = partMeta.partPath;
              finalPath = partMeta.finalPath || finalPath;
              displayName = partMeta.actualFileName || displayName;
              // Pastikan isi part pas sebanyak offset yang dijanjikan pengirim
              if (partSize !== startBytes) fs.truncateSync(partPath, startBytes);
              console.log(`[Transfer] ${requestId} — RESUME dari byte ${startBytes}/${actualSize} (${Math.round((startBytes / actualSize) * 100)}%)`);
            }
          } catch (_) {}
        }

        // Bukan resume & nama file udah ada → tambah suffix (n), jangan nimpa
        if (startBytes === 0 && fs.existsSync(finalPath)) {
          const ext = path.extname(safeName);
          const base = path.basename(safeName, ext);
          for (let i = 1; i < 10000; i++) {
            const candidate = path.join(saveDir, `${base} (${i})${ext}`);
            if (!fs.existsSync(candidate)) {
              finalPath = candidate;
              displayName = path.basename(candidate);
              partPath = candidate + PART_SUFFIX;
              break;
            }
          }
        }

        // Init progress dengan ukuran beneran
        transferProgress.set(requestId, {
          fileName: displayName,
          fileSize: actualSize,
          bytesTransferred: startBytes,
          status: 'transferring',
          savePath: finalPath,
          resumed: startBytes > 0
        });

        // ===== Guard ruang disk dengan ukuran NYATA (transfer otomatis) =====
        // Cek terakhir sebelum menulis. Ukuran di frame file-start ini yang
        // benar-benar dipakai write stream, dan hanya sisa (actualSize -
        // startBytes) yang perlu ruang baru. Gagal ukur = jangan tebak.
        if (req.auto) {
          const free = getSaveDirFreeSpace();
          const remaining = actualSize - startBytes;
          if (free === null || remaining > free) {
            console.warn(`[Transfer] ⏸️ ${requestId} — ruang disk tidak cukup untuk sisa ${remaining} byte (terima otomatis), transfer dibatalkan`);
            transferProgress.delete(requestId);
            socket.end();
            pendingRequests.delete(requestId);
            return;
          }
        }

        // Part file: 'w' buat transfer baru, 'r+' + start offset buat lanjutan
        const writeStream = startBytes > 0
          ? fs.createWriteStream(partPath, { flags: 'r+', start: startBytes })
          : fs.createWriteStream(partPath);
        let written = startBytes;
        let lastMetaSave = 0;

        // Meta disimpan periodik (2 detik) — kalau proses mati mendadak
        // (SIGKILL / baterai habis), posisi terakhir tetap kedokongan.
        const persistPart = (force) => {
          const now = Date.now();
          if (!force && now - lastMetaSave < 2000) return;
          lastMetaSave = now;
          writePartMeta(transferKey, {
            saveDir,
            partPath,
            finalPath,
            fileName: safeName,
            actualFileName: displayName,
            actualFileSize: actualSize,
            bytesWritten: written
          });
        };
        persistPart(true);

        // Tulis sisa buffer dari frame parser (kalau ada data file yg ikut)
        const remaining = buf.slice(expectedLen);
        if (remaining.length > 0) {
          writeStream.write(remaining);
          written += remaining.length;
          const p = transferProgress.get(requestId);
          if (p) p.bytesTransferred = written;
        }

        // Manual data handler — stop pas ukuran tercapai.
        // WAJIB handle backpressure: kalau writeStream buffer penuh, socket di-pause.
        // Tanpa ini socket tetap flowing → semua byte di-queue di RAM receiver,
        // bukan throttled sama disk. Transfer besar mati ECONNRESET di tengah jalan.
        const dataHandler = (chunk) => {
          const need = actualSize - written;
          if (need <= 0) return;
          const toWrite = chunk.length > need ? chunk.slice(0, need) : chunk;
          const canContinue = writeStream.write(toWrite);
          written += toWrite.length;
          const p = transferProgress.get(requestId);
          if (p) p.bytesTransferred = written;
          persistPart(false);

          if (written >= actualSize) {
            // File selesai
            socket.removeListener('data', dataHandler);
            writeStream.end();
            return;
          }
          if (!canContinue) {
            socket.pause();
            writeStream.once('drain', () => socket.resume());
          }
        };
        socket.on('data', dataHandler);

        let peerEnded = false; // sender nutup bersih (FIN) = cancel eksplisit, bukan drop
        socket.on('end', () => { peerEnded = true; });

        socket.on('close', () => {
          const p = transferProgress.get(requestId);
          if (p && p.status === 'transferring') {
            if (req.cancelledByUser || peerEnded) {
              // Dibatalkan user / FIN sebelum lengkap → buang partial
              p.status = 'cancelled';
              writeStream.destroy();
              fs.unlink(partPath, () => {});
              deletePartMeta(transferKey);
            } else if (written >= actualSize) {
              p.status = 'completed';
            } else {
              // Koneksi mati mendadak → SIMPAN partial buat resume nanti
              p.status = 'failed';
              persistPart(true);
              console.log(`[Transfer] ⚠️ ${requestId} — putus di ${written}/${actualSize}, partial disimpan untuk resume`);
            }
          }
          req.status = p ? p.status : 'disconnected';
        });

        writeStream.on('finish', () => {
          const p = transferProgress.get(requestId);
          if (p) {
            p.status = 'completed';
            p.bytesTransferred = actualSize;
            p.savePath = finalPath;
          }
          req.status = 'completed';

          // Part → final: rename dalam satu folder = atomic, tanpa copy
          try {
            fs.renameSync(partPath, finalPath);
            deletePartMeta(transferKey);

            // Scan biar muncul di Galeri (khusus foto/video, Termux).
            //
            // PAKAI execFile, BUKAN exec: nama file datang dari peer dan
            // bisa mengandung karakter shell ($( ), backtick, ;). Dengan
            // exec, string itu dieksekusi shell = RCE di perangkat penerima.
            // execFile mem Passing argumen apa adanya, tanpa shell.
            const fileType = classifyFileType(safeName);
            if (isTermux() && (fileType === 'photo' || fileType === 'video')) {
              execFile('termux-media-scan', [finalPath], (err) => {
                if (err) {
                  // Fallback: am broadcast bawaan Android, gak butuh termux-api
                  console.warn(`[Transfer] termux-media-scan gagal (termux-api belum terinstall?), coba am broadcast: ${err.message}`);
                  const target = finalPath.replace(/^~\//, `${os.homedir()}/`).replace(/\\/g, '/');
                  execFile('am', [
                    'broadcast',
                    '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
                    '-d', `file://${encodeURI(target)}`
                  ], (err2) => {
                    if (err2) {
                      console.warn(`[Transfer] am broadcast scan gagal: ${err2.message}`);
                    } else {
                      console.log(`[Transfer] Media scan via am broadcast: ${target}`);
                    }
                  });
                } else {
                  console.log(`[Transfer] Media scan: ${finalPath}`);
                }
              });
            }

            if (p) p.savedTo = finalPath;

            // Daftarkan file ini supaya bisa di-thumbnail (foto/video).
            // Thumbnail dihitung server-side karena file-nya ada di
            // filesystem server, bukan di browser perangkat penerima.
            let thumbnailId = null;
            if (thumbnail.isThumbnailable(displayName)) {
              thumbnailId = thumbnail.registerFile(finalPath);
              if (p) p.thumbnailId = thumbnailId;
            }

            history.add({
              direction: 'receive',
              fileName: displayName,
              fileSize: actualSize,
              peer: req.senderName,
              savedTo: finalPath,
              thumbnailId,
              resumed: startBytes > 0
            });
            console.log(`[Transfer] ✅ ${requestId} — ${displayName} diterima (${actualSize} bytes) → ${finalPath}`);
          } catch (renameErr) {
            console.error(`[Transfer] Gagal finalisasi ${displayName}: ${renameErr.message} — partial tetap di ${partPath}`);
          }
          socket.end(); // sinyal ke pengirim
        });

        writeStream.on('error', (err) => {
          console.error(`[Transfer] Write error ${requestId}:`, err.message);
          const p = transferProgress.get(requestId);
          if (p) p.status = 'failed';
          req.status = 'failed';
          persistPart(true); // simpan posisi terakhir buat resume
          socket.end();
        });
      }
    } catch (_) {}
  };

  socket.on('data', metaHandler);
}

// ===================== Terima Otomatis (auto-approve) =====================
/**
 * Putuskan permintaan file ini diterima tanpa modal?
 *
 * Dijalankan di SERVER, bukan frontend: polling frontend berhenti saat tab
 * disembunyikan, jadi kalau logikanya di sana mode "drop box" cuma jalan
 * selama ada yang menatap layar.
 *
 * Ukuran di sini datang dari frame `transfer-request` — itu klaim pengirim,
 * bukan fakta. Cek ini hanya penyaring awal; ukuran yang benar-benar ditulis
 * dicek ulang di `file-start` (lihat guard di startRawReceive). Tanpa cek
 * kedua itu, peer bisa mengaku file 1 byte lalu mengirim 50 GB.
 *
 * Gagal cek disk = TOLAK (fail-closed). Mengisi disk sampai penuh bikin
 * perangkat penerima tidak bisa dipakai sama sekali.
 *
 * @param {{senderName: string, fileSize: number}} msg
 * @param {number} [resumeOffset] byte yang sudah ada di disk (tidak perlu ruang baru)
 * @returns {{accept: boolean, reason?: string}}
 */
function decideAutoAccept(msg, resumeOffset = 0) {
  if (!settings.isAutoApprovePeer(msg.senderName)) return { accept: false };

  const size = Number(msg.fileSize);
  // Ukuran tidak diketahui → tidak bisa dijamin muat. Jangan tebak.
  if (!Number.isFinite(size) || size <= 0) {
    return { accept: false, reason: 'Ukuran file tidak diketahui, terima otomatis dilewati' };
  }

  const free = getSaveDirFreeSpace();
  if (free === null) {
    return { accept: false, reason: 'Penerima tidak bisa memeriksa ruang disk, kiriman otomatis dilewati' };
  }

  // Sisa yang masih perlu ditulis, bukan ukuran penuh — kalau tidak, transfer
  // yang bisa dilanjutkan (partial sudah 90%) ditolak terus selamanya.
  const remaining = Math.max(0, size - Number(resumeOffset || 0));
  if (remaining > free) {
    return { accept: false, reason: 'Ruang disk penerima tidak cukup untuk terima otomatis' };
  }

  return { accept: true };
}

// ===================== TCP Server (Penerima) =====================
function startTransferServer() {
  cleanupStale(); // buang upload & partial yang udah kedaluwarsa
  ensureSaveDirExists(); // pastikan D:\LAN-DROP ada dari awal
  tcpServer = net.createServer((socket) => {
    console.log(`[Transfer] 📥 Incoming TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);
    const parser = new FrameParser((msg) => {
      if (msg.type === 'transfer-request') {
        const requestId = crypto.randomBytes(4).toString('hex');
        // Key resume: identitas stabil pengirim+file. Kalau pengirim ngirim
        // ulang file yang sama (retry setelah putus), key-nya sama dan
        // penerima bisa lanjutin dari partial sebelumnya.
        const transferKey = msg.kind === 'text'
          ? null
          : makeTransferKey(msg.senderName, msg.batchId, msg.fileName, msg.fileSize);
        const entry = {
          socket,
          parser,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          senderName: msg.senderName,
          senderId: msg.senderId,
          batchId: msg.batchId, // optional: grouping multi-file
          kind: msg.kind,       // 'file' | 'text' — text langsung diterima, tanpa modal
          transferKey,
          resumeOffset: 0,
          status: 'pending',
          createdAt: Date.now()
        };

        // Kalau ada partial untuk file ini, ikutkan offset di response accept
        if (transferKey) {
          const partMeta = readPartMeta(transferKey);
          if (partMeta && partMeta.bytesWritten > 0 && partMeta.partPath) {
            try {
              entry.resumeOffset = Math.min(partMeta.bytesWritten, fs.statSync(partMeta.partPath).size);
              console.log(`[Transfer] Partial ditemukan untuk ${msg.fileName} — tawarkan resume dari byte ${entry.resumeOffset}`);
            } catch (_) {}
          }
        }

        pendingRequests.set(requestId, entry);
        console.log(`[Transfer] Incoming request ${requestId}: ${msg.fileName} (${msg.fileSize} bytes) from ${msg.senderName}`);

        // Text: langsung auto-accept + terima frame isi, tanpa menunggu modal
        if (msg.kind === 'text') {
          respondToRequest(requestId, true);
          return;
        }

        // Terima otomatis (kalau diaktifkan) — jalan tanpa frontend.
        const decision = decideAutoAccept(msg, entry.resumeOffset);
        if (decision.accept) {
          entry.auto = true;
          console.log(`[Transfer] ⚡ ${requestId} diterima otomatis dari ${msg.senderName}`);
          respondToRequest(requestId, true);
        } else if (decision.reason) {
          console.log(`[Transfer] ⏸️ ${requestId} tidak diterima otomatis: ${decision.reason}`);
          respondToRequest(requestId, false, decision.reason);
        }
      }
    });

    const dataHandler = (data) => parser.feed(data);
    socket._parserHandler = dataHandler;
    socket.on('data', dataHandler);
    socket.on('error', () => {});
    socket.on('close', () => {
      // Socket tertutup = transfer ini tidak akan bergerak lagi. Entri
      // pendingRequests WAJIB dibuang apa pun statusnya, kalau tidak Map-nya
      // tumbuh terus dan frontend melihat "permintaan" hantu yang tak pernah
      // selesai (progresnya 404 selamanya, polling tidak pernah berhenti).
      // Progres akhir tetap terbaca dari transferProgress, yang Map terpisah.
      for (const [id, req] of pendingRequests) {
        if (req.socket !== socket) continue;
        if (req.status === 'pending') {
          console.log(`[Transfer] Request ${id} cancelled — sender disconnected`);
        } else if (req.status === 'accepted') {
          console.log(`[Transfer] Request ${id} selesai tanpa transfer — entri dibuang (${req.status})`);
        }
        pendingRequests.delete(id);
        break;
      }
    });
  });

  tcpServer.listen(TRANSFER_PORT, '0.0.0.0', () => {
    console.log(`[Transfer] TCP server listening on port ${TRANSFER_PORT}`);
  });

  tcpServer.on('error', (err) => {
    console.error('[Transfer] TCP server error:', err.message);
  });
}

// ===================== TCP Client (Pengirim) =====================
function sendTransferRequest(targetIp, targetPort, metadata) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const route = isTailscaleIPv4(targetIp) ? 'tailscale' : 'lan';
  console.log(`[Transfer] 🔌 → ${metadata.fileName} ke ${metadata.peerName || targetIp} (${targetIp}:${targetPort}) via ${route} [requestId=${requestId}]`);
  const connectTimer = setTimeout(() => {
    console.error(`[Transfer] ⏰ TIMEOUT connecting to ${targetIp}:${targetPort} (requestId=${requestId}) — port unreachable? Peer mungkin mati, atau firewall memblokir jalur ${route}.`);
    socket.destroy();
  }, 5000);
  const socket = net.createConnection({ host: targetIp, port: targetPort }, () => {
    console.log(`[Transfer] ✅ TCP connected to ${targetIp}:${targetPort} (requestId=${requestId})`);
    if (connectTimer) clearTimeout(connectTimer);
    sendFramedMessage(socket, {
      type: 'transfer-request',
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      senderName: metadata.senderName,
      senderId: metadata.senderId,
      batchId: metadata.batchId, // optional: grouping multi-file
      kind: metadata.kind || 'file'
    });
  });

  const parser = new FrameParser((msg) => {
    if (msg.type === 'transfer-response') {
      const req = outgoingRequests.get(requestId);
      if (!req) return;

      req.status = msg.accepted ? 'accepted' : 'rejected';
      req.responseAt = Date.now();
      // Alasan penolakan dari penerima (mis. ruang disk tidak cukup).
      req.rejectMessage = msg.accepted ? null : (msg.message || null);
      // Penerima punya partial file ini → lanjutkan dari offset, bukan dari nol
      req.resumeOffset = (msg.accepted && msg.resumeOffset) || 0;

      if (!msg.accepted) {
        socket.end();
      }
      // kalau accepted — socket tetap hidup, parser siap dilepas nanti pas startFileSend
    }
  });

  const dataHandler = (data) => parser.feed(data);
  socket._parserHandler = dataHandler;
  socket.on('data', dataHandler);
  socket.on('error', (err) => {
    if (connectTimer) clearTimeout(connectTimer);
    console.error(`[Transfer] ❌ TCP error connecting to ${targetIp}:${targetPort} (requestId=${requestId}): ${err.code} — ${err.message}`);
    cleanupOutgoing(requestId);
  });
  socket.on('close', () => {
    const req = outgoingRequests.get(requestId);
    if (req && req.status === 'pending') {
      req.status = 'disconnected';
    }
  });

  outgoingRequests.set(requestId, {
    socket,
    parserHandler: dataHandler,
    status: 'pending',
    targetIp,
    targetPort,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    batchId: metadata.batchId, // optional: grouping multi-file
    peerName: metadata.peerName, // untuk history
    createdAt: Date.now()
  });

  return { requestId };
}

// ===================== Start File Send (dipanggil setelah accepted) =====================
async function startFileSend(requestId, filePath) {
  const req = outgoingRequests.get(requestId);
  if (!req) throw new Error(`Request ${requestId} not found`);
  if (req.status !== 'accepted') throw new Error(`Request ${requestId} status is "${req.status}", expected "accepted"`);

  const { socket } = req;

  // Lepas frame parser dari socket — beralih ke raw streaming
  if (req.parserHandler) {
    socket.removeListener('data', req.parserHandler);
  }

  // Validasi file — path WAJIB di dalam folder upload.
  // Path datang dari body request, jadi tanpa batas folder upload
  // siapa pun yang bisa njangkau port ini bisa baca file privat server.
  const safeFilePath = assertInsideUploads(filePath);
  if (!fs.existsSync(safeFilePath)) throw new Error(`File not found: ${path.basename(safeFilePath)}`);

  // ===== Transcoding: konversi video yg mungkin gak di-support HP =====
  let sendFilePath = safeFilePath;
  let sendFileName = req.fileName;
  let sendFileSize = null;

  const transResult = await transcodeIfNeeded(safeFilePath, req.fileName);
  console.log(`[SEND_FILE] transResult: filePath="${transResult.filePath}", fileName="${transResult.fileName}", fileSize=${transResult.fileSize}`);
  sendFilePath = transResult.filePath;
  if (transResult.fileSize !== null) {
    console.log(`[SEND_FILE] transResult.fileSize !== null — UPDATE sendFileName "${sendFileName}" → "${transResult.fileName}"`);
    sendFileName = transResult.fileName;
    sendFileSize = transResult.fileSize;
  } else {
    console.log(`[SEND_FILE] transResult.fileSize === null — TIDAK update sendFileName, tetap "${sendFileName}"`);
  }

  // ===== Resume: kalau penerima masih punya partial, lanjut dari offset =====
  const resumeOffset = req.resumeOffset || 0;
  if (resumeOffset > 0) {
    console.log(`[SEND_FILE] Resume — mulai kirim dari byte ${resumeOffset}`);
  }

  const stat = fs.statSync(sendFilePath);
  const actualSize = sendFileSize || stat.size;

  // Update ukuran & fileName (kalau berubah karena konversi)
  req.fileSize = actualSize;
  if (sendFileName !== req.fileName) {
    req.fileName = sendFileName;
  }

  // Init progress — bytesTransferred mulai dari offset resume biar % akurat
  transferProgress.set(requestId, {
    fileName: sendFileName,
    fileSize: actualSize,
    bytesTransferred: resumeOffset,
    status: 'transferring',
    resumed: resumeOffset > 0
  });

  // Kirim metadata actual file size dulu sebelum raw stream
  console.log(`[SEND_FILE] ⚠️⚠️⚠️ sendFileName PERSIS sebelum file-start frame: "${sendFileName}"`);
  console.log(`[SEND_FILE] ⚠️⚠️⚠️ sendFilePath: "${sendFilePath}", actualSize: ${actualSize}`);
  console.log(`[SEND_FILE] ⚠️⚠️⚠️ sendFileName === req.fileName? ${sendFileName === req.fileName}`);
  sendFramedMessage(socket, {
    type: 'file-start',
    fileName: sendFileName,
    fileSize: actualSize
  });

  const readStream = resumeOffset > 0
    ? fs.createReadStream(sendFilePath, { start: resumeOffset })
    : fs.createReadStream(sendFilePath);
  req.readStream = readStream;

  readStream.on('data', (chunk) => {
    const p = transferProgress.get(requestId);
    if (p) p.bytesTransferred += chunk.length;
  });

  readStream.on('error', (err) => {
    console.error(`[Transfer] Read error ${requestId}:`, err.message);
    const p = transferProgress.get(requestId);
    if (p) p.status = 'failed';
    req.status = 'failed';
    socket.end();
  });

  readStream.on('end', () => {
    console.log(`[Transfer] 📤 ${requestId} — all bytes sent, waiting for receiver confirm`);
  });

  // Pipe file — end:false karena kita tunggu receiver nutup koneksi
  readStream.pipe(socket, { end: false });

  socket.on('close', () => {
    const p = transferProgress.get(requestId);
    if (p && p.status === 'transferring') {
      if (req.cancelledByUser) {
        p.status = 'cancelled';
      } else if (p.bytesTransferred >= p.fileSize) {
        p.status = 'completed';
      } else {
        p.status = 'failed';
      }
    }
    req.status = p ? p.status : 'disconnected';
    console.log(`[Transfer] ${p && p.status === 'completed' ? '✅' : '⚠️'} ${requestId} — transfer ${p ? p.status : 'disconnected'} (${p ? p.bytesTransferred + '/' + p.fileSize : 0} bytes)`);

    const finalStatus = p && p.status !== 'transferring' ? p.status : 'disconnected';
    if (finalStatus !== 'transferring') {
      history.add({
        direction: 'send',
        fileName: sendFileName,
        fileSize: actualSize,
        peer: req.peerName || req.targetIp,
        status: finalStatus,
        resumed: resumeOffset > 0
      });
    }

    // Bersihkan file upload HANYA kalau bener-bener kelar atau user batal
    // eksplisit. Partial sengaja DIPERTAHANKAN supaya bisa di-retry/resume
    // kalau koneksi mati sendiri. File >7 hari dibersihin cleanupStale().
    if (finalStatus === 'completed' || finalStatus === 'cancelled') {
      // Hapus upload asli maupun output transcode. Kalau sama (tanpa
      // konversi), unlink dua kali; error ENOENT diabaikan.
      for (const f of new Set([filePath, sendFilePath])) {
        if (!f) continue;
        fs.unlink(f, (err) => {
          if (err && err.code !== 'ENOENT') {
            console.warn(`[Transfer] Gagal hapus file upload ${f}: ${err.message}`);
          }
        });
      }
    } else {
      console.log(`[Transfer] Upload dipertahankan untuk resume: ${sendFilePath}`);
    }
  });

  return { requestId, fileSize: actualSize };
}

// ===================== Start Text Send (dipanggil setelah accepted) =====================
async function startTextSend(requestId, text) {
  const req = outgoingRequests.get(requestId);
  if (!req) throw new Error(`Request ${requestId} not found`);
  if (req.status !== 'accepted') throw new Error(`Request ${requestId} status is "${req.status}", expected "accepted"`);

  const { socket } = req;

  // Lepas frame parser dari socket — beralih ke raw streaming
  if (req.parserHandler) {
    socket.removeListener('data', req.parserHandler);
  }

  // Init progress
  transferProgress.set(requestId, {
    fileName: 'Teks',
    fileSize: Buffer.byteLength(text, 'utf-8'),
    bytesTransferred: 0,
    status: 'transferring'
  });

  // Frame metadata type=text, lalu payload UTF-8 mentah
  sendFramedMessage(socket, { type: 'text', length: Buffer.byteLength(text, 'utf-8') });
  socket.write(Buffer.from(text, 'utf-8'));

  socket.on('close', () => {
    const p = transferProgress.get(requestId);
    if (p && p.status === 'transferring') p.status = 'completed';
    req.status = 'completed';
    history.add({
      direction: 'send',
      fileName: 'Teks',
      fileSize: Buffer.byteLength(text, 'utf-8'),
      peer: req.peerName || req.targetIp
    });
    console.log(`[Transfer] ✅ ${requestId} — teks terkirim, dikonfirmasi penerima`);
  });

  return { requestId };
}

// ===================== Respond Accept/Reject =====================
/**
 * @param {string} requestId
 * @param {boolean} accepted
 * @param {string} [message] alasan penolakan otomatis, diteruskan ke pengirim
 */
function respondToRequest(requestId, accepted, message) {
  const req = pendingRequests.get(requestId);
  if (!req) throw new Error(`Request ${requestId} not found`);
  if (req.status !== 'pending') throw new Error(`Request ${requestId} already ${req.status}`);

  req.status = accepted ? 'accepted' : 'rejected';
  req.rejectMessage = accepted ? null : (message || null);

  if (accepted) {
    // resumeOffset: penerima punya partial → pengirim lanjut dari sini, bukan dari nol
    sendFramedMessage(req.socket, { type: 'transfer-response', accepted: true, resumeOffset: req.resumeOffset || 0 });
    // Mulai raw receive — parser akan dilepas di dalam startRawReceive
    startRawReceive(requestId, req);
    // Entri TIDAK dihapus di sini: alur penerimaan masih butuh `req`
    // (transferKey, status, senderName) untuk menulis file dan mencatat
    // riwayat. Yang menghapusnya: 'finish'/'error' di startRawReceive, atau
    // handler 'close' di bawah kalau pengirim menghilang sebelum file-start.
  } else {
    sendFramedMessage(req.socket, {
      type: 'transfer-response',
      accepted: false,
      message: req.rejectMessage || 'Ditolak oleh penerima'
    });
    req.socket.end();
    pendingRequests.delete(requestId);
  }

  return { requestId, status: req.status, message: req.rejectMessage };
}

// ===================== Progress =====================
function getTransferProgress(requestId) {
  const p = transferProgress.get(requestId);
  if (!p) return null;
  const percent = p.fileSize > 0 ? Math.round((p.bytesTransferred / p.fileSize) * 100) : 0;

  return {
    requestId,
    fileName: p.fileName,
    fileSize: p.fileSize,
    bytesTransferred: p.bytesTransferred,
    percent,
    status: p.status,
    savePath: p.savePath,
    savedTo: p.savedTo,
    thumbnailId: p.thumbnailId || null
  };
}

// ===================== Public API =====================
function getPendingRequests() {
  const result = [];
  for (const [id, req] of pendingRequests) {
    result.push({
      requestId: id,
      fileName: req.fileName,
      fileSize: req.fileSize,
      senderName: req.senderName,
      senderId: req.senderId,
      batchId: req.batchId,
      kind: req.kind || 'file',
      auto: !!req.auto,
      status: req.status,
      createdAt: req.createdAt
    });
  }
  return result;
}

// Teks masuk disimpan in-memory, frontend polling lalu hapus. Teks >10 menit dibersihkan.
function getReceivedTexts() {
  const now = Date.now();
  receivedTexts = receivedTexts.filter(t => now - t.timestamp < TEXT_TTL);
  return receivedTexts.slice();
}

function consumeReceivedText(textId) {
  const idx = receivedTexts.findIndex(t => t.id === textId);
  if (idx === -1) return false;
  receivedTexts.splice(idx, 1);
  return true;
}

function getRequestStatus(requestId) {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    return { requestId, status: pending.status, role: 'receiver' };
  }

  const outgoing = outgoingRequests.get(requestId);
  if (outgoing) {
    return {
      requestId,
      status: outgoing.status,
      role: 'sender',
      resumeOffset: outgoing.resumeOffset || 0,
      // Alasan penolakan dari penerima (mis. ruang disk tidak cukup untuk
      // terima otomatis). null kalau ditolak manual tanpa pesan.
      reason: outgoing.rejectMessage || null
    };
  }

  return null;
}

function cancelOutgoingTransfer(requestId) {
  const req = outgoingRequests.get(requestId);
  if (!req) throw new Error(`Request ${requestId} not found`);
  if (req.status === 'completed' || req.status === 'failed' || req.status === 'cancelled' || req.status === 'rejected') {
    throw new Error('Transfer sudah selesai, tidak bisa dibatalkan');
  }
  req.cancelledByUser = true; // flag eksplisit: user beneran klik Batal, bukan koneksi drop
  if (req.readStream) {
    try { req.readStream.destroy(); } catch (_) {}
  }
  if (req.socket) {
    // FIN doang (graceful), TANPA destroy — biar FIN beneran sampe ke penerima.
    // Kalau destroy menyusul, jadi RST & penerima gak bisa bedain cancel vs drop.
    try { req.socket.end(); } catch (_) {}
  }
  const p = transferProgress.get(requestId);
  if (p) p.status = 'cancelled';
  outgoingRequests.delete(requestId);
}

function cancelIncomingTransfer(requestId) {
  const req = pendingRequests.get(requestId);
  if (!req) throw new Error(`Request ${requestId} not found`);
  if (req.status === 'completed' || req.status === 'failed' || req.status === 'cancelled' || req.status === 'rejected') {
    throw new Error('Transfer sudah selesai, tidak bisa dibatalkan');
  }
  req.cancelledByUser = true; // flag eksplisit: user beneran klik Batal, bukan koneksi drop
  if (req.socket) req.socket.destroy();
  const p = transferProgress.get(requestId);
  if (p) p.status = 'cancelled';
  pendingRequests.delete(requestId);
}

function stopTransferServer() {
  if (tcpServer) { tcpServer.close(); tcpServer = null; }
  for (const [, req] of pendingRequests) { if (req.socket) req.socket.destroy(); }
  pendingRequests.clear();
  for (const [, req] of outgoingRequests) { if (req.socket) req.socket.destroy(); }
  outgoingRequests.clear();
}

function cleanupOutgoing(requestId) {
  const req = outgoingRequests.get(requestId);
  if (req) {
    if (req.socket && req.status !== 'accepted') req.socket.destroy();
    outgoingRequests.delete(requestId);
  }
}

module.exports = {
  startTransferServer,
  stopTransferServer,
  sendTransferRequest,
  respondToRequest,
  startFileSend,
  startTextSend,
  getTransferProgress,
  getPendingRequests,
  getReceivedTexts,
  consumeReceivedText,
  getRequestStatus,
  cancelOutgoingTransfer,
  cancelIncomingTransfer,
  assertInsideUploads, // diekspor buat regression test (scripts/check-security.js)
  TRANSFER_PORT
};
