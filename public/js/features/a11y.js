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
 * Pasang focus trap + Escape handler pada sebuah dialog.
 *
 * Fokus dipindah ke dalam dialog saat dibuka, dikembalikan ke elemen pemicu
 * saat ditutup, dan Tab memutar di dalam dialog (tidak keluar ke background).
 *
 * @param {HTMLElement} dialog - elemen `.modal-content`
 * @param {Object} [opts]
 * @param {() => void} [opts.onEscape] - callback saat user menekan Escape
 * @returns {() => void} fungsi untuk melepas trap
 */
export function trapFocus(dialog, opts = {}) {
  const { onEscape } = opts;
  const previouslyFocused = document.activeElement;

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (onEscape) onEscape();
      return;
    }

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

  const release = trapFocus(content, { onEscape: opts.onEscape });

  if (opts.initialFocus) {
    const target = opts.initialFocus;
    if (target) target.focus();
  }

  return () => {
    release();
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.modal:not(.hidden)')) {
      document.body.classList.remove('modal-open');
    }
  };
}

/**
 * Tutup modal yang sedang terbuka.
 * @param {string} modalId
 */
export function closeModal(modalId) {
  const modal = maybeById(modalId);
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.modal:not(.hidden)')) {
    document.body.classList.remove('modal-open');
  }
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
 * Pasang listener shortcut global. Panggil sekali saat boot.
 */
export function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    // Jangan memicu shortcut saat mengetik di input.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

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
