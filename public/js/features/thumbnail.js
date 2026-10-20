/**
 * Thumbnail di sisi klien.
 *
 * Thumbnail dikirim dari server sebagai gambar — client cuma menempelkannya
 * ke kartu transfer. Kalau gagal dimuat, kartu kembali ke emoji biasa
 * (tidak boleh rusak).
 */

import { el } from '../core/dom.js';

/**
 * @param {string} fileName
 * @returns {boolean} true kalau file ini kemungkinan punya thumbnail
 */
export function isThumbnailableName(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'avif',
    'mp4', 'mov', 'mkv', 'avi', 'webm', '3gp', 'mpeg', 'mpg', 'ts', 'flv',
  ].includes(ext);
}

/**
 * URL thumbnail untuk sebuah id.
 * @param {string} thumbnailId
 * @returns {string}
 */
export function thumbnailUrl(thumbnailId) {
  return `/thumbnail/${encodeURIComponent(thumbnailId)}`;
}

/**
 * Pasang thumbnail ke dalam elemen item.
 *
 * Kalau elemen sudah punya thumbnail, tidak ada yang terjadi (idempoten).
 * Kalau gambar gagal dimuat, thumbnail dilepas dan emoji tetap dipakai.
 *
 * @param {HTMLElement} itemEl - elemen `.transfer-item` atau `.history-item`
 * @param {string} thumbnailId
 * @param {Object} [opts]
 * @param {string} [opts.className='tf-thumb']
 */
export function attachThumbnail(itemEl, thumbnailId, opts = {}) {
  if (!itemEl || !thumbnailId) return;
  if (itemEl.querySelector('.tf-thumb')) return;

  const img = el('img', {
    class: opts.className || 'tf-thumb',
    src: thumbnailUrl(thumbnailId),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    // Dekoratif: nama file sudah dibaca screen reader.
    'aria-hidden': 'true',
  });

  // Gambar gagal dimuat -> lepas, biarkan emoji yang tampil.
  img.addEventListener('error', () => {
    img.remove();
  });

  const anchor = itemEl.querySelector('.tf-name') || itemEl.querySelector('.h-body');
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(img, anchor);
  } else {
    itemEl.prepend(img);
  }
}
