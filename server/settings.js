const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./platform');

// ===================== Settings =====================
// Setting per-device disimpan sebagai JSON di data dir, pola sama dengan
// history.js: cache di memori + tulis atomic (tmp + rename) yang di-debounce.

const dataFile = path.join(getDataDir(), 'settings.json');

const DEFAULTS = {
  // Terima otomatis: kalau enabled, permintaan file dari peer diterima
  // tanpa modal. `peers` kosong = semua peer boleh; kalau diisi, hanya
  // nama perangkat di daftar itu.
  autoApprove: { enabled: false, peers: [] },
};

let cache = null;
let flushTimer = null;

function normalizeAutoApprove(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    peers: Array.isArray(v.peers)
      ? v.peers.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 50)
      : [],
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    cache = { autoApprove: normalizeAutoApprove(raw && raw.autoApprove) };
  } catch (_) {
    cache = { autoApprove: normalizeAutoApprove(DEFAULTS.autoApprove) };
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
  }, 300);
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
  flush();
  return cache.autoApprove;
}

/**
 * Boleh diterima otomatis dari perangkat ini?
 * @param {string} senderName
 * @returns {boolean}
 */
function isAutoApprovePeer(senderName) {
  const { enabled, peers } = getAutoApprove();
  if (!enabled) return false;
  if (peers.length === 0) return true;
  return peers.includes(String(senderName || '').trim());
}

module.exports = { getAutoApprove, setAutoApprove, isAutoApprovePeer, DEFAULTS };
