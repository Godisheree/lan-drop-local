/**
 * Entry point frontend LAN DROP.
 *
 * Orquestrasi polling, routing event global, dan lifecycle modul.
 * Semua logika fitur ada di ./features/* — file ini hanya merangkai.
 *
 * Lihat docs/guides/frontend-architecture.md
 */

import { byId, maybeById } from './core/dom.js';
import { getState, setState } from './core/state.js';
import { fetchDevices, fetchMe, currentVia } from './core/api.js';

import { renderDevices, setupDragDrop, setupFileInputs, openFilePicker, toTransferTarget } from './features/devices.js';
import { setLanUrls, openConnectPanel, closeConnectPanel } from './features/connect.js';
import { cancelTransfer, retryTransfer } from './features/transfers.js';
import { sendBatch, sendText } from './features/send.js';
import {
  setupTextComposer, openComposer, setupTextOverlay, pollReceivedTexts, submitComposer,
} from './features/text.js';
import { setupRequestModal, pollPending } from './features/receive.js';
import { setupHistory, fetchAndRenderHistory } from './features/history.js';
import { setupThemeToggle } from './features/theme.js';
import { initPwa, applyUpdate } from './features/pwa.js';
import { initLiveRegion, showToast, clearBadge } from './features/notify.js';
import { initMobileHardening } from './features/mobile.js';
import { initShortcuts, registerShortcut, closeTopModal, hasOpenModal } from './features/a11y.js';

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const POLL_INTERVALS = {
  devices: 2500,
  pending: 2000,
  texts: 2000,
  history: 5000,
};

const timers = {};

/**
 * Mulai polling berkala.
 */
function startPolling() {
  timers.devices = setInterval(pollDevices, POLL_INTERVALS.devices);
  timers.pending = setInterval(pollPending, POLL_INTERVALS.pending);
  timers.texts = setInterval(pollReceivedTexts, POLL_INTERVALS.texts);
  timers.history = setInterval(fetchAndRenderHistory, POLL_INTERVALS.history);

  // Panggilan pertama langsung.
  pollDevices();
  pollPending();
  pollReceivedTexts();
  fetchAndRenderHistory();
}

/**
 * Hentikan semua polling.
 */
function stopPolling() {
  for (const key of Object.keys(timers)) {
    if (timers[key]) clearInterval(timers[key]);
    timers[key] = null;
  }
}

/**
 * Ambil daftar perangkat lalu render.
 */
async function pollDevices() {
  try {
    // Jalur peer mengikuti link yang sedang dibuka user (LAN atau Tailscale),
    // supaya tidak "berganti-ganti" di tengah jalan.
    renderDevices(await fetchDevices(currentVia()), deviceHandlers);
  } catch (_) {
    // Server tidak terjangkau - biarkan daftar lama.
  }
}

// ---------------------------------------------------------------------------
// Handler perangkat
// ---------------------------------------------------------------------------

const deviceHandlers = {
  onPickMedia: (device) => openFilePicker(device, 'media'),
  onPickFile: (device) => openFilePicker(device, 'file'),
  // Composer teks juga harus pakai port TRANSFER, bukan port HTTP.
  onPickText: (device) => openComposer(toTransferTarget(device)),
  onDrop: (dataset, files) => {
    // dataset.port sudah berisi port transfer (di-set saat kartu dibangun).
    sendBatch(
      {
        ip: dataset.ip,
        port: parseInt(dataset.port, 10),
        targetName: dataset.deviceName,
      },
      files
    );
  },
  onFilesChosen: (target, files) => sendBatch(target, files),
};

// ---------------------------------------------------------------------------
// Tab mobile
// ---------------------------------------------------------------------------

/**
 * Setup tab mobile (Perangkat | Aktivitas).
 * Hanya aktif di layar kecil — di desktop kedua panel tampil berdampingan.
 */
function setupMobileTabs() {
  const tabs = byId('mobileTabs');
  if (!tabs) return;

  const buttons = Array.from(tabs.querySelectorAll('[role="tab"]'));
  const devices = byId('devicesSection');
  const activity = byId('activitySection');

  const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

  const select = (name) => {
    for (const btn of buttons) {
      const isActive = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', String(isActive));
      btn.tabIndex = isActive ? 0 : -1;
    }
    if (!isMobile()) {
      devices.hidden = false;
      activity.hidden = false;
      return;
    }
    devices.hidden = name !== 'devices';
    activity.hidden = name !== 'activity';
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => select(btn.dataset.tab));
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const index = buttons.indexOf(btn);
      const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      select(next.dataset.tab);
    });
  }

  select('devices');

  window.addEventListener('resize', () => {
    const active = buttons.find((b) => b.getAttribute('aria-selected') === 'true');
    select(active ? active.dataset.tab : 'devices');
  });
}

/**
 * Badge pada tab Aktivitas — jumlah transfer aktif.
 */
function updateActivityBadge() {
  const badge = maybeById('tabActivityBadge');
  if (!badge) return;

  const state = getState();
  const active = Array.from(state.activeTransfers.values()).filter(
    (t) => t.status === 'transferring' || t.status === 'waiting'
  ).length;

  badge.textContent = active > 0 ? String(active) : '';
  badge.classList.toggle('is-visible', active > 0);
}

// ---------------------------------------------------------------------------
// Global event
// ---------------------------------------------------------------------------

/**
 * Delegasi klik pada daftar transfer (Batal / Coba Lagi).
 */
