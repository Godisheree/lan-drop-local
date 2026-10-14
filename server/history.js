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
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      const tmp = dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, dataFile);
    } catch (_) {}
  }, 300); // debounce — batch transfer bisa picu banyak entry sekaligus
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

module.exports = { add, list, clear };
