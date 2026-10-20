/**
 * Utilitas aksesibilitas: focus trap, manajemen fokus modal, shortcut keyboard.
 */

import { byId, maybeById } from '../core/dom.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Ambil elemen yang bisa difokus di dalam container.
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function getFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement
  );
}

/**
 * Pasang focus trap pada sebuah dialog.
 *
 * Fokus dipindah ke dalam dialog saat dibuka, dikembalikan ke elemen pemicu
 * saat ditutup, dan Tab memutar di dalam dialog (tidak keluar ke background).
 *
 * Escape TIDAK ditangani di sini — itu urusan satu sumber kebenaran global
 * (`closeTopModal`), supaya tidak ada dua penangan Escape yang saling
 * berebut event.
 *
 * @param {HTMLElement} dialog - elemen `.modal-content`
 * @returns {() => void} fungsi untuk melepas trap
 */
export function trapFocus(dialog) {
  const previouslyFocused = document.activeElement;

  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;

    const focusable = getFocusable(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', onKeydown, true);

  // Fokus awal: elemen dengan [autofocus], else tombol pertama, else dialog-nya.
  const initial =
    dialog.querySelector('[autofocus]') || getFocusable(dialog)[0] || dialog;
  if (initial) initial.focus();

  return () => {
    document.removeEventListener('keydown', onKeydown, true);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  };
}

// ---------------------------------------------------------------------------
// Stack modal
// ---------------------------------------------------------------------------

/**
 * Modal yang sedang terbuka, dari yang paling bawah ke yang paling atas.
 * Satu sumber kebenaran untuk "modal mana yang harus kena Escape".
 * @type {Array<{modal: HTMLElement, onEscape: (() => void)|null, release: () => void}>}
 */
const modalStack = [];

/**
 * Lepaskan satu modal dari stack + kembalikan fokus.
 * @param {HTMLElement} modal
 */
function hideModalElement(modal) {
  if (!modal) return;

  const index = modalStack.findIndex((entry) => entry.modal === modal);
  if (index !== -1) {
    const [entry] = modalStack.splice(index, 1);
    entry.release();
  }

  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');

  if (!document.querySelector('.modal:not(.hidden)')) {
    document.body.classList.remove('modal-open');
  }
}

/**
 * Tutup modal teratas. Dipakai oleh shortcut Escape global.
 * @returns {boolean} true kalau ada modal yang ditutup
 */
export function closeTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (!top) return false;

  if (top.onEscape) {
    //=onEscape biasanya sudah menutup modalnya sendiri.
    top.onEscape();
  } else {
    hideModalElement(top.modal);
  }
  return true;
}

/**
 * Ada modal yang sedang terbuka?
 * @returns {boolean}
 */
export function hasOpenModal() {
  return modalStack.length > 0;
}

/**
 * Buka modal: tampilkan, pasang focus trap, tandai pemicu.
 *
 * @param {string} modalId - id elemen `.modal`
 * @param {Object} [opts]
 * @param {() => void} [opts.onEscape]
 * @param {HTMLElement} [opts.initialFocus] - elemen yang harus difokus
 * @returns {() => void} fungsi untuk menutup modal
 */
export function openModal(modalId, opts = {}) {
  const modal = byId(modalId);
  const content = modal.querySelector('.modal-content') || modal;

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  const release = trapFocus(content);
  modalStack.push({ modal, onEscape: opts.onEscape || null, release });

  if (opts.initialFocus) {
    const target = opts.initialFocus;
    if (target) target.focus();
  }

  return () => hideModalElement(modal);
}

/**
 * Tutup modal yang sedang terbuka.
 * @param {string} modalId
 */
export function closeModal(modalId) {
  hideModalElement(maybeById(modalId));
}

/**
 * Daftar shortcut global.
 * Format: { 'ctrl+enter': handler, 'escape': handler }
 * @type {Map<string, (event: KeyboardEvent) => void>}
 */
const shortcuts = new Map();

/**
 * Daftarkan shortcut keyboard global.
 * @param {string} combo - mis. 'ctrl+enter', 'escape', 'shift+?'
 * @param {(event: KeyboardEvent) => void} handler
 */
export function registerShortcut(combo, handler) {
  shortcuts.set(combo.toLowerCase(), handler);
}

/**
 * Apakah event ini originates dari pengetikan teks?
 *
 * Hanya kunci printable biasa (mis. "a", "1", " ") yang diabaikan di dalam
 * field input. Escape dan Ctrl+Enter tetap boleh lewat — justru di situlah
 * pengguna meng-harapkan keduanya bekerja.
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function isTypingInField(event) {
  const target = event.target;
  if (!target) return false;

  const isField =
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable === true;
  if (!isField) return false;

  // Kunci printable biasa tanpa modifier = ketik.
  const isPrintable = event.key.length === 1;
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;

  return isPrintable && !hasModifier;
}

/**
 * Pasang listener shortcut global. Panggil sekali saat boot.
 */
export function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    // Saat sedang mengetik, abaikan kunci printable biasa saja.
    if (isTypingInField(event)) return;

    // Jangan ganggu IME ( sedang composing ).
    if (event.isComposing) return;

    const parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    parts.push(event.key.toLowerCase());

    const combo = parts.join('+');
    const handler = shortcuts.get(combo);
    if (handler) {
      event.preventDefault();
      handler(event);
    }
  });
}
