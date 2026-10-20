/**
 * Panel "Sambung" — menampilkan URL LAN + QR code supaya perangkat kedua
 * bisa langsung membuka halaman yang sama.
 *
 * QR digenerate sepenuhnya di browser (library vendored, lihat ADR-0002).
 * Tidak ada request ke luar jaringan.
 */

import { el, clear, byId, maybeById } from '../core/dom.js';
import { getState, setState } from '../core/state.js';
import { showToast } from './notify.js';
import { openModal, closeModal } from './a11y.js';
import { renderInstallSection } from './pwa.js';

/**
 * Buat SVG QR code dari teks.
 * @param {string} text
 * @returns {string} markup SVG
 */
function buildQrSvg(text) {
  // qrcode-generator diekspos sebagai global `qrcode` oleh script vendor.
  if (typeof window.qrcode !== 'function') {
    throw new Error('Library QR tidak termuat');
  }

  // Tipe 0 = auto-pilih versi. Level M = toleransi error cukup untuk layar.
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const cell = 4;
  const margin = 4 * cell; // quiet zone — wajib untuk bisa discan
  const size = count * cell + margin * 2;

  const parts = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        parts.push(`M${col * cell + margin} ${row * cell + margin}h${cell}v${cell}h-${cell}z`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Kode QR untuk membuka LAN DROP"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${parts.join('')}" fill="#000000"/></svg>`;
}

/**
 * Render isi panel Sambung.
 */
export function renderConnectPanel() {
  const frame = maybeById('qrFrame');
  const urlList = maybeById('urlList');
  if (!frame || !urlList) return;

  const { lanUrls } = getState();

  clear(frame);
  clear(urlList);

  if (lanUrls.length === 0) {
    frame.className = 'qr-frame is-error';
    frame.textContent =
      'Tidak ada alamat LAN yang terdeteksi. Pastikan perangkat terhubung ke WiFi, lalu muat ulang halaman.';
    return;
  }

  frame.className = 'qr-frame';

  // QR memuat URL utama — alamat WiFi pertama (paling mungkin dipakai HP).
  const primary = lanUrls[0].url;
  try {
    frame.innerHTML = buildQrSvg(primary);
  } catch (err) {
    frame.className = 'qr-frame is-error';
    frame.textContent = 'Gagal membuat QR: ' + err.message;
  }

  for (const entry of lanUrls) {
    const item = el('li', { class: 'url-item' }, [
      el('div', { style: { 'min-width': '0', flex: '1' } }, [
        el('span', { class: 'url-label', text: entry.label || 'Alamat LAN' }),
        el('span', { class: 'url-text', text: entry.url }),
      ]),
      el('button', {
        class: 'copy-btn',
        type: 'button',
        'aria-label': `Salin alamat ${entry.url}`,
        onclick: (event) => copyUrl(entry.url, event.currentTarget),
      }, 'Salin'),
    ]);
    urlList.appendChild(item);
  }
}

/**
 * Salin teks ke clipboard dengan fallback untuk konteks non-HTTPS.
 * @param {string} text
 * @param {HTMLElement} [button]
 */
export async function copyText(text, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback execCommand — bekerja di http:// (LAN) dan http://localhost.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    if (button) {
      const original = button.textContent;
      button.textContent = 'Tersalin';
      window.setTimeout(() => { button.textContent = original; }, 1500);
    }
    showToast('Alamat disalin', 'success');
    return true;
  } catch (_) {
    showToast('Gagal menyalin — salin manual dari layar', 'warning');
    return false;
  }
}

function copyUrl(url, button) {
  copyText(url, button);
}

/**
 * Daftar shortcut keyboard yang tersedia.
 * Dipakai untuk panel Sambung — supaya pengguna tahu apa yang bisa dipakai,
 * bukan harus menebak.
 */
const SHORTCUTS = [
  { keys: 'Enter', label: 'Terima permintaan masuk' },
  { keys: 'Esc', label: 'Tolak / tutup jendela' },
  { keys: 'Ctrl+Enter', label: 'Kirim teks' },
];

/**
 * Render daftar shortcut di panel Sambung.
 */
function renderShortcuts() {
  const list = document.getElementById('shortcutList');
  if (!list) return;

  clear(list);
  for (const shortcut of SHORTCUTS) {
    list.appendChild(el('li', { class: 'shortcut-row' }, [
      el('kbd', { class: 'shortcut-key', text: shortcut.keys }),
      el('span', { class: 'shortcut-label', text: shortcut.label }),
    ]));
  }
}

/**
 * Buka panel Sambung.
 */
export function openConnectPanel() {
  renderConnectPanel();
  renderShortcuts();
  renderInstallSection();
  return openModal('connectModal', {
    onEscape: () => {
      closeConnectPanel();
    },
  });
}

/**
 * Tutup panel Sambung.
 */
export function closeConnectPanel() {
  closeModal('connectModal');
}

/**
 * Set daftar URL LAN yang tampil di panel.
 * @param {Array<{ip: string, url: string, label?: string}>} urls
 */
export function setLanUrls(urls) {
  setState({ lanUrls: Array.isArray(urls) ? urls : [] });
}
