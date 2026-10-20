/**
 * Panel riwayat transfer.
 *
 * Menggantikan fetchHistory() / renderHistory() dari client.js lama.
 */

import { el, clear, byId } from '../core/dom.js';
import { formatBytes, formatTime } from '../core/format.js';
import { showToast } from './notify.js';
import { attachThumbnail } from './thumbnail.js';
import { renderGallery } from './gallery.js';

/**
 * Render daftar riwayat.
 * @param {Array<Object>} items
 */
export function renderHistory(items) {
  const container = byId('historyList');
  if (!container) return;

  clear(container);

  const list = Array.isArray(items) ? items : [];

  // Galeri memakai entri yang sama — tidak menambah request.
  renderGallery(list);

  if (list.length === 0) {
    container.appendChild(el('div', { class: 'empty-state' }, [
      el('span', { class: 'empty-icon', 'aria-hidden': 'true', text: '🗂️' }),
      el('span', { class: 'empty-title', text: 'Belum ada riwayat' }),
      el('span', {
        class: 'empty-hint',
        text: 'Transfer yang selesai akan tercatat di sini.',
      }),
    ]));
    return;
  }

  for (const item of list.slice(0, 30)) {
    const icon = item.status === 'completed' ? '✅'
      : item.status === 'cancelled' ? '🚫'
      : '❌';
    const dirIcon = item.direction === 'send' ? '📤' : '📥';

    const metaParts = [
      `${dirIcon} ${item.peer || '?'}`,
      formatBytes(item.fileSize),
      formatTime(item.ts),
    ];
    if (item.resumed) metaParts.push('dilanjutkan');

    const row = el('div', { class: 'history-item' }, [
      el('span', { class: 'h-icon', 'aria-hidden': 'true', text: icon }),
      el('div', { class: 'h-body' }, [
        el('span', { class: 'h-name', text: item.fileName || '?' }),
        el('span', { class: 'h-meta', text: metaParts.join(' · ') }),
      ]),
    ]);

    if (item.thumbnailId) {
      attachThumbnail(row, item.thumbnailId, { className: 'h-thumb' });
    }

    container.appendChild(row);
  }
}

/**
 * Ambil riwayat dari server.
 */
export async function fetchAndRenderHistory() {
  try {
    const { fetchHistory } = await import('../core/api.js');
    renderHistory(await fetchHistory());
  } catch (_) {
    // Server tidak terjangkau — biarkan isi lama.
  }
}

/**
 * Setup tombol hapus riwayat + toggle lipatan.
 */
export function setupHistory() {
  byId('btnClearHistory').addEventListener('click', async () => {
    try {
      const { postJson } = await import('../core/api.js');
      await postJson('/history/clear', {});
      showToast('🗑 Riwayat dihapus', 'success');
      fetchAndRenderHistory();
    } catch (err) {
      showToast('❌ Gagal hapus riwayat: ' + err.message, 'error');
    }
  });

  // Riwayat bisa dilipat supaya panel aktivitas lebih lega.
  const toggle = byId('btnToggleHistory');
  const list = byId('historyList');
  const heading = byId('historyHeading');

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    list.hidden = expanded;
    heading.textContent = expanded ? 'Riwayat' : 'Riwayat (disembunyikan)';
  });
}
