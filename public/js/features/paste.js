/**
 * Tempel dari clipboard (Ctrl+V) — file, gambar, atau teks.
 *
 * Deteksi jenis isi dilakukan di sini, bukan di server: event `paste` sudah
 * membawa `clipboardData`, jadi tidak perlu satu round-trip HTTP hanya untuk
 * tahu yang ditempel itu file atau teks. File/gambar → jalur kirim file,
 * teks → jalur kirim teks yang sudah ada.
 *
 * Target selalu perangkat PERTAMA di daftar (kartu paling atas).
 */

import { byId } from '../core/dom.js';
import { hasOpenModal } from './a11y.js';
import { showToast } from './notify.js';

/**
 * Target bisa menerima paste sendiri? Kalau ya, jangan direbut — user
 * mungkin sedang menempel ke composer teks.
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isEditable(target) {
  if (!target) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable === true
  );
}

/**
 * Pasang handler paste global.
 *
 * @param {Object} handlers
 * @param {(target: Object, files: File[]) => void} handlers.onFiles
 * @param {(target: Object, text: string) => void} handlers.onText
 */
export function setupPaste(handlers) {
  window.addEventListener('paste', (event) => {
    // Jangan rebut paste dari field yang bisa diketik (composer teks, dsb).
    if (isEditable(event.target)) return;

    // Modal terbuka — user mungkin sedang menyalin keluar dari modal itu.
    if (hasOpenModal()) return;

    const clipboard = event.clipboardData;
    if (!clipboard) return;

    // `files` saja tidak cukup: "Copy image" dari browser dan sebagian alat
    // screenshot hanya mengisi `items` (kind: 'file'), `files` tetap kosong.
    const files = Array.from(clipboard.files || []);
    if (files.length === 0) {
      for (const item of clipboard.items || []) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    const text = clipboard.getData('text/plain') || '';
    if (files.length === 0 && !text.trim()) return;

    // Target = kartu paling atas di DOM, sumber yang sama dengan drag-drop
    // (`card.dataset`). Urutan Map bisa berbeda dari urutan render, jadi
    // keduanya harus baca dari DOM supaya "perangkat pertama" berarti sama.
    const card = byId('deviceList').querySelector('.device-card');
    if (!card) {
      // Tidak ada peer: tetap panggil preventDefault agar browser
      // tidak menjalankan paste native (mis. membuka file di tab baru),
      // lalu kasih tahu user.
      event.preventDefault();
      showToast('📋 Belum ada perangkat tujuan — tunggu peer muncul di daftar', 'warning');
      return;
    }

    event.preventDefault();

    // Tanpa klik area, user harus dapat bukti visual ke mana isinya pergi.
    card.classList.add('is-drag-over');
    window.setTimeout(() => card.classList.remove('is-drag-over'), 1200);

    const target = {
      ip: card.dataset.ip,
      port: parseInt(card.dataset.port, 10),
      targetName: card.dataset.deviceName,
    };

    if (files.length > 0) handlers.onFiles(target, files);
    else handlers.onText(target, text);
  });
}
