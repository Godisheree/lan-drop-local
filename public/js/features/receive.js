/**
 * Permintaan transfer masuk (sisi penerima): antrian, modal, terima/tolak.
 *
 * Menggantikan fetchPending() / renderModalGroup() / acceptRequest() /
 * rejectRequest() dari client.js lama.
 */

import { el, clear, byId } from '../core/dom.js';
import { formatBytes, fileEmoji } from '../core/format.js';
import { getState, setState } from '../core/state.js';
import { showToast, notify, announce } from './notify.js';
import { openModal, closeModal } from './a11y.js';
import { addTransferItem, pollProgress } from './transfers.js';

let modalCloser = null;

/**
 * Ambil permintaan masuk yang baru dan tampilkan modal.
 */
export async function pollPending() {
  const state = getState();

  try {
    const { fetchPending } = await import('../core/api.js');
    const pendings = await fetchPending();

    for (const req of pendings) {
      if (req.status !== 'pending') continue;
      if (state.knownRequestIds.has(req.requestId)) continue;
      state.knownRequestIds.add(req.requestId);

      // Kelompokkan request satu kiriman jadi satu batch.
      const groupKey = req.batchId || req.requestId;
      let group = state.requestQueue.find((g) => g.batchId === groupKey);
      if (!group && state.currentGroup && state.currentGroup.batchId === groupKey) {
        group = state.currentGroup;
      }

      if (group) {
        group.requests.push({
          requestId: req.requestId,
          fileName: req.fileName,
          fileSize: req.fileSize,
        });
        // Modal lagi tampil — perbarui daftar file di dalamnya.
        if (state.currentGroup === group) renderGroup(group);
      } else {
        state.requestQueue.push({
          batchId: groupKey,
          senderName: req.senderName,
          requests: [{
            requestId: req.requestId,
            fileName: req.fileName,
            fileSize: req.fileSize,
          }],
        });
      }
    }

    // Peer membatalkan semua request group yang sedang tampil → tutup modal.
    if (state.currentGroup) {
      const stillPending = pendings.some(
        (p) => p.status === 'pending' &&
          state.currentGroup.requests.some((r) => r.requestId === p.requestId)
      );
      if (!stillPending && !byId('requestModal').classList.contains('hidden')) {
        const senderName = state.currentGroup.senderName || 'Pengirim';
        dismissModal();
        showToast(`📴 ${senderName} membatalkan kiriman`, 'info');
      }
    }

    showNextRequest();
  } catch (_) {
    // Server tidak terjangkau — coba lagi di poll berikutnya.
  }
}

/**
 * Render isi modal untuk satu group request.
 * @param {Object} group
 */
function renderGroup(group) {
  const info = byId('modalInfo');
  const files = group.requests;

  clear(info);

  const sender = el('strong', { text: group.senderName || 'Tanpa nama' });

  if (files.length === 1) {
    info.appendChild(el('p', {}, [
      sender,
      ' ingin mengirim file:',
    ]));
    info.appendChild(el('div', { class: 'file-list-row' }, [
      el('span', { 'aria-hidden': 'true', text: fileEmoji(files[0].fileName) }),
      el('span', { class: 'fl-name', text: files[0].fileName }),
      el('span', { class: 'modal-fsize', text: formatBytes(files[0].fileSize) }),
    ]));
  } else {
    info.appendChild(el('p', {}, [
      sender,
      ' ingin mengirim ',
      el('strong', { text: String(files.length) }),
      ' file:',
    ]));

    const list = el('div', { class: 'file-list' });
    for (const file of files) {
      list.appendChild(el('div', { class: 'file-list-row' }, [
        el('span', { 'aria-hidden': 'true', text: fileEmoji(file.fileName) }),
        el('span', { class: 'fl-name', text: file.fileName }),
        el('span', { class: 'modal-fsize', text: formatBytes(file.fileSize) }),
      ]));
    }
    info.appendChild(list);
  }

  const totalSize = files.reduce((sum, f) => sum + (f.fileSize || 0), 0);
  info.appendChild(el('p', {
    class: 'modal-fsize',
    text: `Total ${formatBytes(totalSize)} — akan disimpan di folder LAN DROP`,
  }));
}

/**
 * Tampilkan group berikutnya dari antrian.
 */
function showNextRequest() {
  const state = getState();
  const modal = byId('requestModal');
  if (!modal.classList.contains('hidden')) return;

  const group = state.requestQueue.shift();
  if (!group) return;

  setState({ currentGroup: group });
  renderGroup(group);

  modalCloser = openModal('requestModal', {
    onEscape: () => {
      // Escape berarti tolak — jangan biarkan modal menggantung.
      rejectCurrent();
    },
  });

  notify(`${group.senderName || 'Seseorang'} ingin mengirim file`, {
    type: 'info',
    sound: true,
    badge: true,
  });
  announce(`Permintaan masuk dari ${group.senderName || 'seseorang'}`);
}

/**
 * Tutup modal tanpa menerima.
 */
function dismissModal() {
  if (modalCloser) {
    modalCloser();
    modalCloser = null;
  }
  closeModal('requestModal');
  setState({ currentGroup: null });
}

/**
 * Terima request group yang sedang tampil.
 */
export async function acceptCurrent() {
  const state = getState();
  const group = state.currentGroup;
  if (!group) return;

  dismissModal();

  const { postJson } = await import('../core/api.js');

  for (const request of group.requests) {
    try {
      await postJson('/transfer/respond', { requestId: request.requestId, accept: true });

      addTransferItem(request.requestId, {
        direction: 'receive',
        fileName: request.fileName,
        fileSize: request.fileSize,
        senderName: group.senderName,
        status: 'transferring',
        statusText: '⏳ Menunggu pengirim...',
        batchId: group.requests.length > 1 ? group.batchId : undefined,
        batchSize: group.requests.length,
        batchLabel: `Dari ${group.senderName}`,
      });

      pollProgress(request.requestId, 'receive');
    } catch (err) {
      showToast(`❌ Gagal menerima ${request.fileName}: ${err.message}`, 'error');
    }
  }

  const count = group.requests.length;
  showToast(
    count === 1 ? '✅ Diterima, menunggu file...' : `✅ ${count} file diterima, menunggu file...`,
    'success'
  );

  showNextRequest();
}

/**
 * Tolak request group yang sedang tampil.
 */
export async function rejectCurrent() {
  const state = getState();
  const group = state.currentGroup;
  if (!group) return;

  dismissModal();

  const { postJson } = await import('../core/api.js');

  for (const request of group.requests) {
    try {
      await postJson('/transfer/respond', { requestId: request.requestId, accept: false });
    } catch (_) {
      // Peer mungkin sudah mati — abaikan.
    }
  }

  showToast('Permintaan ditolak', 'info');
  showNextRequest();
}

/**
 * Setup tombol modal.
 */
export function setupRequestModal() {
  byId('btnAccept').addEventListener('click', acceptCurrent);
  byId('btnReject').addEventListener('click', rejectCurrent);
}
