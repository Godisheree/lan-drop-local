/**
 * PWA: registrasi service worker (kondisional) + UI install.
 *
 * Batasan penting: service worker hanya jalan di secure context (HTTPS /
 * localhost). Di LAN HTTP (`http://192.168.x.x:3000`) — kasus utama LAN
 * DROP — browser mengabaikannya. Manifest, ikon, dan "Tambahkan ke Layar
 * Utama" tetap berfungsi di sana.
 *
 * Lihat docs/adr/0004-pwa-di-konteks-http-lan.md
 */

import { el, clear, maybeById } from '../core/dom.js';
import { setState, getState } from '../core/state.js';
import { showToast } from './notify.js';
import { t } from '../core/i18n.js';

/** @type {BeforeInstallPromptEvent|null} */
let installPrompt = null;

/**
 * Apakah service worker boleh diregistrasi di lingkungan ini?
 * @returns {boolean}
 */
export function canRegisterServiceWorker() {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  // Electron memuat http://localhost:3000 → isSecureContext true, tapi SW di
  // sana bisa menyajikan JS basi setelah aplikasi di-update. Lewati.
  if (/Electron/i.test(navigator.userAgent)) return false;
  // Opsi opt-out untuk pengujian: SW di localhost bisa menyajikan shell
  // basi dan mencemari hasil smoke/e2e.
  if (new URLSearchParams(location.search).has('nosw')) return false;
  return true;
}

/**
 * Apakah aplikasi sedang berjalan standalone (sudah di-install)?
 * @returns {boolean}
 */
export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.navigator.standalone === true
  );
}

/**
 * Deteksi platform supaya petunjuk install bisa spesifik.
 * @returns {'ios'|'android'|'desktop'}
 */
export function detectPlatform() {
  const ua = navigator.userAgent;

  if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Daftarkan service worker kalau memang diizinkan.
 *
 * Tidak pernah melempar error: kalau gagal, hanya dicatat. Konsol harus
 * tetap bersih supaya smoke test tidak gagal.
 *
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerServiceWorker() {
  if (!canRegisterServiceWorker()) return null;

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

    // Ada versi baru yang menunggu — beri tahu user.
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          setState({ swUpdateAvailable: true });
          showToast(t('pwa.updateAvailable'), 'info');
        }
      });
    });

    return registration;
  } catch (err) {
    console.warn('[pwa] service worker gagal didaftarkan:', err.message);
    return null;
  }
}

/**
 * Muat ulang halaman untuk mengambil versi baru.
 */
export function applyUpdate() {
  if (!('serviceWorker' in navigator)) {
    location.reload();
    return;
  }
  navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration && registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    location.reload();
  }).catch(() => location.reload());
}

/**
 * Buang cache + lepas service worker, lalu muat ulang sekali.
 *
 * Dipakai saat aplikasi mati karena elemen wajib tidak ada di DOM: itu gejala
 * shell service worker tertinggal (HTML dan JS dari versi berbeda), bukan bug
 * fitur. Dibatasi sekali per sesi — kalau setelah muat ulang masih gagal,
 * elemennya memang benar tidak ada, dan halaman tidak boleh masuk loop reload.
 *
 * @returns {Promise<boolean>} true kalau halaman sedang dimuat ulang
 */
export async function healStaleShell() {
  const KEY = 'landrop-shell-heal';

  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, '1');
  } catch (_) {
    // Tanpa sessionStorage tidak ada cara membatasi loop — jangan muat ulang.
    return false;
  }

  try {
    if (self.caches) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } catch (err) {
    console.warn('[pwa] gagal menghapus cache shell:', err.message);
  }

  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch (err) {
    console.warn('[pwa] gagal melepas service worker:', err.message);
  }

  location.reload();
  return true;
}

/**
 * Shell sudah konsisten (init berhasil) — buka lagi izin healStaleShell().
 */
export function markShellHealthy() {
  try {
    sessionStorage.removeItem('landrop-shell-heal');
  } catch (_) {
    // Tidak penting.
  }
}

/**
 * Tangkap event install prompt supaya bisa dipakai tombol "Pasang aplikasi".
 */
export function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    setState({ installPrompt: event });
    renderInstallSection();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    setState({ installPrompt: null });
    showToast(t('pwa.installed'), 'success');
    renderInstallSection();
  });
}

/**
 * Jalankan prompt install.
 * @returns {Promise<'accepted'|'dismissed'|null>}
 */
export async function promptInstall() {
  if (!installPrompt) return null;

  const prompt = installPrompt;
  installPrompt = null;
  setState({ installPrompt: null });

  try {
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') showToast(t('install.installing'), 'success');
    else showToast(t('install.cancelled'), 'info');
    return outcome;
  } catch (err) {
    showToast(t('install.promptFailed'), 'error');
    return null;
  } finally {
    renderInstallSection();
  }
}

/**
 * Petunjuk manual per platform — dipakai saat prompt otomatis tidak
 * tersedia (kasus HTTP-LAN, di mana Chrome tidak pernah memanggil
 * `beforeinstallprompt`).
 * @returns {string[]}
 */
function manualInstructions() {
  const platform = detectPlatform();

  if (platform === 'ios') {
    return [
      t('install.ios1'),
      t('install.ios2'),
      t('install.ios3'),
    ];
  }

  if (platform === 'android') {
    return [
      t('install.android1'),
      t('install.android2'),
      t('install.android3'),
    ];
  }

  return [
    t('install.desktop1'),
    t('install.desktop2'),
  ];
}

/**
 * Render bagian "Aplikasi" di panel Sambung.
 */
export function renderInstallSection() {
  const container = maybeById('installSection');
  if (!container) return;

  clear(container);

  const state = getState();
  const installed = isStandalone();

  // Sudah terpasang — tidak perlu menawarkan apa-apa.
  if (installed) {
    container.appendChild(el('div', { class: 'install-status is-installed' }, [
      el('span', { text: t('install.installed') }),
    ]));
    return;
  }

  // Prompt tersedia (Chrome/Edge desktop atau Android di secure context).
  if (state.installPrompt) {
    container.appendChild(el('button', {
      class: 'btn btn-accent install-button',
      type: 'button',
      onclick: () => promptInstall(),
    }, t('connect.install')));
    return;
  }

  // Tidak ada prompt: tampilkan petunjuk manual + catatan jujur.
  const list = el('ol', { class: 'install-steps' });
  for (const step of manualInstructions()) {
    list.appendChild(el('li', { text: step }));
  }

  container.appendChild(el('p', {
    class: 'install-note',
    text: t('install.addToHome'),
  }));
  container.appendChild(list);

  // Catatan jujur — kenapa tidak ada tombol install otomatis.
  if (!window.isSecureContext) {
    container.appendChild(el('p', {
      class: 'install-note install-note-muted',
      text: t('install.fullNote') +
        '',
    }));
  }
}

/**
 * Inisialisasi PWA.
 */
export function initPwa() {
  setupInstallPrompt();
  registerServiceWorker();
  renderInstallSection();
}
