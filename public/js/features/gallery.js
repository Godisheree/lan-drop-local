/**
 * Galeri media — grid foto & video terbaru yang diterima.
 *
 * Sumbernya adalah entri riwayat yang punya `thumbnailId`. Riwayat sudah
 * di-poll tiap 5 detik, jadi galeri tidak menambah request baru sama sekali.
 *
 * Interaksi: klik thumbnail -> salin path file-nya. Menyalin path jauh lebih
 * berguna daripada lightbox untuk kasus ini (user mau buka file-nya di
 * aplikasi galeri / file manager, dan di HP path-nya tidak bisa dibuka
 * browser).
 */

import { el, clear, maybeById } from '../core/dom.js';
import { formatBytes } from '../core/format.js';
import { showToast } from './notify.js';
import { thumbnailUrl } from './thumbnail.js';

const MAX_ITEMS = 12;

/**
 * Salin path ke clipboard (dengan fallback untuk konteks non-HTTPS).
 * @param {string} text
 * @param {HTMLElement} button
 */
async function copyToClipboard(text, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    const original = button.getAttribute('aria-label');
    button.setAttribute('aria-label', 'Lokasi file disalin');
    setTimeout(() => button.setAttribute('aria-label', original), 1500);
    showToast('Lokasi file disalin', 'success');
  } catch (_) {
    showToast('Gagal menyalin lokasi file', 'error');
  }
}

/**
 * Render galeri dari daftar entri riwayat.
 * @param {Array<Object>} items - entri riwayat
 */
export function renderGallery(items) {
  const grid = maybeById('galleryGrid');
  const section = maybeById('gallerySection');
  if (!grid || !section) return;

  clear(grid);

  const media = (Array.isArray(items) ? items : [])
    .filter((item) => item.thumbnailId && item.status === 'completed')
    .slice(0, MAX_ITEMS);

  if (media.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  for (const item of media) {
    const button = el('button', {
      class: 'gallery-item',
      type: 'button',
      'aria-label': `Foto: ${item.fileName} — salin lokasi file`,
      title: `${item.fileName} · ${formatBytes(item.fileSize)}`,
      onclick: (event) => copyToClipboard(item.savedTo || '', event.currentTarget),
    }, [
      el('img', {
        class: 'gallery-thumb',
        src: thumbnailUrl(item.thumbnailId),
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        'aria-hidden': 'true',
      }),
    ]);

    grid.appendChild(button);
  }
}
