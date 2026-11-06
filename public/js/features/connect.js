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
import { t } from '../core/i18n.js';

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
    throw new Error(t('connect.qrLibraryMissing'));
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
      text: t('connect.statusUnavailable'),
    }));
    return;
  }

  box.appendChild(statusRow(t('connect.thisServer'), status.deviceName || '-'));

  const interfaces = Array.isArray(status.interfaces) ? status.interfaces : [];
  if (interfaces.length === 0) {
    box.appendChild(statusRow('Broadcast LAN', t('connect.noLanInterface'), 'warn'));
  } else {
    for (const iface of interfaces) {
      const label = `Broadcast ${iface.address || '?'}`;
      if (!iface.bound) {
        box.appendChild(statusRow(label, t('connect.inactive'), 'warn'));
      } else if (iface.lastError) {
        box.appendChild(statusRow(label, t('connect.failedWith', { error: iface.lastError }), 'warn'));
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
    box.appendChild(statusRow('Listener UDP', t('connect.listenerPort', { port: listener.port, state: t('connect.inactive') + suffix }), 'warn'));
  }

  const peers = status.peers || {};
  const peerCount = Number(peers.count) || 0;
  box.appendChild(statusRow(
    t('connect.peersFound'),
    peerCount > 0 ? String(peerCount) : t('connect.noneYet'),
    peerCount > 0 ? 'ok' : 'warn'
  ));

  const ts = status.tailscale || {};
  if (ts.selfIp) {
    const note = ts.cliFound ? '' : ' (tanpa CLI — peer dicari lewat reply-back)';
    box.appendChild(statusRow('Tailscale', `${ts.selfIp}${note}`, 'ok'));
  } else {
    box.appendChild(statusRow('Tailscale', t('connect.notDetected'), 'warn'));
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
      t('connect.noAddress');
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
    frame.textContent = t('connect.qrFailed', { reason: err.message });
  }

  // Hint menyesuaikan alamat yang dipilih — dua kasusnya beda jauh.
  //
  // PENTING: panel ini dirender oleh server yang sedang melayani halaman.
  // Kalau HP membuka QR dari laptop, yang tampil adalah identitas LAPTOP —
  // itu bukan bug, tapi perlu dijelaskan supaya tidak bikin bingung
  // ("kok namanya deviceku sama dengan laptop?").
  const owner = getState().deviceName || t('connect.thisServer').toLowerCase();
  const twoWay =
    t('connect.noteOwner', { owner }) + t('connect.noteOwnerRest');

  const hint = maybeById('urlHint');
  if (hint) {
    const intro = primary.via === 'tailscale' ? t('connect.introTailscale') : t('connect.intro');
    hint.textContent = `${intro} ${twoWay}`;
  }

  for (let i = 0; i < lanUrls.length; i++) {
    const entry = lanUrls[i];
    const isActive = i === activeIndex;

    const item = el('li', { class: 'url-item' + (isActive ? ' is-active' : '') }, [
      el('button', {
        class: 'url-select',
        type: 'button',
        'aria-pressed': String(isActive),
        title: isActive ? t('connect.useForQr') : t('connect.useForQr'),
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
        'aria-label': t('connect.copyAddress', { url: entry.url }),
        onclick: (event) => copyUrl(entry.url, event.currentTarget),
      }, t('modal.copy')),
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
    showToast(t('connect.copied'), 'success');
    return true;
  } catch (_) {
    showToast(t('toast.copyFailedManual'), 'warning');
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
  { keys: 'Enter', label: t('shortcut.acceptRequest') },
  { keys: 'Esc', label: t('shortcut.rejectClose') },
  { keys: 'Ctrl+Enter', label: t('shortcut.sendText') },
  { keys: 'Ctrl+V', label: t('shortcut.paste') },
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
