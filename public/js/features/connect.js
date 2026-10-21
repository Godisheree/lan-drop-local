/**
 * Panel "Sambung" — menampilkan URL LAN + QR code supaya perangkat kedua
 * bisa langsung membuka halaman yang sama.
 *
 * QR digenerate sepenuhnya di browser (library vendored, lihat ADR-0002).
 * Tidak ada request ke luar jaringan.
 */

import { el, clear, maybeById } from '../core/dom.js';
import { getState, setState } from '../core/state.js';
import { showToast } from './notify.js';
import { openModal, closeModal } from './a11y.js';
import { renderInstallSection } from './pwa.js';
import { fetchDiscoveryStatus } from '../core/api.js';

const STATUS_POLL_MS = 5000;
let statusTimer = null;

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

// ===================== Status jaringan =====================

/**
 * Satu baris status (label + nilai).
 * @param {string} label
 * @param {string} value
 * @param {'ok'|'warn'} [tone]
 * @returns {HTMLElement}
 */
function statusRow(label, value, tone) {
  return el('div', { class: 'net-status-row' + (tone ? ` is-${tone}` : '') }, [
    el('span', { class: 'net-status-label', text: label }),
    el('span', { class: 'net-status-value', text: value }),
  ]);
}

/**
 * Render blok status jaringan.
 *
 * Tujuannya: kalau perangkat tidak muncul, user bisa langsung tahu
 * kondisinya (broadcast gagal? listener tidak bind? Tailscale belum aktif?)
 * daripada cuma melihat daftar perangkat kosong.
 *
 * @param {Object|null} status
 */
function renderNetStatus(status) {
  const box = maybeById('netStatus');
  if (!box) return;

  // Jangan render ulang kalau isinya sama — supaya screen reader tidak
  // announcing ulang tiap 5 detik.
  const signature = status ? JSON.stringify(status) : 'error';
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;

  clear(box);

  if (!status) {
    box.appendChild(el('p', {
      class: 'net-status-line is-warn',
      text: 'Status tidak bisa diambil dari server — cek koneksi ke server ini.',
    }));
    return;
  }

  box.appendChild(statusRow('Server ini', status.deviceName || '-'));

  const interfaces = Array.isArray(status.interfaces) ? status.interfaces : [];
  if (interfaces.length === 0) {
    box.appendChild(statusRow('Broadcast LAN', 'tidak ada interface LAN', 'warn'));
  } else {
    for (const iface of interfaces) {
      const label = `Broadcast ${iface.address || '?'}`;
      if (!iface.bound) {
        box.appendChild(statusRow(label, 'tidak aktif', 'warn'));
      } else if (iface.lastError) {
        box.appendChild(statusRow(label, `gagal (${iface.lastError})`, 'warn'));
      } else {
        box.appendChild(statusRow(label, 'ok', 'ok'));
      }
    }
  }

  const listener = status.listener || {};
  if (listener.bound) {
    box.appendChild(statusRow('Listener UDP', `port ${listener.port} · aktif`, 'ok'));
  } else {
    const suffix = listener.error ? ` (${listener.error})` : '';
    box.appendChild(statusRow('Listener UDP', `port ${listener.port} · tidak aktif${suffix}`, 'warn'));
  }

  const peers = status.peers || {};
  const peerCount = Number(peers.count) || 0;
  box.appendChild(statusRow(
    'Perangkat ditemukan',
    peerCount > 0 ? String(peerCount) : 'belum ada',
    peerCount > 0 ? 'ok' : 'warn'
  ));

  const ts = status.tailscale || {};
  if (ts.selfIp) {
    const note = ts.cliFound ? '' : ' (tanpa CLI — peer dicari lewat reply-back)';
    box.appendChild(statusRow('Tailscale', `${ts.selfIp}${note}`, 'ok'));
  } else {
    box.appendChild(statusRow('Tailscale', 'belum terdeteksi', 'warn'));
  }
}

/**
 * Ambil status terbaru (diam-diam; error tidak dibiarkan ke console).
 */
async function pollNetStatus() {
  try {
    renderNetStatus(await fetchDiscoveryStatus());
  } catch (_) {
    renderNetStatus(null);
  }
}

