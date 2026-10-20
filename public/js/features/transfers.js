/**
 * Item transfer: progress, kecepatan, ETA, batch grouping, cancel, retry.
 *
 * Menggantikan logika di client.js lama (addTransferItem / updateTransferItem /
 * pollProgress / pollSendStatus / retryTransfer).
 */

import { el, clear, byId } from '../core/dom.js';
import { formatBytes, formatSpeed, formatDuration, fileEmoji, formatPath } from '../core/format.js';
import { getState, setState, updateSpeed, getSpeed } from '../core/state.js';
import { showToast, announce } from './notify.js';

/** @type {Map<string, HTMLElement>} batchId -> elemen batch */
const batchElements = new Map();
/** @type {Map<string, {el: HTMLElement, rows: Map<string, HTMLElement>}>} */
const batchRows = new Map();
/** @type {Map<string, number>} requestId -> timer auto-collapse */
const collapseTimers = new Map();
/** @type {Map<string, object>} requestId -> metadata transfer */
const meta = new Map();

/** Berapa lama item selesai ditampilkan sebelum dilipat. */
const AUTO_COLLAPSE_MS = 6000;
/** Batas tunggu balasan peer sebelum dianggap tidak merespons. */
const RESPONSE_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Batch grouping
// ---------------------------------------------------------------------------

/**
 * Pastikan ada empty state di panel aktivitas.
 * Dipanggil hanya saat daftar kosong — memberi tahu user apa yang harus dilakukan.
 */
function ensureEmptyState() {
  const list = byId('transferList');
  if (list.querySelector('.empty-state')) return;
  if (list.querySelector('.transfer-item, .transfer-batch')) return;

  list.appendChild(el('div', { class: 'empty-state' }, [
    el('span', { class: 'empty-icon', 'aria-hidden': 'true', text: '📦' }),
    el('span', { class: 'empty-title', text: 'Belum ada transfer' }),
    el('span', {
      class: 'empty-hint',
      text: 'Pilih perangkat di sebelah, lalu kirim file, foto, video, atau teks.',
    }),
  ]));
}

/**
 * Ambil (atau buat) elemen batch untuk sekumpulan request.
 * @param {string} batchId
 * @param {string} label
 * @returns {{el: HTMLElement, body: HTMLElement, rows: Map<string, HTMLElement>}}
 */
function ensureBatch(batchId, label) {
  let batch = batchRows.get(batchId);
  if (batch) return batch;

  const list = byId('transferList');
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const body = el('div', { class: 'batch-body' });
  const summary = el('span', { class: 'batch-summary', text: label });
  const chevron = el('span', { class: 'batch-chevron', 'aria-hidden': 'true', text: '▾' });

  const header = el('button', {
    class: 'batch-header',
    type: 'button',
    'aria-expanded': 'true',
  }, [chevron, el('span', { text: label }), summary]);

  const container = el('div', { class: 'transfer-batch', dataset: { batchId } }, [header, body]);
  list.appendChild(container);

  header.addEventListener('click', () => {
    const collapsed = container.classList.toggle('is-collapsed');
    header.setAttribute('aria-expanded', String(!collapsed));
  });

  batch = { el: container, body, rows: new Map(), header, summary };
  batchRows.set(batchId, batch);
  batchElements.set(batchId, container);
  return batch;
}

/**
 * Perbarui ringkasan batch (jumlah file + total ukuran).
 * @param {string} batchId
 */
