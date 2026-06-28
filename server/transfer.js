const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const { isTermux, isWindows } = require('./platform');

// ===================== Konstanta =====================
const TRANSFER_PORT = parseInt(process.env.TRANSFER_PORT) || 3001;

// ===================== State =====================
const pendingRequests = new Map(); // requestId -> { socket, parser, fileName, fileSize, senderName, senderId, status, createdAt }
const outgoingRequests = new Map(); // requestId -> { socket, parserHandler, status, targetIp, targetPort, fileName, fileSize, createdAt }
const transferProgress = new Map(); // requestId -> { fileName, fileSize, bytesTransferred, status, savePath? }
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

function classifyFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (PHOTO_EXTENSIONS.includes(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  return 'other';
}

// ===================== Auto-Save: Directory Resolution =====================
const WINDOWS_PREFERRED_DIR = 'D:\\Downloads\\Download - Lan Drop';

function getWindowsSaveDir() {
  try {
    fs.accessSync('D:\\');
    return WINDOWS_PREFERRED_DIR;
  } catch (_) {
    const fallback = path.join(os.homedir(), 'Downloads', 'Download - Lan Drop');
    console.warn(`[Transfer] Drive D: tidak ditemukan, fallback simpan ke: ${fallback}`);
    return fallback;
  }
}

function getTermuxStorageDir(category) {
  // category: 'pictures' | 'movies' | 'downloads'
  const dir = path.join(os.homedir(), 'storage', category);
  if (fs.existsSync(dir)) {
    return dir;
  }
  console.warn(`[Transfer] ~/storage/${category} tidak ditemukan (mungkin termux-setup-storage belum dijalankan). Fallback ke folder internal.`);
  return null;
}

// ===================== Video Transcoding =====================
// Format video lama/yang mungkin gak di-support native HP → konversi ke H.264 .mp4
const NEEDS_TRANSCODE = ['.mpeg', '.mpg', '.avi', '.mkv', '.webm', '.mov', '.3gp', '.flv', '.ts'];

// Lokasi umum ffmpeg di Windows (winget, manual install, dll)
const FFMPEG_CANDIDATES = [
  'ffmpeg',
  'ffmpeg.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.1.1-full_build', 'bin', 'ffmpeg.exe'),
  path.join(process.env.ProgramFiles || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(process.env.ProgramW6432 || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(os.homedir(), 'ffmpeg', 'bin', 'ffmpeg.exe'),
];

let _ffmpegPath = undefined; // undefined=belum cek, false=cek&gakada, string=path

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

function transcodeToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y', outputPath
    ];
    const proc = spawn(_ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

function remuxToM4a(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Output: MP3 container. Audio MP3 → copy murni tanpa re-encode.
    // Kenapa MP3, bukan M4A? Karena audio asli file-file ini adalah MP3,
    // dan container M4A (format ipod) tidak support MP3 — cuma AAC/ALAC.
    // Dengan MP3 container, copy murni jadi super cepat dan lossless.
    const args = [
      '-i', inputPath,
      '-c:a', 'copy',         // copy audio stream tanpa re-encode (lossless)
      '-vn',                  // buang semua stream video (cover art, dll)
      '-y', outputPath
    ];
    const proc = spawn(_ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

function getStreamInfo(filePath) {
  return new Promise((resolve) => {
    // ffprobe biasanya di PATH atau satu direktori dengan ffmpeg
    const ffprobePath = _ffmpegPath
      ? _ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => 'ffprobe' + m.slice(6))
      : 'ffprobe';
    const proc = spawn(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
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

  // Cek ffmpeg availability sekali aja
  if (_ffmpegPath === undefined) {
    console.log('[TRANSCODE] _ffmpegPath masih undefined, akan jalankan checkFfmpeg()...');
    const ok = await checkFfmpeg();
    if (!ok) {
      _ffmpegPath = false; // cache negative result
      console.log('[TRANSCODE] ffmpeg TIDAK tersedia — skip konversi video, kirim original');
    } else {
      console.log(`[TRANSCODE] ffmpeg tersedia di "${_ffmpegPath}" — lanjut konversi`);
    }
  } else if (_ffmpegPath === false) {
    console.log('[TRANSCODE] _ffmpegPath = false (cache negatif) — ffmpeg sebelumnya gak ketemu, kirim original');
  } else {
    console.log(`[TRANSCODE] _ffmpegPath sudah terisi = "${_ffmpegPath}" — lanjut konversi langsung`);
  }
  if (!_ffmpegPath) {
    console.log('[TRANSCODE] _ffmpegPath falsy — FALLBACK: kirim original tanpa konversi');
    return { filePath, fileName, fileSize: null, wasProcessed: false };
  }

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

// ===================== Auto-Save: Move File (rename fallback copy+unlink) =====================
function moveFile(source, destination) {
  return new Promise((resolve, reject) => {
    fs.rename(source, destination, (err) => {
      if (!err) return resolve();

      if (err.code === 'EXDEV') {
        // Lintas filesystem — copy dulu baru unlink
        const readStream = fs.createReadStream(source);
        const writeStream = fs.createWriteStream(destination);

        readStream.on('error', reject);
        writeStream.on('error', reject);

        writeStream.on('finish', () => {
          fs.unlink(source, (unlinkErr) => {
            if (unlinkErr) console.warn(`[Transfer] Gagal hapus file source setelah copy: ${unlinkErr.message}`);
            resolve();
          });
        });

        readStream.pipe(writeStream);
      } else {
        reject(err);
      }
    });
  });
}

// ===================== Raw Receive: baca file dari socket setelah handshake =====================
function startRawReceive(requestId, req) {
  const { socket } = req;

  // Lepas frame parser listener
  if (socket._parserHandler) {
    socket.removeListener('data', socket._parserHandler);
  }

  // Buat folder downloads
  const downloadsDir = path.join(process.cwd(), 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });

  // Phase 1: baca satu frame metadata (file-start) dulu — actual fileSize + fileName
  let buf = Buffer.alloc(0);
  let expectedLen = null;
  let metadataRead = false;

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
      if (meta.type === 'file-start') {
        metadataRead = true;
        socket.removeListener('data', metaHandler);
        const safeName = path.basename(meta.fileName || req.fileName);
        const savePath = path.join(downloadsDir, safeName);
        const totalSize = meta.fileSize;

        // Init progress dengan ukuran beneran
        transferProgress.set(requestId, {
          fileName: safeName,
          fileSize: totalSize,
          bytesTransferred: 0,
          status: 'transferring',
          savePath
        });

        const writeStream = fs.createWriteStream(savePath);
        let written = 0;

        // Tulis sisa buffer dari frame parser (kalau ada data file yg ikut)
        const remaining = buf.slice(expectedLen);
        if (remaining.length > 0) {
          writeStream.write(remaining);
          written += remaining.length;
          const p = transferProgress.get(requestId);
          if (p) p.bytesTransferred = written;
        }

        // Manual data handler — stop pas ukuran tercapai
        const dataHandler = (chunk) => {
          const need = totalSize - written;
          if (need <= 0) return;
          const toWrite = chunk.length > need ? chunk.slice(0, need) : chunk;
          writeStream.write(toWrite);
          written += toWrite.length;
          const p = transferProgress.get(requestId);
          if (p) p.bytesTransferred = written;

          if (written >= totalSize) {
            // File selesai
            socket.removeListener('data', dataHandler);
            writeStream.end();
          }
        };
        socket.on('data', dataHandler);

        writeStream.on('finish', async () => {
          const p = transferProgress.get(requestId);
          if (p) {
            p.status = 'completed';
            p.bytesTransferred = totalSize;
            p.savePath = savePath; // internal path
          }
          req.status = 'completed';

          // ===== Auto-Save: Pindah file ke folder sesuai platform =====
          let finalPath = savePath; // default: tetap di internal

          try {
            if (isWindows()) {
              const targetDir = getWindowsSaveDir();
              if (targetDir) {
                fs.mkdirSync(targetDir, { recursive: true });
                const targetPath = path.join(targetDir, safeName);
                await moveFile(savePath, targetPath);
                finalPath = targetPath;
                console.log(`[Transfer] File disimpan ke: ${targetPath}`);
              }
            } else if (isTermux()) {
              const fileType = classifyFileType(safeName);
              const category = fileType === 'photo' ? 'pictures' : fileType === 'video' ? 'movies' : 'downloads';
              const storageDir = getTermuxStorageDir(category);
              if (storageDir) {
                fs.mkdirSync(storageDir, { recursive: true });
                const targetPath = path.join(storageDir, safeName);
                await moveFile(savePath, targetPath);
                finalPath = targetPath;
                console.log(`[Transfer] File disimpan ke: ${targetPath}`);

                // Scan biar muncul di Galeri (khusus foto/video)
                if (fileType === 'photo' || fileType === 'video') {
                  exec(`termux-media-scan "${targetPath}"`, (err) => {
                    if (err) {
                      console.warn(`[Transfer] termux-media-scan gagal (mungkin termux-api belum terinstall): ${err.message}`);
                    }
                  });
                }
              }
            }
            // Platform lain (Linux desktop, dll): tetap di internal — no-op
          } catch (moveErr) {
            console.error(`[Transfer] Gagal pindah file ke folder tujuan: ${moveErr.message} — file tetap aman di ${savePath}`);
            // File tetap valid di internal, transfer tetap sukses
          }

          // Update savedTo di progress
          if (p) p.savedTo = finalPath;

          console.log(`[Transfer] ✅ ${requestId} — ${meta.fileName} received (${totalSize} bytes)`);
          socket.end(); // sinyal ke pengirim
        });

        writeStream.on('error', (err) => {
          console.error(`[Transfer] Write error ${requestId}:`, err.message);
          const p = transferProgress.get(requestId);
          if (p) p.status = 'failed';
          req.status = 'failed';
          socket.end();
        });
      }
    } catch (_) {}
  };

  socket.on('data', metaHandler);
}

// ===================== TCP Server (Penerima) =====================
function startTransferServer() {
  tcpServer = net.createServer((socket) => {
    const parser = new FrameParser((msg) => {
      if (msg.type === 'transfer-request') {
        const requestId = crypto.randomBytes(4).toString('hex');
        pendingRequests.set(requestId, {
          socket,
          parser,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          senderName: msg.senderName,
          senderId: msg.senderId,
          status: 'pending',
          createdAt: Date.now()
        });
        console.log(`[Transfer] Incoming request ${requestId}: ${msg.fileName} (${msg.fileSize} bytes) from ${msg.senderName}`);
      }
    });

    const dataHandler = (data) => parser.feed(data);
    socket._parserHandler = dataHandler;
    socket.on('data', dataHandler);
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const [id, req] of pendingRequests) {
        if (req.socket === socket) {
          if (req.status === 'pending') {
            console.log(`[Transfer] Request ${id} cancelled — sender disconnected`);
            pendingRequests.delete(id);
          }
          break;
        }
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
  const socket = net.createConnection({ host: targetIp, port: targetPort }, () => {
    sendFramedMessage(socket, {
      type: 'transfer-request',
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      senderName: metadata.senderName,
      senderId: metadata.senderId
    });
  });

  const parser = new FrameParser((msg) => {
    if (msg.type === 'transfer-response') {
      const req = outgoingRequests.get(requestId);
      if (!req) return;

      req.status = msg.accepted ? 'accepted' : 'rejected';
      req.responseAt = Date.now();

      if (!msg.accepted) {
        socket.end();
      }
      // kalau accepted — socket tetap hidup, parser siap dilepas nanti pas startFileSend
    }
  });

  const dataHandler = (data) => parser.feed(data);
  socket._parserHandler = dataHandler;
  socket.on('data', dataHandler);
  socket.on('error', () => cleanupOutgoing(requestId));
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

  // Validasi file
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  // ===== Transcoding: konversi video yg mungkin gak di-support HP =====
  let sendFilePath = filePath;
  let sendFileName = req.fileName;
  let sendFileSize = null;

  const transResult = await transcodeIfNeeded(filePath, req.fileName);
  console.log(`[SEND_FILE] transResult: filePath="${transResult.filePath}", fileName="${transResult.fileName}", fileSize=${transResult.fileSize}`);
  sendFilePath = transResult.filePath;
  if (transResult.fileSize !== null) {
    console.log(`[SEND_FILE] transResult.fileSize !== null — UPDATE sendFileName "${sendFileName}" → "${transResult.fileName}"`);
    sendFileName = transResult.fileName;
    sendFileSize = transResult.fileSize;
  } else {
    console.log(`[SEND_FILE] transResult.fileSize === null — TIDAK update sendFileName, tetap "${sendFileName}"`);
  }

  const stat = fs.statSync(sendFilePath);
  const actualSize = sendFileSize || stat.size;

  // Update ukuran & fileName (kalau berubah karena konversi)
  req.fileSize = actualSize;
  if (sendFileName !== req.fileName) {
    req.fileName = sendFileName;
  }

  // Init progress
  transferProgress.set(requestId, {
    fileName: sendFileName,
    fileSize: actualSize,
    bytesTransferred: 0,
    status: 'transferring'
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

  const readStream = fs.createReadStream(sendFilePath);

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
      p.status = 'completed';
    }
    req.status = 'completed';
    console.log(`[Transfer] ✅ ${requestId} — transfer confirmed by receiver`);
  });

  return { requestId, fileSize: actualSize };
}

// ===================== Respond Accept/Reject =====================
function respondToRequest(requestId, accepted) {
  const req = pendingRequests.get(requestId);
  if (!req) throw new Error(`Request ${requestId} not found`);
  if (req.status !== 'pending') throw new Error(`Request ${requestId} already ${req.status}`);

  req.status = accepted ? 'accepted' : 'rejected';

  if (accepted) {
    sendFramedMessage(req.socket, { type: 'transfer-response', accepted: true });
    // Mulai raw receive — parser akan dilepas di dalam startRawReceive
    startRawReceive(requestId, req);
  } else {
    sendFramedMessage(req.socket, { type: 'transfer-response', accepted: false, message: 'Rejected by user' });
    req.socket.end();
    pendingRequests.delete(requestId);
  }

  return { requestId, status: req.status };
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
    savedTo: p.savedTo
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
      status: req.status,
      createdAt: req.createdAt
    });
  }
  return result;
}

function getRequestStatus(requestId) {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    return { requestId, status: pending.status, role: 'receiver' };
  }

  const outgoing = outgoingRequests.get(requestId);
  if (outgoing) {
    return { requestId, status: outgoing.status, role: 'sender' };
  }

  return null;
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
  getTransferProgress,
  getPendingRequests,
  getRequestStatus,
  TRANSFER_PORT
};
