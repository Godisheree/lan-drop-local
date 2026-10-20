/**
 * Hardening mobile — semua fitur di sini jalan di HTTP LAN, tanpa service
 * worker. Ini penting karena HP adalah perangkat utama LAN DROP.
 *
 * 1. Wake Lock     — layar tidak mati saat transfer berjalan. Kalau layar
 *                    mati, polling di browser bisa dihentikan OS dan user
 *                    tidak tahu file-nya sudah sampai.
 * 2.beforeunload   — peringatan sebelum menutup tab saat ada transfer aktif.
 *                    Menutup tab di tengah transfer = file belum utuh.
 * 3. Pemeriksaan ruang disk — sebelum menerima file besar, cek dulu apakah
 *                    ruangnya cukup. Lebih baik ditolak dengan jelas daripada
 *                    gagal di tengah jalan.
 */

import { el, byId, maybeById } from '../core/dom.js';
import { getState } from '../core/state.js';
import { showToast, notify } from './notify.js';
import { formatBytes } from '../core/format.js';

/** @type {WakeLockSentinel|null} */
let wakeLock = null;
/** @type {boolean} */
let beforeUnloadBound = false;

// ---------------------------------------------------------------------------
// 1. Wake Lock
// ---------------------------------------------------------------------------

/**
 * Apakah perangkat mendukung wake lock?
 * @returns {boolean}
 */
export function isWakeLockSupported() {
  return 'wakeLock' in navigator;
}

/**
 * Aktifkan wake lock supaya layar tidak mati.
 * @returns {Promise<boolean>}
 */
export async function requestWakeLock() {
  if (!isWakeLockSupported()) return false;

  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch (err) {
    // Tidak selalu diizinkan (mis. tab tidak terlihat, atau izin battery
    // saver). Ini bukan error fatal — user tetap bisa transfer.
    return false;
  }
}

/**
 * Lepaskan wake lock.
 */
export function releaseWakeLock() {
  if (!wakeLock) return;
  try {
    wakeLock.release();
  } catch (_) {}
  wakeLock = null;
}

/**
 * Aktifkan wake lock hanya selama ada transfer yang berjalan.
 */
async function syncWakeLock() {
  const state = getState();
  const hasActive = Array.from(state.activeTransfers.values()).some(
    (t) => t.status === 'transferring' || t.status === 'waiting'
  );

  if (hasActive && !wakeLock) {
    await requestWakeLock();
  } else if (!hasActive && wakeLock) {
    releaseWakeLock();
  }
}

// ---------------------------------------------------------------------------
// 2. Peringatan sebelum menutup tab
// ---------------------------------------------------------------------------

/**
 * Pasang peringatan "ada transfer aktif" saat tab mau ditutup.
 */
function setupBeforeUnload() {
  if (beforeUnloadBound) return;
  beforeUnloadBound = true;

  window.addEventListener('beforeunload', (event) => {
    const state = getState();
    const hasActive = Array.from(state.activeTransfers.values()).some(
      (t) => t.status === 'transferring' || t.status === 'waiting'
    );
    if (!hasActive) return;

    // Browser modern menampilkan pesan generic; preventDefault wajib supaya
    // dialog-nya muncul sama sekali.
    event.preventDefault();
    event.returnValue = '';
  });
}

// ---------------------------------------------------------------------------
// 3. Pemeriksaan ruang disk
// ---------------------------------------------------------------------------

/**
 * Minta server memeriksa ruang disk.
 * @returns {Promise<{free: number, total: number}|null>}
 */
async function fetchDiskSpace() {
  try {
    const { api } = await import('../core/api.js');
    return await api('/system/disk');
  } catch (_) {
    return null;
  }
}

/**
 * Cek apakah ruang disk cukup untuk file sebesar tertentu.
 *
 * Butuh 2x ukuran file: satu untuk file-nya, satu untuk `.landrop-part`
 * sementara yang dipakai saat streaming.
 *
 * @param {number} bytes
 * @returns {Promise<{ok: boolean, free: number, needed: number}|null>}
 */
export async function checkDiskSpace(bytes) {
  const disk = await fetchDiskSpace();
  if (!disk || typeof disk.free !== 'number') return null;

  const needed = bytes * 2;
  return { ok: disk.free >= needed, free: disk.free, needed };
}

// ---------------------------------------------------------------------------
// Inisialisasi
// ---------------------------------------------------------------------------

/**
 * Setup hardening mobile.
 */
export function initMobileHardening() {
  setupBeforeUnload();

  // Wake lock mengikuti status transfer.
  setInterval(syncWakeLock, 2000);

  // Saat tab kembali terlihat, minta ulang wake lock (browser melepaskannya
  // otomatis saat tab disembunyikan).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncWakeLock();
  });
}

/**
 * Tampilkan peringatan ruang disk yang kurang.
 * @param {number} free
 * @param {number} needed
 */
export function warnDiskSpace(free, needed) {
  notify(
    `Ruang disk tidak cukup: perlu ${formatBytes(needed)}, tersedia ${formatBytes(free)}`,
    { type: 'error', sound: true, badge: false }
  );
}