function startStatusPolling() {
  stopStatusPolling();
  pollNetStatus();
  statusTimer = window.setInterval(pollNetStatus, STATUS_POLL_MS);
}

function stopStatusPolling() {
  if (statusTimer) {
    window.clearInterval(statusTimer);
    statusTimer = null;
  }
}

/**
 * Render isi panel Sambung.
 */
export function renderConnectPanel() {
  const frame = maybeById('qrFrame');
  const urlList = maybeById('urlList');
  if (!frame || !urlList) return;

  const { lanUrls, selectedUrlIndex } = getState();

  clear(frame);
  clear(urlList);

  if (lanUrls.length === 0) {
    frame.className = 'qr-frame is-error';
    frame.textContent =
      'Tidak ada alamat yang terdeteksi. Pastikan perangkat terhubung ke WiFi, lalu muat ulang halaman.';
    return;
  }

  // QR memakai alamat yang dipilih user. Default-nya LAN (nol setup),
  // tapi kalau device lain di tailnet, alamat Tailscale jauh lebih berguna.
  //
  // Kalau halaman ini dibuka lewat link Tailscale, default-nya ikut
  // Tailscale — user nggak perlu ganti-ganti. Pilihan manual user tetap
  // dihormati (state.selectedUrlIndex) selama sesi berjalan.
  const activeIndex = Math.min(selectedUrlIndex, lanUrls.length - 1);
  const primary = lanUrls[activeIndex];

  frame.className = 'qr-frame';
  try {
    frame.innerHTML = buildQrSvg(primary.url);
  } catch (err) {
    frame.className = 'qr-frame is-error';
    frame.textContent = 'Gagal membuat QR: ' + err.message;
  }

  // Hint menyesuaikan alamat yang dipilih — dua kasusnya beda jauh.
  //
  // PENTING: panel ini dirender oleh server yang sedang melayani halaman.
  // Kalau HP membuka QR dari laptop, yang tampil adalah identitas LAPTOP —
  // itu bukan bug, tapi perlu dijelaskan supaya tidak bikin bingung
  // ("kok namanya deviceku sama dengan laptop?").
  const owner = getState().deviceName || 'server ini';
  const twoWay =
    `Halaman ini milik "${owner}". Supaya dua arah, device kedua juga harus ` +
    'menjalankan LAN DROP-nya sendiri — membuka halaman saja tidak cukup.';

  const hint = maybeById('urlHint');
  if (hint) {
    if (primary.via === 'tailscale') {
      hint.textContent =
        'Pindai QR ini dengan kamera HP. Alamat Tailscale bisa dibuka dari mana saja ' +
        'selama HP-nya terhubung ke tailnet yang sama — tidak harus WiFi yang sama. ' +
        twoWay;
    } else {
      hint.textContent =
        'Pindai QR ini dengan kamera HP, atau buka alamat di bawah. ' +
        'Pastikan kedua perangkat di WiFi yang sama. ' +
        twoWay;
    }
  }

  for (let i = 0; i < lanUrls.length; i++) {
    const entry = lanUrls[i];
    const isActive = i === activeIndex;

    const item = el('li', { class: 'url-item' + (isActive ? ' is-active' : '') }, [
      el('button', {
        class: 'url-select',
        type: 'button',
        'aria-pressed': String(isActive),
        title: isActive ? 'Alamat ini dipakai untuk QR' : 'Pakai alamat ini untuk QR',
        onclick: () => {
          setState({ selectedUrlIndex: i });
          renderConnectPanel();
        },
      }, [
        el('span', { class: 'url-marker', 'aria-hidden': 'true', text: isActive ? '●' : '○' }),
        el('span', { class: 'url-body' }, [
          el('span', { class: 'url-label', text: entry.label || 'Alamat LAN' }),
          el('span', { class: 'url-text', text: entry.url }),
        ]),
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
  startStatusPolling();
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
  stopStatusPolling();
  closeModal('connectModal');
}

/**
 * Set daftar URL LAN yang tampil di panel.
 * @param {Array<{ip: string, url: string, label?: string}>} urls
 */
export function setLanUrls(urls) {
  setState({ lanUrls: Array.isArray(urls) ? urls : [] });
}