function refreshBatchSummary(batchId) {
  const batch = batchRows.get(batchId);
  if (!batch) return;

  const items = Array.from(batch.rows.values());
  const total = items.reduce((sum, item) => sum + (Number(item.dataset.fileSize) || 0), 0);
  const done = items.filter((item) => item.dataset.status === 'completed').length;

  const parts = [`${items.length} file`];
  if (total > 0) parts.push(formatBytes(total));
  if (done > 0 && done < items.length) parts.push(`${done} selesai`);

  batch.summary.textContent = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

/**
 * Buat elemen item transfer.
 * @param {string} requestId
 * @param {Object} data
 * @returns {HTMLElement}
 */
function buildItem(requestId, data) {
  const dirClass = data.direction === 'send' ? 'send' : 'receive';
  const dirLabel = data.direction === 'send'
    ? `→ ${data.targetName || '?'}`
    : `← ${data.senderName || '?'}`;

  const name = el('span', { class: 'tf-filename truncate', text: data.fileName || '?' });
  const emoji = el('span', { class: 'tf-emoji', 'aria-hidden': 'true', text: fileEmoji(data.fileName) });

  const actions = el('div', { class: 'tf-actions' });

  const header = el('div', { class: 'tf-header' }, [
    el('span', { class: 'tf-name' }, [emoji, name]),
    el('span', { class: `tf-direction ${dirClass}`, text: dirLabel }),
    actions,
  ]);

  const status = el('div', { class: `tf-status ${data.status || ''}`, text: data.statusText || '' });

  const progressBar = el('div', {
    class: 'progress-bar',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
    'aria-label': `Progres ${data.fileName || 'transfer'}`,
  }, [el('div', { class: 'progress-fill', style: { width: '0%' } })]);

  const bytes = el('span', { class: 'tf-bytes', text: '' });
  const speed = el('span', { class: 'tf-speed', text: '' });
  const metaRow = el('div', { class: 'tf-meta' }, [bytes, speed]);

  return el('article', {
    class: 'transfer-item',
    dataset: {
      rid: requestId,
      direction: data.direction || 'send',
      status: data.status || 'waiting',
      fileSize: String(data.fileSize || 0),
    },
  }, [header, status, progressBar, metaRow]);
}

/**
 * Tambah item transfer baru ke daftar.
 * @param {string} requestId
 * @param {Object} data
 */
export function addTransferItem(requestId, data) {
  const state = getState();
  const list = byId('transferList');

  // Empty state hanya relevan saat daftar benar-benar kosong.
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  // Ganti item lama dengan requestId yang sama.
  const existing = list.querySelector(`[data-rid="${CSS.escape(requestId)}"]`);
  if (existing) existing.remove();

  const item = buildItem(requestId, data);

  // Batch dengan >1 file dikelompokkan; file tunggal tampil polos.
  const batchId = data.batchId;
  const isBatch = Boolean(batchId) && data.batchSize > 1;

  if (isBatch) {
    const batch = ensureBatch(batchId, data.batchLabel || 'Kiriman');
    const row = el('div', { dataset: { rid: requestId } });
    row.appendChild(item);
    batch.body.appendChild(row);
    batch.rows.set(requestId, row);
    refreshBatchSummary(batchId);
  } else {
    list.appendChild(item);
  }

  state.activeTransfers.set(requestId, {
    el: item,
    requestId,
    direction: data.direction,
    batchId: data.batchId || null,
    status: data.status,
  });

  if (data.filePath) {
    meta.set(requestId, {
      filePath: data.filePath,
      fileName: data.fileName,
      fileSize: data.fileSize,
      batchId: data.batchId,
      ip: data.ip,
      port: data.port,
      targetName: data.targetName,
    });
  }

  updateActions(requestId, data);
  updateStickyProgress();
}

/**
 * Perbarui tampilan item transfer.
 * @param {string} requestId
 * @param {Object} data
 */
export function updateTransferItem(requestId, data) {
  const state = getState();
  const transfer = state.activeTransfers.get(requestId);
  if (!transfer || !transfer.el) return;

  const item = transfer.el;
  const statusEl = item.querySelector('.tf-status');
  const fill = item.querySelector('.progress-fill');
  const bar = item.querySelector('.progress-bar');
  const bytesEl = item.querySelector('.tf-bytes');
  const speedEl = item.querySelector('.tf-speed');
  const actions = item.querySelector('.tf-actions');

  if (data.status) item.dataset.status = data.status;
  transfer.status = data.status || transfer.status;

  if (data.statusText !== undefined && statusEl) {
    statusEl.textContent = data.statusText;
    statusEl.className = `tf-status ${data.status || ''}`;
  }

  if (data.percent !== undefined && fill) {
    const pct = Math.max(0, Math.min(100, data.percent));
    fill.style.width = pct + '%';
    fill.className = 'progress-fill';
    if (data.status === 'completed') fill.classList.add('completed');
    if (data.status === 'failed') fill.classList.add('failed');
    if (data.status === 'cancelled') fill.classList.add('cancelled');
    if (bar) {
      bar.setAttribute('aria-valuenow', String(pct));
      if (data.status === 'waiting') bar.classList.add('is-indeterminate');
      else bar.classList.remove('is-indeterminate');
    }
  }

  if (bytesEl && data.transferred !== undefined) {
    const total = data.total || 0;
    bytesEl.textContent = total > 0
      ? `${formatBytes(data.transferred)} / ${formatBytes(total)}`
      : '';
  }

  if (speedEl) {
    if (data.status === 'transferring' && data.speed > 0) {
      const remaining = Math.max(0, (data.total || 0) - (data.transferred || 0));
      const eta = data.speed > 0 ? remaining / data.speed : 0;
      speedEl.textContent = `${formatSpeed(data.speed)} · sisa ${formatDuration(eta)}`;
    } else {
      speedEl.textContent = '';
    }
  }

  if (data.savedTo) {
    let pathRow = item.querySelector('.tf-path');
    if (!pathRow) {
      pathRow = el('div', { class: 'tf-path' }, [
        el('span', { 'aria-hidden': 'true', text: '📁' }),
        el('span', { class: 'tf-path-value', title: data.savedTo, text: formatPath(data.savedTo) }),
        el('button', {
          class: 'tf-path-copy',
          type: 'button',
          'aria-label': 'Salin lokasi folder',
          onclick: () => copyPath(data.savedTo),
        }, 'Salin'),
      ]);
      item.appendChild(pathRow);
    }
  }

  updateActions(requestId, data);
  updateStickyProgress();
}

/**
 * Atur tombol aksi (Batal / Coba Lagi) sesuai status.
 * @param {string} requestId
 * @param {Object} data
 */
function updateActions(requestId, data) {
  const state = getState();
  const transfer = state.activeTransfers.get(requestId);
  if (!transfer || !transfer.el) return;

  const actions = transfer.el.querySelector('.tf-actions');
  if (!actions) return;

  const status = data.status || transfer.status;
  const direction = transfer.direction;
  const terminal = ['completed', 'failed', 'rejected', 'cancelled'].includes(status);

  // Batal tersedia untuk pengirim dan penerima selama transfer berjalan.
  const canCancel =
    (status === 'waiting' || status === 'transferring') &&
    (direction === 'send' || direction === 'receive');

  const existingCancel = actions.querySelector('.btn-cancel');
  const existingRetry = actions.querySelector('.btn-retry');

  if (canCancel && !existingCancel) {
    const btn = el('button', {
      class: 'btn-mini btn-cancel',
      type: 'button',
      dataset: { rid: requestId },
    }, '✕ Batal');
    actions.appendChild(btn);
  } else if (!canCancel && existingCancel) {
    existingCancel.remove();
  }

  const canRetry = status === 'failed' || status === 'disconnected';
  if (canRetry && !existingRetry) {
    const btn = el('button', {
      class: 'btn-mini btn-retry',
      type: 'button',
      dataset: { rid: requestId },
    }, '↻ Coba Lagi');
    actions.appendChild(btn);
  } else if (!canRetry && existingRetry) {
    existingRetry.remove();
  }
}

async function copyPath(path) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(path);
    } else {
      const ta = document.createElement('textarea');
      ta.value = path;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('Lokasi folder disalin', 'success');
  } catch (_) {
    showToast('Gagal menyalin lokasi folder', 'error');
  }
}

