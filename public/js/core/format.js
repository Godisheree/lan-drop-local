/**
 * Format angka & durasi untuk ditampilkan ke user.
 *
 * Semua output dalam Bahasa Indonesia, format yang manusiawi:
 * "12,4 MB", "1,2 GB/s", "8 detik lagi".
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Format ukuran file.
 * @param {number} bytes
 * @param {Object} [opts]
 * @param {number} [opts.decimals] - jumlah desimal (default: 1, kecuali byte bulat)
 * @returns {string}
 */
export function formatBytes(bytes, opts = {}) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';

  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const val = n / Math.pow(1024, i);
  const decimals = opts.decimals !== undefined ? opts.decimals : i === 0 ? 0 : 1;

  return `${formatNumber(val, decimals)} ${UNITS[i]}`;
}

/**
 * Format angka dengan pemisah desimal koma (gaya Indonesia).
 * @param {number} value
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatNumber(value, decimals = 1) {
  const fixed = Number(value).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return decPart ? `${grouped},${decPart}` : grouped;
}

/**
 * Format kecepatan transfer.
 * @param {number} bytesPerSecond
 * @returns {string}
 */
export function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond) || 0;
  if (n < 1) return '—';
  return `${formatBytes(n)}/s`;
}

/**
 * Format durasi ringkas: "8 dtk", "2 mnt 5 dtk", "1 jam 2 mnt".
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 1) return 'kurang dari 1 dtk';
  if (s < 60) return `${s} dtk`;

  const minutes = Math.floor(s / 60);
  const remSeconds = s % 60;
  if (minutes < 60) {
    return remSeconds > 0 ? `${minutes} mnt ${remSeconds} dtk` : `${minutes} mnt`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours} jam ${remMinutes} mnt` : `${hours} jam`;
  }

  const days = Math.floor(hours / 24);
  return `${days} hari ${hours % 24} jam`;
}

/**
 * Format waktu lokal (jam:menit).
 * @param {number|Date} ts
 * @returns {string}
 */
export function formatTime(ts) {
  const date = ts instanceof Date ? ts : new Date(ts);
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format tanggal + waktu lengkap.
 * @param {number|Date} ts
 * @returns {string}
 */
export function formatDateTime(ts) {
  const date = ts instanceof Date ? ts : new Date(ts);
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Emoji per kategori file.
 * @param {string} fileName
 * @returns {string}
 */
export function fileEmoji(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'].includes(ext)) return '🎵';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'mpeg', 'mpg', '3gp', 'flv', 'ts'].includes(ext)) return '🎬';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'].includes(ext)) return '🖼️';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'apk', 'exe', 'msi'].includes(ext)) return '📦';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) return '📝';
  return '📄';
}

/**
 * Format path folder tujuan supaya tidak memenuhi layar.
 * @param {string} path
 * @param {number} [maxLength=48]
 * @returns {string}
 */
export function formatPath(path, maxLength = 48) {
  const p = String(path || '');
  if (p.length <= maxLength) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return '…' + p.slice(-(maxLength - 1));
  return '…' + parts.slice(-2).join('/');
}
