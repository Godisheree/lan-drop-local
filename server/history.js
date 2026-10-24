const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./platform');

// ===================== History Transfer =====================
// Riwayat transfer (kirim/terima) disimpan sebagai JSON di data dir
// (~/.lan-drop atau %APPDATA%/lan-drop). Tulis atomic: tmp + rename.
// Kenapa JSON, bukan DB? Project sengaja zero-dependency di runtime.

const MAX_ENTRIES = 200;
const dataFile = path.join(getDataDir(), 'history.json');

let cache = null; // array entri, terbaru di depan
let flushTimer = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    if (!Array.isArray(cache)) cache = [];
  } catch (_) {
    cache = [];
  }
  return cache;
}

function flush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeNow();
  }, 300); // debounce — batch transfer bisa picu banyak entry sekaligus
}

/**
 * Tulis SEKARANG dan batalkan timer yang menunggu.
 *
 * Dipanggil saat proses berhenti (SIGINT/SIGTERM, `before-quit` Electron).
 * Tanpa ini, transfer yang selesai beberapa ratus milidetik sebelum user
 * menutup app hilang dari riwayat.
 */
function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (cache) writeNow();
}

function writeNow() {
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, dataFile);
  } catch (_) {}
}

function add(entry) {
  const list = load();
  list.unshift({
    id: entry.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    direction: entry.direction === 'receive' ? 'receive' : 'send',
    fileName: entry.fileName || '?',
    fileSize: Number(entry.fileSize) || 0,
    peer: entry.peer || '?',
    status: entry.status || 'completed',
    savedTo: entry.savedTo || null,
    thumbnailId: entry.thumbnailId || null,
    resumed: !!entry.resumed
  });
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  flush();
}

function list() {
  return load();
}

function clear() {
  cache = [];
  flush();
}

module.exports = { add, list, clear, flushNow };
