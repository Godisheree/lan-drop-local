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

  // Urutan: MINTA IZIN DULU, upload belakangan.
  //
  // Dulu file di-upload utuh ke server ini sebelum permintaan dikirim. Untuk
  // video 2 GB itu artinya: user nunggu upload kelar, penerima baru dapat
  // dialog "Terima?", dan kalau ditolak semua byte itu sudah kepindah. Sekarang
  // yang dikirim duluan cuma metadata (nama + ukuran, beberapa ratus byte),
  // jadi dialog muncul seketika dan penolakan berhenti sebelum satu byte pun
  // bergerak.
  const { postJson } = await import('../core/api.js');
  const batchId = files.length > 1
    ? Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    : undefined;
  const batchLabel = `Kirim ke ${target.targetName}`;

  let sent = 0;

  for (const file of files) {
    let res;
    try {
      res = await postJson('/transfer/request', {
        targetIp: target.ip,
        targetPort: target.port,
        fileName: file.name,
        fileSize: file.size,
        batchId,
        targetName: target.targetName,
      });
    } catch (err) {
      showToast(`Gagal mengirim ${file.name}: ${err.message}`, 'error');
      continue;
    }

    sent += 1;

    const item = {
      requestId: res.requestId,
      file,                 // di-upload setelah penerima menekan "Terima"
      fileName: file.name,
      fileSize: file.size,
      targetName: target.targetName,
      ip: target.ip,
      port: target.port,
      batchId,
      batchSize: files.length,
    };

    addTransferItem(item.requestId, {
      direction: 'send',
      fileName: item.fileName,
      fileSize: item.fileSize,
      targetName: item.targetName,
      status: 'waiting',
      statusText: 'Menunggu diterima...',
      batchId,
      batchSize: files.length,
      batchLabel,
      file: file,           // disimpan untuk "Kirim ulang" sebelum upload
      ip: item.ip,
      port: item.port,
    });

    waitForAccept(item);
  }

  if (sent > 0) {
    showToast(
      sent === 1
        ? 'Permintaan dikirim, menunggu diterima...'
        : `${sent} file dikirim, menunggu diterima...`,
      'info'
    );
  }
}

/**
 * Tunggu peer menerima request, lalu mulai streaming file.
 * @param {Object} item
 */
export async function waitForAccept(item) {
  const state = getState();
  const { fetchRequestStatus } = await import('../core/api.js');

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
        statusText: 'Penerima tidak merespons dalam 60 detik',
      });
      showToast('Penerima tidak merespons', 'error');
      return;
    }

    try {
      const st = await fetchRequestStatus(item.requestId);

      if (st.status === 'accepted') {
        clearInterval(timer);
        state.waitStartedAt.delete(item.requestId);
        // Baru sekarang file-nya di-upload: penerima sudah setuju, jadi tidak
        // ada byte yang bergerak sia-sia.
        await uploadThenStart(item, st.resumeOffset || 0);
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
          statusText: st.reason ? st.reason : 'Ditolak penerima',
        });
        showToast(st.reason || 'Permintaan ditolak', 'error');
        return;
      }

      if (st.status === 'disconnected') {
        clearInterval(timer);
        state.waitStartedAt.delete(item.requestId);
        updateTransferItem(item.requestId, {
          status: 'failed',
          statusText: 'Koneksi ke perangkat terputus',
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
          statusText: 'Permintaan hilang — perangkat mungkin mati',
        });
        showToast('Permintaan hilang', 'error');
        return;
      }
      // 404 (request hilang) diabaikan — coba lagi di tick berikutnya.
    }
  }, 1000);
}

/**
 * Upload file lalu mulai streaming — dipanggil HANYA setelah penerima setuju.
 *
 * Kalau `item.file` tidak ada (mis. kirim ulang setelah halaman di-reload),
 * pakai `item.filePath` yang masih tersimpan di buffer server.
 *
 * @param {Object} item
 * @param {number} resumeOffset byte yang sudah dimiliki penerima
 */