function setupTransferActions() {
  byId('transferList').addEventListener('click', async (event) => {
    const btn = event.target.closest('.btn-cancel, .btn-retry');
    if (!btn) return;

    const requestId = btn.dataset.rid;
    if (!requestId) return;

    if (btn.classList.contains('btn-retry')) {
      btn.disabled = true;
      await retryTransfer(requestId, () => {
        updateActivityBadge();
      });
      btn.disabled = false;
      return;
    }

    btn.disabled = true;
    const state = getState();
    const transfer = state.activeTransfers.get(requestId);
    await cancelTransfer(requestId, transfer && transfer.direction === 'receive' ? 'receive' : 'send');
    updateActivityBadge();
  });
}

/**
 * Header: panel Sambung, tema, dan badge judul tab.
 */
function setupHeader() {
  byId('btnConnect').addEventListener('click', () => openConnectPanel());

  const closeBtn = maybeById('btnCloseConnect');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeConnectPanel());
  }

  setupThemeToggle(byId('btnTheme'));

  // PWA: registrasi service worker (hanya di secure context) + UI install.
  initPwa();

  // Hardening mobile: wake lock, peringatan tab ditutup, cek ruang disk.
  initMobileHardening();

  // Badge judul tab kembali normal saat window regain focus.
  window.addEventListener('focus', () => {
    clearBadge();
  });
}

/**
 * Background ripple — dekoratif, hanya di desktop & bukan reduced-motion.
 */
function initRippleBackground() {
  if (window.innerWidth < 900) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'ripple-bg';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);

  const ctx = canvas.getContext('2d');
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let dots = [];
  const SPACING = 40;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    dots = [];
    for (let x = 0; x < window.innerWidth + SPACING; x += SPACING) {
      for (let y = 0; y < window.innerHeight + SPACING; y += SPACING) {
        dots.push({ baseX: x, baseY: y });
      }
    }
  };

  window.addEventListener('resize', resize);
  resize();

  window.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
  });

  // Ambil warna aksen dari token supaya ikut tema.
  const readAccent = () => {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim();
    return value || '#5B8DEF';
  };
  let accent = readAccent();

  const animate = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const dot of dots) {
      const dx = dot.baseX - mouseX;
      const dy = dot.baseY - mouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const influence = Math.max(0, 1 - dist / 200);
      const radius = 1.5 + influence * 3;
      const opacity = 0.04 + influence * 0.1;

      ctx.beginPath();
      ctx.arc(dot.baseX, dot.baseY, radius, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.globalAlpha = opacity;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(animate);
  };
  animate();

  // Pantau perubahan tema untuk memperbarui warna ripple.
  new MutationObserver(() => {
    accent = readAccent();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Ambil identitas perangkat + URL LAN.
 */
async function loadIdentity() {
  try {
    const me = await fetchMe();
    setState({ deviceName: me.deviceName || '—' });
    byId('deviceName').textContent = me.deviceName || '—';
    byId('deviceName').title = me.deviceName || '';

    const urls = Array.isArray(me.urls) ? me.urls : [];
    const mapped = urls.map((entry) => ({
      ip: entry.ip,
      url: entry.url,
      label: entry.label ? `Alamat ${entry.label}` : 'Alamat LAN',
      // `via` dipakai untuk membedakan petunjuk LAN vs Tailscale.
      via: entry.via || 'lan',
    }));
    setLanUrls(mapped);

    // Default alamat QR = sesuai link yang dipakai membuka halaman ini.
    // Kalau halaman dibuka via Tailscale, default-nya Tailscale (user tidak
    // perlu ganti-ganti). Pilihan manual user tetap dihormati setelah ini.
    const { selectedUrlIndex } = getState();
    if (selectedUrlIndex === 0) {
      const via = currentVia();
      const idx = mapped.findIndex((u) => u.via === via);
      if (idx > 0) setState({ selectedUrlIndex: idx });
    }
  } catch (_) {
    byId('deviceName').textContent = '—';
  }
}

/**
 * Inisialisasi aplikasi.
 */
async function init() {
  initLiveRegion();
  initShortcuts();

  setupMobileTabs();
  setupHeader();
  setupTransferActions();
  setupRequestModal();
  setupHistory();
  setupTextOverlay();

  setupTextComposer({
    onSend: (target, text) => sendText(target, text),
  });

  setupDragDrop(deviceHandlers);
  setupFileInputs(deviceHandlers);

  // Shortcut global. Satu sumber kebenaran: a11y.js menangani Escape
  // (menutup modal teratas) dan Enter/Ctrl+Enter per konteks.
  //
  // - Escape  : tutup modal teratas (kalau ada), kalau tidak, tutup overlay teks
  // - Ctrl+Enter : kirim teks dari composer
  registerShortcut('escape', () => {
    if (closeTopModal()) return;
    // Tanpa modal terbuka, Escape menutup overlay teks yang sedang dibaca.
    const overlay = maybeById('textOverlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      import('./features/text.js').then((m) => m.hideTextOverlay());
    }
  });

  registerShortcut('ctrl+enter', () => {
    if (!hasOpenModal()) return;
    submitComposer();
  });

  // Shortcut "r" untuk muat ulang saat ada versi baru service worker.
  registerShortcut('r', () => {
    if (!getState().swUpdateAvailable) return;
    applyUpdate();
  });

  initRippleBackground();

  await loadIdentity();
  startPolling();

  // Perbarui badge tab secara berkala.
  setInterval(updateActivityBadge, 1000);
}

// Hentikan polling saat tab disembunyikan — hemat baterai di HP.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
  }
});

window.addEventListener('beforeunload', stopPolling);

init().catch((err) => {
  console.error('[app] gagal init:', err);
  showToast('Gagal memuat aplikasi: ' + err.message, 'error');
});