/**
 * Lipat otomatis item yang selesai.
 * @param {string} requestId
 */
function scheduleCollapse(requestId) {
  if (collapseTimers.has(requestId)) return;

  const timer = window.setTimeout(() => {
    collapseTimers.delete(requestId);
    const state = getState();
    const transfer = state.activeTransfers.get(requestId);
    if (!transfer || !transfer.el) return;

    // Kalau masih ada transfer lain yang aktif, jangan lipat.
    const hasActive = Array.from(state.activeTransfers.values()).some(
      (t) => t.status === 'transferring' || t.status === 'waiting'
    );
    if (hasActive) return;

    const item = transfer.el;
    item.classList.add('is-collapsed');

    // Lipat tampilan: sembunyikan progress bar dan kecepatan (sudah tak
    // relevan). Path tujuan tetap ditampilkan — itu info paling penting
    // setelah transfer selesai.
    const details = item.querySelectorAll('.progress-bar, .tf-meta');
    for (const node of details) node.hidden = true;

    // Hapus dari daftar aktif setelah dilipat, tapi biarkan elemen di DOM
    // supaya pengguna masih bisa membaca hasilnya.
    state.activeTransfers.delete(requestId);
    state.sawProgress.delete(requestId);
  }, AUTO_COLLAPSE_MS);

  collapseTimers.set(requestId, timer);
}

