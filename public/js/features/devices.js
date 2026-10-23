/**
 * Daftar perangkat online.
 *
 * Semua data perangkat dianggap input tidak tepercaya — dirender lewat DOM API,
 * bukan innerHTML. Lihat docs/product/ux-principles.md (Prinsip 5).
 */

import { el, clear, byId } from '../core/dom.js';
import { formatBytes } from '../core/format.js';
import { getState, setState } from '../core/state.js';
import { showToast } from './notify.js';

/** Ambil label jaringan dari field `via` milik discovery. */
function viaLabel(via) {
  return via === 'tailscale' ? '🔒 Tailscale' : 'WiFi langsung';
}

/**
 * Normalisasi objek perangkat menjadi "target transfer".
 *
 * PENTING: `device.port` adalah port HTTP server (3000), sedangkan transfer
 * file/teks lewat TCP memakai `device.transferPort` (3001). Karena itu setiap
 * tempat yang mau mengirim ke peer WAJIB lewat helper ini — kalau tidak,
 * koneksi nyasar ke port HTTP dan transfer menggantung.
 *
 * @param {Object} device
 * @returns {{ip: string, port: number, targetName: string}}
 */
export function toTransferTarget(device) {
  return {
    ip: device.ip,
    port: device.transferPort || device.port + 1,
    targetName: device.deviceName || '',
  };
}

/**
 * Bangun elemen kartu perangkat.
 * @param {Object} device
 * @param {Object} handlers
 * @returns {HTMLElement}
 */
function buildCard(device, handlers) {
  const key = `${device.ip}:${device.port}`;
  const target = toTransferTarget(device);

  const header = el('div', { class: 'device-header' }, [
    el('span', { class: 'indicator', 'aria-hidden': 'true' }),
    el('span', { class: 'dev-name truncate', text: device.deviceName || 'Tanpa nama' }),
    el('span', { class: 'dev-ip', text: `${device.ip}:${device.port}` }),
  ]);

  const meta = el('div', { class: 'dev-meta' }, [
    el('span', { class: 'via-badge' + (device.via === 'tailscale' ? ' is-tailscale' : ''), text: viaLabel(device.via) }),
    el('span', { text: 'tersambung' }),
  ]);

  const dropHint = el('p', { class: 'drop-hint', text: '📤 Seret file ke sini, atau Ctrl+V untuk menempel' });

  const actions = el('div', { class: 'btn-file-row' }, [
    el('button', {
      class: 'btn-file-pick btn-media-pick',
      type: 'button',
      dataset: { action: 'media', ip: target.ip, port: target.port, name: target.targetName },
      onclick: () => handlers.onPickMedia(device),
    }, '📷 Foto/Video'),
    el('button', {
      class: 'btn-file-pick',
      type: 'button',
      dataset: { action: 'file', ip: target.ip, port: target.port, name: target.targetName },
      onclick: () => handlers.onPickFile(device),
    }, '📁 File Lain'),
    el('button', {
      class: 'btn-file-pick btn-text-pick',
      type: 'button',
      dataset: { action: 'text', ip: target.ip, port: target.port, name: target.targetName },
      onclick: () => handlers.onPickText(device),
    }, '✏️ Teks'),
  ]);

  return el('article', {
    class: 'device-card',
    dataset: {
      deviceId: key,
      ip: target.ip,
      port: target.port,
      deviceName: target.targetName,
    },
  }, [header, meta, dropHint, actions]);
}

/**
 * Render daftar perangkat ke DOM.
 *
 * Kartu yang sudah ada di-reuse (bukan di-recreate) supaya hover/fokus tidak
 * hilang tiap 2,5 detik.
 *
 * @param {Array<Object>} devices
 * @param {Object} handlers
 */
