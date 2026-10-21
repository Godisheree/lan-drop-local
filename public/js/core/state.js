/**
 * Store state tunggal frontend.
 *
 * Dulu semua state ada sebagai `let`/`const` global di client.js. Sekarang
 * semuanya tinggal di sini, dan fitur yang butuh bereaksi atas perubahan
 * mendaftarkan subscriber.
 *
 * Lihat docs/adr/0001-frontend-modularization.md
 */

/** @typedef {'waiting'|'transferring'|'completed'|'failed'|'rejected'|'cancelled'} TransferStatus */

const state = {
  // --- Identitas perangkat ---
  deviceName: '—',
  /** @type {Array<{ip: string, url: string}>} */
  lanUrls: [],

  // --- Perangkat peer ---
  /** @type {Map<string, {ip: string, port: number, deviceName: string, transferPort: number, lastSeen: number, via: string}>} */
  devices: new Map(),

  // --- Transfer ---
  /** RequestId yang sudah pernah ditampilkan (hindari modal berulang). */
  knownRequestIds: new Set(),
  /** @type {Map<string, {el: HTMLElement, requestId: string, direction: string, batchId: string}>} */
  activeTransfers: new Map(),
  /** @type {Map<string, {filePath: string, fileName: string, fileSize: number, batchId: string, ip: string, port: number, targetName: string}>} */
  transferMeta: new Map(),
  /** @type {Map<string, {bytes: number, time: number, speed: number}>} */
  speedSamples: new Map(),
  /** @type {Map<string, number>} requestId -> interval id */
  progressTimers: new Map(),
  /** RequestId yang progresnya sudah pernah terlihat (pembeda 404 transien vs fatal). */
  sawProgress: new Set(),
  /** @type {Map<string, number>} requestId -> timestamp saat masuk status waiting */
  waitStartedAt: new Map(),

  // --- Permintaan masuk (receiver) ---
  /** @type {Array<{batchId: string, senderName: string, requests: Array<{requestId: string, fileName: string, fileSize: number}>}>} */
  requestQueue: [],
  currentGroup: null,

  // --- Teks ---
  /** @type {Array<{id: string, senderName: string, text: string}>} */
  textOverlayQueue: [],
  currentText: null,
  textTarget: null,

  // --- Target file picker ---
  pendingTarget: null,

  // --- Notifikasi ---
  /** Jumlah notifikasi yang belum dibaca (untuk badge). */
  unreadCount: 0,

  // --- PWA ---
  /** @type {BeforeInstallPromptEvent|null} event install prompt yang tertahan */
  installPrompt: null,
  /** Service worker versi baru tersedia dan menunggu aktif. */
  swUpdateAvailable: false,

  // --- Panel Sambung ---
  /** Index alamat yang dipakai untuk QR (0 = LAN/Wi-Fi, 1 = Tailscale, ...). */
  selectedUrlIndex: 0,
};

/** @type {Set<(state: Object, changed: Set<string>) => void>} */
const subscribers = new Set();

/**
 * Daftarkan subscriber. Dipanggil sekali per fitur.
 * @param {(state: Object, changed: Set<string>) => void} fn
 * @returns {() => void} fungsi unsubscribe
 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * Perbarui state dan beri tahu subscriber.
 * @param {Object} patch
 */
export function setState(patch) {
  const changed = new Set(Object.keys(patch));
  Object.assign(state, patch);
  for (const fn of subscribers) {
    try {
      fn(state, changed);
    } catch (err) {
      console.error('[state] subscriber gagal:', err);
    }
  }
}

/**
 * State saat ini (readonly-by-convention).
 * @returns {Object}
 */
export function getState() {
  return state;
}

/**
 * Reset state — dipakai saat inisialisasi ulang (mis. setelah reconnect).
 */
export function resetState() {
  for (const timer of state.progressTimers.values()) clearInterval(timer);
  state.knownRequestIds.clear();
  state.activeTransfers.clear();
  state.transferMeta.clear();
  state.speedSamples.clear();
  state.progressTimers.clear();
  state.sawProgress.clear();
  state.waitStartedAt.clear();
  state.requestQueue.length = 0;
  state.textOverlayQueue.length = 0;
  state.currentGroup = null;
  state.currentText = null;
  state.unreadCount = 0;
}

/**
 * Hitung kecepatan transfer dengan smoothing exponential moving average.
 * Menghindari angka yang berosilasi liar (b/network burst).
 *
 * @param {string} requestId
 * @param {number} bytes - total byte terkirim
 * @param {number} now - timestamp ms
 * @returns {number} bytes per detik
 */
export function updateSpeed(requestId, bytes, now = Date.now()) {
  const prev = state.speedSamples.get(requestId);
  if (!prev) {
    state.speedSamples.set(requestId, { bytes, time: now, speed: 0 });
    return 0;
  }

  const dt = (now - prev.time) / 1000;
  if (dt <= 0) return prev.speed;

  const instant = (bytes - prev.bytes) / dt;
  // EMA: bobot 0.3 untuk sample baru. Butuh ~3 sample sebelum stabil.
  const speed = prev.speed === 0 ? instant : prev.speed * 0.7 + instant * 0.3;

  state.speedSamples.set(requestId, { bytes, time: now, speed });
  return speed;
}

/**
 * Ambil kecepatan tersimpan.
 * @param {string} requestId
 * @returns {number}
 */
export function getSpeed(requestId) {
  const sample = state.speedSamples.get(requestId);
  return sample ? sample.speed : 0;
}