/**
 * Tandai transfer selesai: perbarui UI, umumkan, dan jadwalkan lipatan.
 * @param {string} requestId
 * @param {Object} data
 */
export function finalizeTransfer(requestId, data) {
  updateTransferItem(requestId, data);
  scheduleCollapse(requestId);
  updateStickyProgress();
}

// ---------------------------------------------------------------------------
// Progress polling
// ---------------------------------------------------------------------------

/**
 * Mulai polling progres untuk satu transfer.
 * @param {string} requestId
 * @param {'send'|'receive'} direction
 * @param {(prog: Object) => void} [onComplete]
 */
export function pollProgress(requestId, direction, onComplete) {
  const state = getState();

  if (state.progressTimers.has(requestId)) {
    clearInterval(state.progressTimers.get(requestId));
  }

  const timer = setInterval(async () => {
    if (!state.activeTransfers.has(requestId)) {
      clearInterval(timer);
      state.progressTimers.delete(requestId);
      return;
    }

    // Apakah kita sudah pernah melihat entri progres untuk transfer ini?
    // 404 SEBELUM progres pernah muncul itu normal: di sisi penerima, entri
    // progres baru dibuat saat frame "file-start" tiba — jadi ada jendela
    // antara "diterima" dan "file mulai mengalir" yang progresnya belum ada.
    let sawProgress = state.sawProgress.has(requestId);

    try {
      const { fetchProgress } = await import('../core/api.js');
      const prog = await fetchProgress(requestId);
      if (!prog) return;

      sawProgress = true;
      state.sawProgress.add(requestId);

      const percent = prog.percent || 0;
      const transferred = prog.bytesTransferred || 0;
      const total = prog.fileSize || 0;
      const speed = updateSpeed(requestId, transferred);

      if (prog.status === 'cancelled') {
        clearInterval(timer);
        state.progressTimers.delete(requestId);
        finalizeTransfer(requestId, {
          status: 'cancelled',
          statusText: '🚫 Dibatalkan',
          percent,
          transferred,
          total,
        });
        announce('Transfer dibatalkan');
        return;
      }

      if (prog.status === 'completed') {
        clearInterval(timer);
        state.progressTimers.delete(requestId);
        finalizeTransfer(requestId, {
          status: 'completed',
          statusText: direction === 'send' ? '✅ Terkirim' : '✅ Selesai diterima',
          percent: 100,
          transferred,
          total,
          savedTo: prog.savedTo || prog.savePath || null,
        });
        showToast(
          `${prog.fileName} — ${direction === 'send' ? 'terkirim' : 'diterima'}`,
          'success'
        );
        if (onComplete) onComplete(prog);
        return;
      }

      if (prog.status === 'failed') {
        clearInterval(timer);
        state.progressTimers.delete(requestId);
        finalizeTransfer(requestId, {
          status: 'failed',
          statusText: '❌ Gagal —iksa koneksi',
          percent,
          transferred,
          total,
        });
        showToast('Transfer gagal', 'error');
        return;
      }

      const statusText = direction === 'send'
        ? `📤 Mengirim ${formatBytes(transferred)} / ${formatBytes(total)}`
        : `📥 Menerima ${formatBytes(transferred)} / ${formatBytes(total)}`;

      updateTransferItem(requestId, {
        status: 'transferring',
        statusText,
        percent,
        transferred,
        total,
        speed,
      });
    } catch (err) {
      const notFound = err && /not found/i.test(err.message);

      if (notFound && sawProgress) {
        // Progres pernah ada lalu hilang → transfer benar-benar hilang di peer.
        clearInterval(timer);
        state.progressTimers.delete(requestId);
        state.sawProgress.delete(requestId);
        finalizeTransfer(requestId, {
          status: 'failed',
          statusText: '❌ Gagal — transfer tidak ditemukan di-peer',
          percent: 0,
        });
        return;
      }

      // 404 transien (transfer belum mulai mengalir) maupun error jaringan
      // sesaat — coba lagi di tick berikutnya.
    }
  }, 800);

  state.progressTimers.set(requestId, timer);
}

