/**
 * Alur kirim: upload file ke server sendiri, kirim request, tunggu accept,
 * lalu mulai streaming.
 *
 * Menggantikan sendBatch() / pollSendStatus() / retryTransfer() dari client.js lama.
 */

import { getState } from '../core/state.js';
import { showToast, announce } from './notify.js';
import { addTransferItem, updateTransferItem, pollProgress } from './transfers.js';

/** @type {Map<string, AbortController>} batchId -> controller upload */
const uploadControllers = new Map();

/**
 * Upload file ke server sendiri dengan progres.
 *
 * Pakai XMLHttpRequest (bukan fetch) karena fetch tidak memberi event
 * progres upload — dan user perlu tahu file 2 GB sudah sampai mana.
 *
 * @param {File[]} files
 * @param {(percent: number) => void} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{filePath: string, fileName: string, fileSize: number}>>}
 */
function uploadFiles(files, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const file of files) formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/transfer/upload');

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).files || []);
        } catch (err) {
          reject(new Error('Respons upload tidak valid'));
        }
      } else {
        reject(new Error(`Upload gagal (HTTP ${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Upload gagal — koneksi terputus')));
    xhr.addEventListener('abort', () => {
      const err = new Error('Upload dibatalkan');
      err.name = 'AbortError';
      reject(err);
    });

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(formData);
  });
}

/**
 * Kirim batch file ke sebuah perangkat.
 *
 * @param {Object} target - { ip, port, targetName }
 * @param {File[]} files
 */
export async function sendBatch(target, files) {
  if (!files || files.length === 0) return;

  const state = getState();
  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const controller = new AbortController();
  uploadControllers.set(batchId, controller);

  // Tampilkan item "mengupload" lebih dulu supaya user punya feedback.
  const placeholderId = `upload-${batchId}`;
  addTransferItem(placeholderId, {
    direction: 'send',
    fileName: files.length === 1 ? files[0].name : `${files.length} file`,
    fileSize: files.reduce((sum, f) => sum + f.size, 0),
    targetName: target.targetName,
    status: 'waiting',
    statusText: `📤 Mengupload ${files.length} file (0%)…`,
    batchId: files.length > 1 ? batchId : undefined,
    batchSize: files.length,
    batchLabel: `Kirim ke ${target.targetName}`,
  });

  let uploaded;
  try {
    uploaded = await uploadFiles(
      files,
      (percent) => {
        updateTransferItem(placeholderId, {
          statusText: `📤 Mengupload ${files.length} file (${percent}%)…`,
        });
      },
      controller.signal
    );
  } catch (err) {
    uploadControllers.delete(batchId);
    const aborted = err.name === 'AbortError';
    updateTransferItem(placeholderId, {
      status: aborted ? 'cancelled' : 'failed',
      statusText: aborted ? '🚫 Upload dibatalkan' : '❌ Gagal upload: ' + err.message,
    });
    if (aborted) showToast('Upload dibatalkan', 'info');
    else showToast('Gagal upload: ' + err.message, 'error');
    return;
  }

  uploadControllers.delete(batchId);

  // Ganti placeholder dengan item asli per file.
  const oldItem = state.activeTransfers.get(placeholderId);
  if (oldItem && oldItem.el) oldItem.el.remove();
  state.activeTransfers.delete(placeholderId);

  const sent = [];
  for (const file of uploaded) {
    try {
      const { postJson } = await import('../core/api.js');
      const res = await postJson('/transfer/request', {
        targetIp: target.ip,
        targetPort: target.port,
        fileName: file.fileName,
        fileSize: file.fileSize,
        batchId,
      });
      sent.push({
        requestId: res.requestId,
        filePath: file.filePath,
        fileName: file.fileName,
        fileSize: file.fileSize,
      });
    } catch (err) {
      showToast(`Gagal mengirim ${file.fileName}: ${err.message}`, 'error');
    }
  }

  if (sent.length === 0) return;

  showToast(
    sent.length === 1
      ? '📤 Permintaan dikirim, menunggu diterima...'
      : `📤 ${sent.length} file dikirim, menunggu diterima...`,
    'info'
  );

  // Semua request sudah terkirim; poll status masing-masing secara paralel.
  for (const item of sent) {
    addTransferItem(item.requestId, {
      direction: 'send',
      fileName: item.fileName,
      fileSize: item.fileSize,
      targetName: target.targetName,
      status: 'waiting',
      statusText: '⏳ Menunggu diterima...',
      batchId: sent.length > 1 ? batchId : undefined,
      batchSize: sent.length,
      batchLabel: `Kirim ke ${target.targetName}`,
      filePath: item.filePath,
      ip: target.ip,
      port: target.port,
    });

    waitForAccept(item);
  }
}

/**
 * Tunggu peer menerima request, lalu mulai streaming file.
 * @param {Object} item
 */
async function waitForAccept(item) {
  const state = getState();
  const { fetchRequestStatus, postJson } = await import('../core/api.js');

  const started = Date.now();
  let lastTick = started;

  const timer = setInterval(async () => {
    if (!state.activeTransfers.has(item.requestId)) {
      clearInterval(timer);
      return;
    }

    const now = Date.now();

    // Peer tidak merespons dalam batas waktu — berhenti menunggu.
    if (now - started > 60000) {
      clearInterval(timer);
      updateTransferItem(item.requestId, {
        status: 'failed',
        statusText: '❌ Penerima tidak merespons dalam 60 detik',
      });
      showToast('Penerima tidak merespons', 'error');
      return;
    }

    try {
      const st = await fetchRequestStatus(item.requestId);

      if (st.status === 'accepted') {
        clearInterval(timer);
        state.waitStartedAt.delete(item.requestId);

        if (st.resumeOffset > 0) {
          const pct = item.fileSize > 0
            ? Math.round((st.resumeOffset / item.fileSize) * 100)
            : 0;
          updateTransferItem(item.requestId, {
            status: 'transferring',
            statusText: `↻ Melanjutkan dari ${pct}%...`,
          });
        } else {
          updateTransferItem(item.requestId, {
            status: 'transferring',
            statusText: '📤 Mengirim file...',
          });
        }

        try {
          await postJson('/transfer/send-file', {
            requestId: item.requestId,
            filePath: item.filePath,
          });
          pollProgress(item.requestId, 'send');
        } catch (err) {
          updateTransferItem(item.requestId, {
            status: 'failed',
            statusText: '❌ Gagal kirim: ' + err.message,
          });
          showToast('Gagal kirim file', 'error');
        }
        return;
      }

      if (st.status === 'rejected') {
        clearInterval(timer);
        state.waitStartedAt.delete(item.requestId);
        // Penerima bisa menolak otomatis dengan alasan (mis. ruang disk
        // tidak cukup). Tampilkan alasannya — "Ditolak penerima" saja bikin
        // user mengira orangnya yang menolak.
        updateTransferItem(item.requestId, {
          status: 'rejected',
          statusText: st.reason ? `❌ ${st.reason}` : '❌ Ditolak penerima',
        });
        showToast(st.reason || 'Permintaan ditolak', 'error');
        return;
      }

      if (st.status === 'disconnected') {
        clearInterval(timer);
        state.waitStartedAt.delete(item.requestId);
        updateTransferItem(item.requestId, {
          status: 'failed',
          statusText: '❌ Koneksi ke perangkat terputus',
        });
        showToast('Koneksi ke perangkat terputus', 'error');
        return;
      }
    } catch (err) {
      // Request tidak ada (server restart / peer hilang).
      if (err && /not found/i.test(err.message)) {
        clearInterval(timer);
        state.waitStartedAt.delete(item.requestId);
        updateTransferItem(item.requestId, {
          status: 'failed',
          statusText: '❌ Permintaan hilang — perangkat mungkinmati',
        });
        showToast('Permintaan hilang', 'error');
        return;
      }
      // 404 (request hilang) diabaikan — coba lagi di tick berikutnya.
    }
  }, 1000);
}

/**
 * Batalkan upload yang sedang berjalan.
 * @param {string} batchId
 */
export function cancelUpload(batchId) {
  const controller = uploadControllers.get(batchId);
  if (!controller) return false;
  controller.abort();
  uploadControllers.delete(batchId);
  return true;
}

/**
 * Kirim teks ke perangkat.
 * @param {Object} target - { ip, port, targetName }
 * @param {string} text
 */
export async function sendText(target, text) {
  const { postJson, fetchRequestStatus } = await import('../core/api.js');

  showToast('📤 Mengirim teks...', 'info');

  try {
    const reqRes = await postJson('/transfer/request-text', {
      targetIp: target.ip,
      targetPort: target.port,
      fileName: 'Teks',
    });

    // Tunggu peer menerima (teks di-auto-accept).
    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const st = await fetchRequestStatus(reqRes.requestId);
          if (st.status === 'accepted') {
            clearInterval(timer);
            resolve();
          } else if (st.status === 'rejected') {
            clearInterval(timer);
            reject(new Error('Ditolak penerima'));
          } else if (st.status === 'disconnected') {
            clearInterval(timer);
            reject(new Error('Koneksi terputus'));
          }
        } catch (_) {
          // biarkan — cek lagi di tick berikutnya
        }
      }, 1000);

      // Batas waktu agar tidak menggantung selamanya.
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('Penerima tidak merespons'));
      }, 30000);
    });

    await postJson('/transfer/send-text', { requestId: reqRes.requestId, text });
    showToast('✅ Teks terkirim', 'success');
    announce('Teks terkirim');
  } catch (err) {
    showToast('❌ Gagal kirim teks: ' + err.message, 'error');
  }
}