async function uploadThenStart(item, resumeOffset) {
  const { postJson, fetchRequestStatus } = await import('../core/api.js');

  let filePath = item.filePath || null;

  if (item.file) {
    const controller = new AbortController();
    uploadControllers.set(item.requestId, controller);

    updateTransferItem(item.requestId, {
      statusText: `Mengunggah ${item.fileName} (0%)...`,
      percent: 0,
    });

    try {
      const uploaded = await uploadFiles(
        [item.file],
        (percent) => {
          // User menekan Batal selama upload: item sudah dibuang dari daftar
          // aktif, jadi hentikan upload-nya. Tanpa ini, file 2 GB yang sudah
          // dibatalkan tetap dipindah sampai habis.
          if (!getState().activeTransfers.has(item.requestId)) {
            controller.abort();
            return;
          }
          updateTransferItem(item.requestId, {
            statusText: `Mengunggah ${item.fileName} (${percent}%)...`,
            percent,
          });
        },
        controller.signal
      );
      filePath = uploaded && uploaded[0] ? uploaded[0].filePath : null;
    } catch (err) {
      uploadControllers.delete(item.requestId);
      const aborted = err.name === 'AbortError';
      updateTransferItem(item.requestId, {
        status: aborted ? 'cancelled' : 'failed',
        statusText: aborted ? 'Dibatalkan' : 'Gagal mengunggah: ' + err.message,
      });
      if (aborted) {
        // Permintaan sudah di-ACC dan penerima sedang menunggu byte. Beri tahu
        // dia supaya koneksinya ditutup, bukan menggantung sampai timeout.
        try { await postJson(`/transfer/cancel/${encodeURIComponent(item.requestId)}`, { role: 'send' }); } catch (_) {}
      } else {
        showToast('Gagal upload: ' + err.message, 'error');
      }
      return;
    }

    uploadControllers.delete(item.requestId);
  }

  if (!filePath) {
    updateTransferItem(item.requestId, {
      status: 'failed',
      statusText: 'File sumber tidak tersedia — kirim ulang filenya',
    });
    return;
  }

  // Selama upload (bisa menit-an untuk file besar) penerima bisa membatalkan
  // atau koneksinya putus. Cek sekali lagi supaya `/transfer/send-file` tidak
  // balas error untuk transfer yang sebenarnya sudah selesai urusannya.
  try {
    const st = await fetchRequestStatus(item.requestId);
    if (st.status !== 'accepted') {
      const cancelled = st.status === 'cancelled';
      updateTransferItem(item.requestId, {
        status: cancelled ? 'cancelled' : 'failed',
        statusText: cancelled ? 'Dibatalkan' : 'Koneksi ke perangkat terputus',
      });
      return;
    }
  } catch (_) {
    // Status hilang (server restart) — biar `/transfer/send-file` yang melapor.
  }

  updateTransferItem(item.requestId, {
    status: 'transferring',
    statusText: resumeOffset > 0 && item.fileSize > 0
      ? `↻ Melanjutkan dari ${Math.round((resumeOffset / item.fileSize) * 100)}%...`
      : 'Mengirim file...',
    percent: 0,
  });

  try {
    await postJson('/transfer/send-file', {
      requestId: item.requestId,
      filePath,
    });
    pollProgress(item.requestId, 'send');
  } catch (err) {
    updateTransferItem(item.requestId, {
      status: 'failed',
      statusText: 'Gagal kirim: ' + err.message,
    });
    showToast('Gagal kirim file', 'error');
  }
}

/**
 * Batalkan upload yang sedang berjalan.
 * @param {string} requestId
 */
export function cancelUpload(requestId) {
  const controller = uploadControllers.get(requestId);
  if (!controller) return false;
  controller.abort();
  uploadControllers.delete(requestId);
  return true;
}

/**
 * Kirim teks ke perangkat.
 * @param {Object} target - { ip, port, targetName }
 * @param {string} text
 */
export async function sendText(target, text) {
  const { postJson, fetchRequestStatus } = await import('../core/api.js');

  showToast('Mengirim teks...', 'info');

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
    showToast('Teks terkirim', 'success');
    announce('Teks terkirim');
  } catch (err) {
    showToast('Gagal kirim teks: ' + err.message, 'error');
  }
}