/**
 * Hentikan polling progres.
 * @param {string} requestId
 */
export function stopProgress(requestId) {
  const state = getState();
  if (state.progressTimers.has(requestId)) {
    clearInterval(state.progressTimers.get(requestId));
    state.progressTimers.delete(requestId);
  }
}

// ---------------------------------------------------------------------------
// Cancel & retry
// ---------------------------------------------------------------------------

/**
 * Batalkan transfer.
 * @param {string} requestId
 * @param {'send'|'receive'} role
 */
export async function cancelTransfer(requestId, role) {
  const state = getState();
  const { postJson } = await import('../core/api.js');

  stopProgress(requestId);

  try {
    await postJson(`/transfer/cancel/${encodeURIComponent(requestId)}`, { role });
    finalizeTransfer(requestId, { status: 'cancelled', statusText: '🚫 Dibatalkan' });
    state.activeTransfers.delete(requestId);
    showToast('Transfer dibatalkan', 'info');
  } catch (err) {
    showToast('Gagal membatalkan: ' + err.message, 'error');
  }
}

/**
 * Kirim ulang file yang gagal. Memakai batchId yang sama supaya peer bisa
 * melanjutkan dari partial yang sudah ada.
 * @param {string} requestId
 * @param {(newRequestId: string) => void} onResent
 */
export async function retryTransfer(requestId, onResent) {
  const info = meta.get(requestId);
  if (!info) return;

  const { postJson, fetchRequestStatus } = await import('../core/api.js');
  const state = getState();

  try {
    const res = await postJson('/transfer/request', {
      targetIp: info.ip,
      targetPort: info.port,
      fileName: info.fileName,
      fileSize: info.fileSize,
      batchId: info.batchId,
      targetName: info.targetName,
    });

    // Ganti item lama dengan item baru.
    const old = state.activeTransfers.get(requestId);
    if (old && old.el) old.el.remove();
    state.activeTransfers.delete(requestId);
    meta.delete(requestId);

    const newId = res.requestId;
    meta.set(newId, info);

    addTransferItem(newId, {
      direction: 'send',
      fileName: info.fileName,
      fileSize: info.fileSize,
      targetName: info.targetName,
      status: 'waiting',
      statusText: '⏳ Menunggu diterima...',
      batchId: info.batchId,
      filePath: info.filePath,
      ip: info.ip,
      port: info.port,
    });

    showToast('↻ Mengirim ulang...', 'info');
    if (onResent) onResent(newId);
  } catch (err) {
    showToast('Gagal mengirim ulang: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Sticky progress bar (mobile)
// ---------------------------------------------------------------------------

/**
 * Perbarui sticky progress bar di mobile — men summarizes transfer aktif.
 */
export function updateStickyProgress() {
  const bar = document.getElementById('stickyProgress');
  if (!bar) return;

  const state = getState();
  const active = Array.from(state.activeTransfers.values()).filter(
    (t) => t.status === 'transferring' || t.status === 'waiting'
  );

  if (active.length === 0) {
    bar.classList.remove('is-visible');
    return;
  }

  const total = active.length;
  const percent = active.reduce((sum, t) => {
    const fill = t.el?.querySelector('.progress-fill');
    const width = fill ? parseFloat(fill.style.width) || 0 : 0;
    return sum + width;
  }, 0) / total;

  const label = bar.querySelector('.sp-label');
  const count = bar.querySelector('.sp-count');
  const fill = bar.querySelector('.sp-bar > div');

  if (label) {
    label.textContent = total === 1
      ? 'Transfer berjalan…'
      : `${total} transfer berjalan…`;
  }
  if (count) count.textContent = `${Math.round(percent)}%`;
  if (fill) fill.style.width = percent + '%';

  bar.classList.add('is-visible');
}
