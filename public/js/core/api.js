/**
 * Wrapper fetch ke server LAN DROP.
 *
 * Semua error dinormalisasi jadi Error dengan pesan yang layak ditampilkan
 * ke user (tanpa membocorkan stack trace).
 */

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
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (_) {
      // respons bukan JSON — pakai pesan default
    }
    throw new Error(message);
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
 * GET daftar perangkat.
 * @returns {Promise<Array>}
 */
export function fetchDevices() {
  return api('/devices');
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
 * GET status request keluar.
 * @param {string} requestId
 * @returns {Promise<Object>}
 */
export function fetchRequestStatus(requestId) {
  return api(`/transfer/status/${encodeURIComponent(requestId)}`);
}
