/**
 * Wrapper fetch ke server LAN DROP.
 *
 * Semua error dinormalisasi jadi Error dengan pesan yang layak ditampilkan
 * ke user (tanpa membocorkan stack trace).
 */

let pairingNotified = false;

/**
 * Kabari aplikasi sekali bahwa perangkat ini belum punya kunci akses.
 *
 * Dipakai event, bukan import langsung, supaya lapisan API tetap tidak tahu
 * apa-apa soal UI. Sekali saja: kalau polling jalan tiap 3 detik, tanpa
 * penjaga ini event-nya jadi badai dan layar pairing dibuat berulang.
 */
function notifyPairingRequired() {
  if (pairingNotified) return;
  pairingNotified = true;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('landrop:pairing-required'));
  }
}

/**
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 */
export async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...opts, headers });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let needsPairing = false;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
      // Server menandai 401 dengan `pairing: true` kalau masalahnya kunci
      // perangkat, bukan PIN dashboard. Bedanya penting: PIN bisa diketik,
      // kunci hanya bisa didapat dengan memindai QR.
      if (res.status === 401 && body && body.pairing) needsPairing = true;
    } catch (_) {
      // respons bukan JSON — pakai pesan default
    }

    if (needsPairing) notifyPairingRequired();

    const err = new Error(message);
    err.pairing = needsPairing;
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) return null;
  return res.json();
}

/**
 * POST JSON.
 * @param {string} url
 * @param {Object} body
 * @returns {Promise<any>}
 */
export function postJson(url, body) {
  return api(url, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Jalur koneksi yang sedang dipakai user, berdasarkan link yang dibuka.
 *
 * - Tailscale (100.64.0.0/10 atau IPv6 fd7a) → peer dijangkau via Tailscale
 * - localhost / 127.x → 'local': peer lebih masuk akal dijangkau via
 *   Tailscale dulu (HP yang lagi di data seluler), karena loopback cuma
 *   berarti "mesin ini sendiri"
 * - selain itu → LAN
 *
 * Ini bikin rute konsisten: user nggak perlu ganti-ganti, dan peer yang
 * punya dua alamat tidak lagi "berganti-ganti" tiap detik.
 *
 * @returns {'lan'|'tailscale'|'local'}
 */
export function currentVia() {
  const host = (window.location.hostname || '').toLowerCase();

  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return 'local';
  }
  if (host.startsWith('127.')) return 'local';

  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const isCgnat = parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
    return isCgnat ? 'tailscale' : 'lan';
  }

  // IPv6 Tailscale (fd7a:...) & unique-local (fc00::/7)
  if (/^f[cd][0-9a-f]*:/.test(host)) return 'tailscale';

  return 'lan';
}

/**
 * GET daftar perangkat.
 * @param {'lan'|'tailscale'} [via] jalur alamat peer yang dipakai
 * @returns {Promise<Array>}
 */
export function fetchDevices(via) {
  const suffix = via ? `?via=${encodeURIComponent(via)}` : '';
  return api(`/devices${suffix}`);
}

/**
 * GET status discovery (diagnostik).
 * @returns {Promise<Object>}
 */
export function fetchDiscoveryStatus() {
  return api('/discovery/status');
}

/**
 * GET identitas perangkat ini.
 * @returns {Promise<{deviceName: string, urls: Array<{ip: string, url: string}>}>}
 */
export function fetchMe() {
  return api('/me');
}

/**
 * GET riwayat transfer.
 * @returns {Promise<Array>}
 */
export function fetchHistory() {
  return api('/history');
}

/**
 * GET permintaan transfer masuk.
 * @returns {Promise<Array>}
 */
export function fetchPending() {
  return api('/transfer/pending');
}

/**
 * GET teks masuk.
 * @returns {Promise<Array>}
 */
export function fetchReceivedTexts() {
  return api('/transfer/text');
}

/**
 * GET progres transfer.
 * @param {string} requestId
 * @returns {Promise<Object>}
 */
export function fetchProgress(requestId) {
  return api(`/transfer/progress/${encodeURIComponent(requestId)}`);
}

/**
 * GET status terima otomatis.
 * @returns {Promise<{enabled: boolean, peers: string[]}>}
 */
export function fetchAutoApprove() {
  return api('/settings/auto-approve');
}

// Tidak ada `postAutoApprove()` di sini: menyalakan terima otomatis butuh PIN,
// dan satu-satunya tempat yang boleh melakukannya adalah dashboard — yang
// memanggil endpoint itu langsung dengan cookie sesinya.

/**
 * GET status request keluar.
 * @param {string} requestId
 * @returns {Promise<Object>}
 */
export function fetchRequestStatus(requestId) {
  return api(`/transfer/status/${encodeURIComponent(requestId)}`);
}