export function renderDevices(devices, handlers) {
  const list = byId('deviceList');
  const listDevices = Array.isArray(devices) ? devices : [];

  if (listDevices.length === 0) {
    clear(list);
    list.appendChild(el('div', { class: 'empty-state' }, [
      el('span', { class: 'empty-icon', 'aria-hidden': 'true', text: '📡' }),
      el('span', { class: 'empty-title', text: 'Belum ada perangkat lain' }),
      el('span', {
        class: 'empty-hint',
        text: 'Pastikan perangkat lain terhubung ke WiFi yang sama, lalu buka alamat yang tertera di panel Sambung.',
      }),
    ]));
    setState({ devices: new Map() });
    return;
  }

  const seen = new Set();

  // Perangkat ditemukan — empty state "mencari" sudah tidak relevan.
  const emptyState = list.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  for (const device of listDevices) {
    const key = `${device.ip}:${device.port}`;
    seen.add(key);

    let card = list.querySelector(`[data-device-id="${CSS.escape(key)}"]`);
    if (!card) {
      card = buildCard(device, handlers);
      list.appendChild(card);
    } else {
      // Perbarui label tanpa mengganti node (node lain mungkin sedang disorot).
      const nameEl = card.querySelector('.dev-name');
      if (nameEl) nameEl.textContent = device.deviceName || 'Tanpa nama';
      const ipEl = card.querySelector('.dev-ip');
      if (ipEl) ipEl.textContent = `${device.ip}:${device.port}`;
    }
  }

  // Buang kartu perangkat yang sudah tidak ada.
  for (const card of Array.from(list.querySelectorAll('.device-card'))) {
    if (!seen.has(card.dataset.deviceId)) card.remove();
  }

  setState({
    devices: new Map(
      listDevices.map((d) => [
        `${d.ip}:${d.port}`,
        {
          ip: d.ip,
          port: d.port,
          transferPort: d.transferPort || d.port + 1,
          deviceName: d.deviceName,
          lastSeen: d.lastSeen || Date.now(),
          via: d.via || 'lan',
        },
      ])
    ),
  });
}

/**
 * Pasang drag-and-drop pada daftar perangkat.
 * @param {Object} handlers
 */
export function setupDragDrop(handlers) {
  const list = byId('deviceList');

  // Cegah browser membuka file yang di-drop di luar area kartu.
  const stopDefault = (event) => event.preventDefault();
  window.addEventListener('dragover', stopDefault);
  window.addEventListener('drop', stopDefault);

  list.addEventListener('dragover', (event) => {
    const card = event.target.closest('.device-card');
    if (!card) return;
    event.preventDefault();
    card.classList.add('is-drag-over');
  });

  list.addEventListener('dragleave', (event) => {
    const card = event.target.closest('.device-card');
    if (!card) return;
    card.classList.remove('is-drag-over');
  });

  list.addEventListener('dragend', () => {
    for (const card of list.querySelectorAll('.is-drag-over')) {
      card.classList.remove('is-drag-over');
    }
  });

  list.addEventListener('drop', (event) => {
    const card = event.target.closest('.device-card');
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    card.classList.remove('is-drag-over');

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    handlers.onDrop(card.dataset, Array.from(files));
  });
}

/**
 * Setup input file tersembunyi.
 * @param {Object} handlers
 */
export function setupFileInputs(handlers) {
  const bind = (inputId, kind) => {
    const input = byId(inputId);
    input.addEventListener('change', async () => {
      const files = input.files;
      const target = getState().pendingTarget;
      if (!files || files.length === 0 || !target) return;
      setState({ pendingTarget: null });
      await handlers.onFilesChosen(target, Array.from(files), kind);
      // Reset supaya file yang sama bisa dipilih ulang.
      input.value = '';
    });
  };

  bind('mediaInput', 'media');
  bind('fileInput', 'file');
}

/**
 * Buka file picker dengan target tertentu.
 * @param {Object} device
 * @param {'media'|'file'} kind
 */
export function openFilePicker(device, kind) {
  setState({ pendingTarget: toTransferTarget(device) });
  const input = byId(kind === 'media' ? 'mediaInput' : 'fileInput');
  input.click();
}

/**
 * Tampilkan toast error yang konsisten.
 * @param {string} message
 */
export function reportError(message) {
  showToast(message, 'error');
}

/**
 * Ringkasan ukuran batch untuk judul batch.
 * @param {Array<{fileSize: number}>} items
 * @returns {string}
 */
export function batchSizeLabel(items) {
  const total = items.reduce((sum, item) => sum + (item.fileSize || 0), 0);
  return formatBytes(total);
}
