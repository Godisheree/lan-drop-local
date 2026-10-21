/**
 * Notifikasi: toast, badge judul tab, badge favicon, bunyi masuk.
 *
 * Semua di-bundle di satu modul supaya mudah disabling (mis. mode tenang).
 */

import { el, clear, maybeById } from '../core/dom.js';

const TOAST_DURATION = 4000;
const MAX_TOASTS = 4;

let toastHost = null;
let liveRegion = null;
let audioContext = null;
let soundEnabled = true;

// ---------------------------------------------------------------------------
// Live region (a11y)
// ---------------------------------------------------------------------------

/**
 * Siapkan live region untukumumkan perubahan status ke screen reader.
 * @param {string} [politeness='polite']
 */
export function initLiveRegion(politeness = 'polite') {
  if (liveRegion) return;
  liveRegion = el('div', {
    id: 'liveRegion',
    class: 'visually-hidden',
    role: 'status',
    'aria-live': politeness,
    'aria-atomic': 'true',
  });
  document.body.appendChild(liveRegion);
}

/**
 * Umumkan pesan ke screen reader.
 * @param {string} message
 */
export function announce(message) {
  if (!liveRegion) initLiveRegion();
  // Kosongkan dulu supaya pesan sama berturut-turut tetap terbaca.
  liveRegion.textContent = '';
  window.setTimeout(() => {
    liveRegion.textContent = message;
  }, 60);
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = maybeById('toastHost');
  if (!toastHost) {
    toastHost = el('div', { id: 'toastHost', class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

/**
 * Tampilkan toast. Bisa tampil lebih dari satu sekaligus (tidak saling menimpa).
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} [type='info']
 */
export function showToast(message, type = 'info') {
  const host = ensureToastHost();

  // Batasi jumlah toast yang menumpuk.
  while (host.children.length >= MAX_TOASTS) {
    host.removeChild(host.firstChild);
  }

  const icon = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' }[type] || 'ℹ️';

  const toast = el('div', { class: `toast toast-${type}`, role: 'status' }, [
    el('span', { class: 'toast-icon', 'aria-hidden': 'true', text: icon }),
    el('span', { class: 'toast-message', text: message }),
  ]);

  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.classList.add('toast-leaving');
    window.setTimeout(() => toast.remove(), 200);
  };

  toast.addEventListener('click', dismiss);
  host.appendChild(toast);
  window.setTimeout(dismiss, TOAST_DURATION);
}

// ---------------------------------------------------------------------------
// Badge judul tab + favicon
// ---------------------------------------------------------------------------

const BASE_TITLE = 'LAN DROP';
let faviconCanvas = null;
let faviconContext = null;

/**
 * Tambah badge di judul tab (dan favicon).
 * @param {number} [count=1]
 */
export function incrementBadge(count = 1) {
  const total = Number(document.title.replace(/^\(\d+\)\s*/, '').match(/\d+/)?.[0] || 0) + count;
  applyBadge(total);
}

/**
 * Set jumlah badge di judul tab.
 * @param {number} count
 */
export function applyBadge(count) {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  renderFaviconBadge(count);
}

/**
 * Bersihkan badge.
 */
export function clearBadge() {
  applyBadge(0);
}

/**
 * Gambar badge angka di atas favicon.
 * @param {number} count
 */
function renderFaviconBadge(count) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;

  if (!faviconCanvas) {
    faviconCanvas = document.createElement('canvas');
    faviconCanvas.width = 64;
    faviconCanvas.height = 64;
    faviconContext = faviconCanvas.getContext('2d');
  }

  const ctx = faviconContext;
  if (!ctx) return;

  ctx.clearRect(0, 0, 64, 64);

  // Ikon dasar: lingkaran biru dengan glyph drop
  ctx.fillStyle = '#5B8DEF';
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (count > 0) {
    // Badge merah di pojok kanan atas
    ctx.fillStyle = '#FF3B30';
    ctx.beginPath();
    ctx.arc(52, 12, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText(count > 9 ? '9+' : String(count), 52, 13);
  } else {
    ctx.fillText('↓', 32, 34);
  }

  link.href = faviconCanvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Bunyi
// ---------------------------------------------------------------------------

/**
 * Aktifkan/Nonaktifkan bunyi notifikasi.
 * @param {boolean} enabled
 */
export function setSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);
}

/**
 * @returns {boolean}
 */
export function isSoundEnabled() {
  return soundEnabled;
}

/**
 * Putar bunyi notifikasi pendek tanpa file audio (Web Audio API).
 * Di-browser modern, AudioContext harus di-resume lewat user gesture —
 * pemanggilan dari event klik sudah cukup.
 */
export function playChime() {
  if (!soundEnabled) return;

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    if (!audioContext) audioContext = new Ctx();
    if (audioContext.state === 'suspended') audioContext.resume();

    const now = audioContext.currentTime;
    const master = audioContext.createGain();
    master.gain.value = 0.0001;
    master.connect(audioContext.destination);

    // Dua nada pendek (C6 → E6) — jelas terdengar tapi tidak menusuk.
    const notes = [
      { freq: 1046.5, at: 0, dur: 0.09 },
      { freq: 1318.5, at: 0.1, dur: 0.13 },
    ];

    for (const note of notes) {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      osc.connect(gain);
      gain.connect(master);

      const start = now + note.at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);

      osc.start(start);
      osc.stop(start + note.dur + 0.02);
    }
  } catch (_) {
    // Audio tidak tersedia / ditolak browser — abaikan, notifikasi visual tetap jalan.
  }
}

/**
 * Beri tahu user: toast + bunyi + badge + live region.
 * @param {string} message
 * @param {Object} [opts]
 * @param {'info'|'success'|'error'|'warning'} [opts.type='info']
 * @param {boolean} [opts.sound=true]
 * @param {boolean} [opts.badge=true]
 */
export function notify(message, opts = {}) {
  const { type = 'info', sound = true, badge = true } = opts;

  showToast(message, type);
  announce(message);
  if (sound) playChime();
  if (badge) incrementBadge(1);
}

/**
 * Kosongkan host toast (dipakai saat reset).
 */
export function clearToasts() {
  if (toastHost) clear(toastHost);
}
