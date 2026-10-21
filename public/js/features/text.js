/**
 * Composer teks (keluar) dan overlay teks masuk.
 *
 * Menggantikan setupTextSend() / pollReceivedTexts() / showTextOverlay() dari client.js lama.
 */

import { byId } from '../core/dom.js';
import { getState, setState } from '../core/state.js';
import { showToast, notify } from './notify.js';
import { openModal, closeModal } from './a11y.js';

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** @type {((target: Object, text: string) => void) | null} */
let textSendHandler = null;

/**
 * Kirim isi composer.
 *
 * Dipakai baik oleh tombol "Kirim" maupun shortcut global Ctrl+Enter —
 * satu jalur, supaya tidak mungkin kirim dua kali.
 */
export function submitComposer() {
  const textarea = byId('textInput');
  const text = textarea.value;
  const target = getState().textTarget;
  if (!text.trim() || !target) return false;
  if (!textSendHandler) return false;

  textSendHandler(target, text);
  hideComposer();
  return true;
}

/**
 * Setup composer teks.
 * @param {{onSend: (target: Object, text: string) => void}} handlers
 */
export function setupTextComposer(handlers) {
  const textarea = byId('textInput');
  const charCount = byId('charCount');

  textSendHandler = handlers.onSend;

  const updateCount = () => {
    const count = textarea.value.length;
    charCount.textContent = count > 0 ? `${count} karakter` : '';
  };

  textarea.addEventListener('input', updateCount);

  byId('btnSendText').addEventListener('click', submitComposer);
  byId('btnCancelText').addEventListener('click', hideComposer);
  byId('btnCloseTextComposer').addEventListener('click', hideComposer);
}

/**
 * Buka composer untuk target tertentu.
 * @param {Object} target - { ip, port, targetName }
 */
export function openComposer(target) {
  const state = getState();

  // Kalau overlay teks sedang tampil, antrikan dulu supaya tidak nutup composer.
  if (!isOverlayIdle()) {
    if (state.currentText) {
      state.textOverlayQueue.unshift(state.currentText);
      setState({ currentText: null });
    }
    closeModal('textOverlay');
  }

  setState({ textTarget: target });
  byId('textTargetName').textContent = 'ke ' + (target.targetName || '?');

  const textarea = byId('textInput');
  textarea.value = '';
  byId('charCount').textContent = '';

  openModal('textComposerModal', {
    onEscape: () => {
      hideComposer();
    },
  });

  textarea.focus();
}

/**
 * Tutup composer dan tampilkan antrian teks berikutnya bila ada.
 */
export function hideComposer() {
  closeModal('textComposerModal');
  setState({ textTarget: null });

  const state = getState();
  if (!state.currentText && isOverlayIdle() && state.textOverlayQueue.length > 0) {
    showTextOverlay(state.textOverlayQueue.shift());
  }
}

// ---------------------------------------------------------------------------
// Overlay teks masuk
// ---------------------------------------------------------------------------

/**
 * @returns {boolean} true bila overlay sedang tidak tampil
 */
export function isOverlayIdle() {
  return byId('textOverlay').classList.contains('hidden');
}

/**
 * @returns {boolean} true bila composer sedang aktif
 */
export function isComposerActive() {
  return !byId('textComposerModal').classList.contains('hidden');
}

/**
 * Tampilkan overlay teks.
 * @param {Object} text - { id, senderName, text }
 */
export function showTextOverlay(text) {
  setState({ currentText: text });

  byId('textOverlaySender').textContent = text.senderName || '?';
  const body = byId('textOverlayBody');
  body.textContent = text.text;

  const copyBtn = byId('btnCopyText');
  copyBtn.textContent = '📋 Salin';

  openModal('textOverlay', {
    onEscape: () => hideTextOverlay(),
  });
}

/**
 * Tutup overlay, ack teksnya, lalu tampilkan antrian berikutnya.
 */
export function hideTextOverlay() {
  const state = getState();
  const closingId = state.currentText ? state.currentText.id : null;

  closeModal('textOverlay');
  setState({ currentText: null });
  ackText(closingId);

  const next = state.textOverlayQueue.shift();
  if (next) showTextOverlay(next);
}

/**
 * Tandai teks sudah dibaca (hapus dari antrian server).
 * @param {string} textId
 */
async function ackText(textId) {
  if (!textId) return;
  try {
    const { postJson } = await import('../core/api.js');
    await postJson(`/transfer/text/${encodeURIComponent(textId)}/ack`, {});
  } catch (_) {
    // Kalau ack gagal, teks akan muncul lagi — tidak fatal.
  }
}

/**
 * Salin isi teks ke clipboard.
 */
export async function copyCurrentText() {
  const state = getState();
  const text = state.currentText ? state.currentText.text : '';
  if (!text) return;

  const btn = byId('btnCopyText');
  const setLabel = (label, ms) => {
    btn.textContent = label;
    window.setTimeout(() => { btn.textContent = '📋 Salin'; }, ms);
  };

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      setLabel('✅ Disalin!', 1500);
      return;
    }
  } catch (_) {
    // jatuh ke fallback di bawah
  }

  // Fallback execCommand — bekerja tanpa HTTPS (LAN pakai HTTP).
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    setLabel('✅ Disalin!', 1500);
  } catch (_) {
    setLabel('⚠️ Gagal copy', 3000);
  }
  document.body.removeChild(ta);
}

/**
 * Setup handler overlay teks.
 */
export function setupTextOverlay() {
  byId('btnCloseTextOverlay').addEventListener('click', hideTextOverlay);
  byId('btnCopyText').addEventListener('click', copyCurrentText);

  // Klik backdrop menutup (desktop saja — supaya tidak close tak sengaja di HP).
  byId('textOverlay').addEventListener('click', (event) => {
    if (window.innerWidth >= 700 && event.target === event.currentTarget) {
      hideTextOverlay();
    }
  });
}

/**
 * Ambil teks masuk dari server dan tampilkan/antrikan.
 */
export async function pollReceivedTexts() {
  const state = getState();

  try {
    const { fetchReceivedTexts } = await import('../core/api.js');
    const texts = await fetchReceivedTexts();

    for (const text of texts) {
      if (!text.text || !text.text.trim()) continue;
      if (state.textOverlayQueue.some((q) => q.id === text.id)) continue;
      if (state.currentText && state.currentText.id === text.id) continue;

      if (isComposerActive()) {
        state.textOverlayQueue.push(text);
        showToast(
          `💬 Teks dari ${text.senderName || '?'} — ditampilkan setelah selesai mengetik`,
          'info'
        );
      } else if (state.textOverlayQueue.length === 0 && !state.currentText && isOverlayIdle()) {
        showTextOverlay(text);
        // Beri tahu lewat judul tab + bunyi — user mungkin di tab lain.
        notify(`Teks masuk dari ${text.senderName || '?'}`, {
          type: 'info',
          sound: true,
          badge: true,
        });
      } else {
        state.textOverlayQueue.push(text);
      }
    }
  } catch (_) {
    // Server tidak terjangkau — coba lagi di poll berikutnya.
  }
}
