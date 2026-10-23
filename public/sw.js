/**
 * Service worker LAN DROP.
 *
 * HANYA diaktifkan di secure context (HTTPS / localhost). Di LAN HTTP,
 * browser tidak mendaftarkan service worker sama sekali — lihat
 * docs/adr/0004-pwa-di-konteks-http-lan.md.
 *
 * Aturan cache yang WAJIB dijaga:
 *   1. Response API TIDAK PERNAH di-cache. Device/transfer/riwayat basi
 *      = bug parah, bukan sekadar tampilan lama.
 *   2. Navigasi: network-first, fallback ke shell saat offline.
 *   3. Aset statis: stale-while-revalidate.
 *   4. Naikkan CACHE_VERSION setiap kali shell berubah. Kalau tidak,
 *      user bisa melihat UI versi lama setelah update.
 */

const CACHE_VERSION = 'landrop-shell-v3';

const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/views.css',
  '/js/main.js',
  '/js/core/api.js',
  '/js/core/dom.js',
  '/js/core/format.js',
  '/js/core/state.js',
  '/js/features/a11y.js',
  '/js/features/connect.js',
  '/js/features/devices.js',
  '/js/features/gallery.js',
  '/js/features/history.js',
  '/js/features/notify.js',
  '/js/features/paste.js',
  '/js/features/pwa.js',
  '/js/features/receive.js',
  '/js/features/send.js',
  '/js/features/text.js',
  '/js/features/theme.js',
  '/js/features/thumbnail.js',
  '/js/features/transfers.js',
  '/js/vendor/qrcode.js',
];

/**
 * Path yang TIDAK BOLEH pernah di-cache.
 *
 * Daftar ini adalah batas antara "shell aplikasi" dan "data pengguna".
 * Kalau sebuah path API masuk daftar precache, data basi akan tampil.
 */
const NEVER_CACHE = [
  '/devices',
  '/me',
  '/history',
  '/transfer/',
  '/thumbnail/',
  '/events',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Satu per satu — kalau satu 404, sisanya tetap ter-cache.
    await Promise.all(
      SHELL_ASSETS.map(async (url) => {
        try {
          const response = await fetch(url, { cache: 'reload' });
          if (response.ok) await cache.put(url, response);
        } catch (_) {
          // Aset yang gagal diambil tidak boleh menggagalkan instalasi.
        }
      })
    );
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name !== CACHE_VERSION && name.startsWith('landrop-'))
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

/**
 * Apakah path ini boleh di-cache?
 * @param {string} pathname
 * @returns {boolean}
 */
function isCacheable(pathname) {
  if (NEVER_CACHE.some((prefix) => pathname.startsWith(prefix))) return false;
  if (pathname.startsWith('/api/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Hanya GET yang boleh di-cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin: jangan disentuh. Repo ini tidak punya aset third-party,
  // tapi ini menjaga kalau nanti ada.
  if (url.origin !== self.location.origin) return;

  if (!isCacheable(url.pathname)) return;

  // Navigasi: network-first, fallback ke shell.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('/', fresh.clone());
        return fresh;
      } catch (_) {
        const cached = await caches.match('/');
        return cached || Response.error();
      }
    })());
    return;
  }

  // Aset statis: stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);

    const network = fetch(request).then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    }).catch(() => null);

    if (cached) {
      // Perbarui di latar belakang, sajikan yang cached sekarang.
      network.catch(() => {});
      return cached;
    }

    const fresh = await network;
    return fresh || Response.error();
  })());
});

// Pesan dari client: "versi baru siap, muat ulang".
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
