// ===== State =====
const knownRequestIds = new Set();
const activeTransfers = new Map(); // requestId -> { el, timer, type, requestId }
let currentModalRequestId = null;
let currentGroup = null; // group batch yang lagi tampil di modal
let requestQueue = []; // antrian GROUP request masuk (tampil satu-satu)
// group: { batchId, senderName, requests: [{requestId, fileName, fileSize}] }
let deviceName = '—';
let pendingTarget = null; // target device untuk file picker

// ===== Helper: Format Bytes =====
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

// ===== Helper: File Type Emoji =====
function getFileEmoji(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) return '🎵';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'mpeg', 'mpg', '3gp', 'flv', 'ts'].includes(ext)) return '🎬';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return '🖼️';
  return '📄';
}

// ===== Toast =====
function showToast(msg, type) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = `toast${type ? ' ' + type : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ===== Fetch wrapper =====
async function api(url, opts) {
  const res = await fetch(url, {
    headers: opts?.body ? { 'Content-Type': 'application/json' } : {},
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ===== Init =====
async function init() {
  try {
    const me = await api('/me');
    deviceName = me.deviceName;
    document.getElementById('deviceName').textContent = '📱 ' + deviceName;
  } catch (_) {
    document.getElementById('deviceName').textContent = '📱 ' + deviceName;
  }

  // Ambil hostname dari URL sebagai fallback device name
  setupDragDrop();
  setupTextSend();
  setupTextOverlay();
  startPolling();
}

// ===== Polling =====
let devicesTimer = null;
let pendingTimer = null;
let textTimer = null;
let progressTimers = new Map();

function startPolling() {
  devicesTimer = setInterval(fetchDevices, 2500);
  pendingTimer = setInterval(fetchPending, 2000);
  textTimer = setInterval(pollReceivedTexts, 2000);
  fetchDevices();
  fetchPending();
  pollReceivedTexts();
}

function stopPolling() {
  if (devicesTimer) { clearInterval(devicesTimer); devicesTimer = null; }
  if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
  if (textTimer) { clearInterval(textTimer); textTimer = null; }
  for (const t of progressTimers.values()) clearInterval(t);
  progressTimers.clear();
}

// ===== Devices =====
async function fetchDevices() {
  try {
    const devices = await api('/devices');
    renderDevices(devices);
  } catch (_) {}
}

function renderDevices(devices) {
  const container = document.getElementById('deviceList');

  if (!devices || devices.length === 0) {
    container.innerHTML = '<p class="empty-msg" id="emptyDevices">📡 Belum ada perangkat lain ditemukan di jaringan ini.</p>';
    return;
  }

  // Hapus pesan kosong kalau masih ada
  const emptyMsg = container.querySelector('.empty-msg');
  if (emptyMsg) emptyMsg.remove();

  // Reuse existing cards by device ID
  const existing = new Map();
  container.querySelectorAll('.device-card').forEach(el => {
    const id = el.dataset.deviceId;
    if (id) existing.set(id, el);
  });

  let html = '';
  for (const d of devices) {
    const key = d.ip + ':' + d.port;
    const card = existing.get(key);
    if (card) {
      card.dataset.lastSeen = d.lastSeen || Date.now();
      existing.delete(key);
      continue;
    }
    html += `
      <div class="device-card online"
           data-device-id="${key}"
           data-ip="${d.ip}"
           data-port="${d.transferPort || (d.port + 1)}"
           data-device-name="${d.deviceName}"
           data-last-seen="${d.lastSeen || Date.now()}">
        <div class="device-header">
          <span class="indicator"></span>
          <span class="dev-name">${escapeHtml(d.deviceName)}</span>
          <span class="dev-ip">${d.ip}:${d.port}</span>
        </div>
        <div class="drop-hint">📤 Seret file ke sini untuk mengirim</div>
        <div class="btn-file-row">
          <button class="btn-file-pick btn-media-pick" data-ip="${d.ip}" data-port="${d.transferPort || (d.port + 1)}" data-device-name="${escapeHtml(d.deviceName)}">📷 Foto/Video</button>
          <button class="btn-file-pick" data-ip="${d.ip}" data-port="${d.transferPort || (d.port + 1)}" data-device-name="${escapeHtml(d.deviceName)}">📁 File Lain</button>
          <button class="btn-file-pick btn-text-pick" data-ip="${d.ip}" data-port="${d.transferPort || (d.port + 1)}" data-device-name="${escapeHtml(d.deviceName)}">✏️ Teks</button>
        </div>
      </div>`;
  }

  // Remove stale cards (disconnected devices)
  for (const [key, el] of existing) el.remove();

  if (html) container.insertAdjacentHTML('beforeend', html);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ===== Drag & Drop =====
function setupDragDrop() {
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // Event delegation on device list
  const list = document.getElementById('deviceList');

  list.addEventListener('dragover', (e) => {
    const card = e.target.closest('.device-card');
    if (!card) return;
    card.classList.add('drag-over');
    e.preventDefault();
  });

  list.addEventListener('dragleave', (e) => {
    const card = e.target.closest('.device-card');
    if (!card) return;
    card.classList.remove('drag-over');
  });

  list.addEventListener('drop', async (e) => {
    const card = e.target.closest('.device-card');
    if (!card) return;
    card.classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const ip = card.dataset.ip;
    const port = parseInt(card.dataset.port);
    const targetName = card.dataset.deviceName;

    await sendBatch(ip, port, targetName, files);
  });

  // Click delegation untuk file picker button
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-file-pick');
    if (!btn) return;
    
    // Jangan trigger file picker untuk tombol text
    if (btn.classList.contains('btn-text-pick')) return;
    
    pendingTarget = {
      ip: btn.dataset.ip,
      port: parseInt(btn.dataset.port),
      targetName: btn.dataset.deviceName
    };
    const inputId = e.target.closest('.btn-media-pick') ? 'mediaInput' : 'fileInput';
    document.getElementById(inputId).click();
  });
}

// ===== File Picker Handlers =====
function setupFileInput(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !pendingTarget) return;
    const { ip, port, targetName } = pendingTarget;
    pendingTarget = null;
    await sendBatch(ip, port, targetName, files);
    e.target.value = ''; // reset supaya file yg sama bisa dipilih lagi
  });
}
setupFileInput('mediaInput');
setupFileInput('fileInput');

// ===== Kirim Teks =====
let textTarget = null;

function setupTextSend() {
  // Buka composer dari tombol ✏️ Teks di kartu device
  document.getElementById('deviceList').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-text-pick');
    if (!btn) return;
    textTarget = {
      ip: btn.dataset.ip,
      port: parseInt(btn.dataset.port),
      targetName: btn.dataset.deviceName
    };
    document.getElementById('textTargetName').textContent = 'ke ' + (btn.dataset.deviceName || '?');
    const textarea = document.getElementById('textInput');
    textarea.value = '';
    updateCharCount();
    textarea.focus();
    document.getElementById('textComposerModal').classList.remove('hidden');
  });

  const textarea = document.getElementById('textInput');
  textarea.addEventListener('input', updateCharCount);

  document.getElementById('btnSendText').addEventListener('click', sendText);
  document.getElementById('btnCancelText').addEventListener('click', hideTextComposer);
  document.getElementById('btnCloseTextComposer').addEventListener('click', hideTextComposer);
}

function updateCharCount() {
  const textarea = document.getElementById('textInput');
  const count = textarea.value.length;
  const countEl = document.getElementById('charCount');
  if (countEl) {
    countEl.textContent = count > 0 ? `${count} karakter` : '';
  }
}

function hideTextComposer() {
  document.getElementById('textComposerModal').classList.add('hidden');
  textTarget = null;
}

async function sendText() {
  const text = document.getElementById('textInput').value;
  if (!text.trim() || !textTarget) return;
  const target = textTarget;
  hideTextComposer();

  showToast('📤 Mengirim teks...', '');
  try {
    // Step 1: request (receiver auto-accept karena kind=text)
    const reqRes = await api('/transfer/request-text', {
      method: 'POST',
      body: JSON.stringify({ targetIp: target.ip, targetPort: target.port, fileName: 'Teks' })
    });

    // Step 2: tunggu accepted, lalu kirim isi
    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const st = await api(`/transfer/status/${reqRes.requestId}`);
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
        } catch (_) {}
      }, 1000);
    });

    // Step 3: kirim isi teks
    await api('/transfer/send-text', {
      method: 'POST',
      body: JSON.stringify({ requestId: reqRes.requestId, text })
    });

    showToast('✅ Teks terkirim', 'success');
  } catch (err) {
    showToast('❌ Gagal kirim teks: ' + err.message, 'error');
  }
}
setupTextSend();

// ===== Upload + Send Flow (multi-file) =====
async function sendBatch(ip, port, targetName, files) {
  const fileList = Array.from(files);
  if (fileList.length === 0) return;
  showToast(`📤 Mengupload ${fileList.length} file...`, '');

  try {
    // Step 1: Upload semua file ke server sendiri (1 request)
    const formData = new FormData();
    for (const f of fileList) formData.append('file', f);
    const uploadRes = await fetch('/transfer/upload', { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error('Upload gagal');
    const { files: uploaded } = await uploadRes.json();

    // batchId sama untuk semua request dalam satu kiriman
    const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    // Step 2: kirim SEMUA request dulu (bisa jadi N request dalam <100ms)
    // — biar receiver dapat daftar lengkap dalam satu popup
    const sent = [];
    for (const f of uploaded) {
      const reqRes = await api('/transfer/request', {
        method: 'POST',
        body: JSON.stringify({ targetIp: ip, targetPort: port, fileName: f.fileName, fileSize: f.fileSize, batchId })
      });
      sent.push({ requestId: reqRes.requestId, filePath: f.filePath, fileName: f.fileName, fileSize: f.fileSize });
    }

    // Step 3: tambah item + polling status semua
    for (const s of sent) {
      addTransferItem(s.requestId, {
        direction: 'send',
        fileName: s.fileName,
        fileSize: s.fileSize,
        targetName,
        status: 'waiting',
        statusText: '⏳ Menunggu diterima...'
      });
      await pollSendStatus(s.requestId, s.filePath);
    }
  } catch (err) {
    showToast('❌ Gagal: ' + err.message, 'error');
  }
}

async function pollSendStatus(requestId, filePath) {
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      // Item udah dihapus/dibatalkan → stop, jangan lempar 404 terus-menerus
      const transfer = activeTransfers.get(requestId);
      if (!transfer) {
        clearInterval(timer);
        resolve();
        return;
      }
      try {
        const st = await api(`/transfer/status/${requestId}`);

        if (st.status === 'accepted') {
          clearInterval(timer);
          updateTransferItem(requestId, { status: 'transferring', statusText: '📤 Mengirim file...' });

          // Step 5: Start file send
          try {
            await api('/transfer/send-file', {
              method: 'POST',
              body: JSON.stringify({ requestId, filePath })
            });
          } catch (err) {
            updateTransferItem(requestId, { status: 'failed', statusText: '❌ Gagal kirim: ' + err.message });
            showToast('❌ Gagal kirim file', 'error');
            resolve();
            return;
          }

          // Step 6: Start progress polling
          pollProgress(requestId, 'send');
          resolve();
        } else if (st.status === 'rejected') {
          clearInterval(timer);
          updateTransferItem(requestId, { status: 'rejected', statusText: '❌ Ditolak penerima' });
          showToast('❌ Permintaan ditolak', 'error');
          resolve();
        } else if (st.status === 'disconnected') {
          clearInterval(timer);
          updateTransferItem(requestId, { status: 'failed', statusText: '❌ Koneksi terputus' });
          showToast('❌ Koneksi ke perangkat terputus', 'error');
          resolve();
        }
      } catch (_) {}
    }, 1000);
  });
}

// ===== Pending Requests (Receiver) =====
async function fetchPending() {
  try {
    const pendings = await api('/transfer/pending');
    for (const req of pendings) {
      if (req.status !== 'pending') continue;
      if (knownRequestIds.has(req.requestId)) continue;
      knownRequestIds.add(req.requestId);

      // Group by batchId — request satu kiriman gabung jadi satu group.
      // batchId kosong (single-file/versi lama) → pakai requestId sendiri biar gak nyatu
      const groupKey = req.batchId || req.requestId;
      let group = requestQueue.find(g => g.batchId === groupKey);
      if (!group && currentGroup && currentGroup.batchId === groupKey) group = currentGroup;

      if (group) {
        group.requests.push({ requestId: req.requestId, fileName: req.fileName, fileSize: req.fileSize });
        if (currentGroup === group) renderModalGroup(group); // modal lagi tampil, update list request nyusul
      } else {
        requestQueue.push({
          batchId: groupKey,
          senderName: req.senderName,
          requests: [{ requestId: req.requestId, fileName: req.fileName, fileSize: req.fileSize }]
        });
      }
    }

    // Bonus: kalau modal lagi tampil tapi group-nya hilang dari pending (sender batalin) → auto dismiss
    if (currentGroup) {
      const modal = document.getElementById('requestModal');
      const stillPending = pendings.some(p => p.status === 'pending' && currentGroup.requests.some(r => r.requestId === p.requestId));
      const modalVisible = !modal.classList.contains('hidden');
      if (modalVisible && currentGroup && !stillPending) {
        // Semua request group ini udah gak ada di pending — berarti dibatalkan sender
        const senderName = currentGroup.senderName || 'Pengirim';
        hideModal();
        showToast(`📴 ${senderName} membatalkan kiriman`, 'info');
      }
    }

    showNextRequest();
  } catch (_) {}
}

// Render isi modal untuk satu group
function renderModalGroup(group) {
  const info = document.getElementById('modalInfo');
  const files = group.requests;

  if (files.length === 1) {
    currentModalRequestId = files[0].requestId;
    info.innerHTML = `
      <strong>${escapeHtml(group.senderName)}</strong> ingin mengirim file:<br>
      📄 <strong>${escapeHtml(files[0].fileName)}</strong> (${formatBytes(files[0].fileSize)})
    `;
  } else {
    currentModalRequestId = null; // batch — tidak terikat satu request
    const list = files.map(f =>
      `<div>${getFileEmoji(f.fileName)} ${escapeHtml(f.fileName)} <span class="modal-fsize">(${formatBytes(f.fileSize)})</span></div>`
    ).join('');
    info.innerHTML = `
      <strong>${escapeHtml(group.senderName)}</strong> ingin mengirim <strong>${files.length}</strong> file:<br>
      ${list}
    `;
  }
}

// ===== Teks Masuk (Overlay) =====
let textOverlayQueue = []; // teks yang belum ditampilkan, biar tidak menimpa yang sedang dibaca
let currentText = null;    // teks yang sedang tampil

async function pollReceivedTexts() {
  try {
    const texts = await api('/transfer/text');
    for (const t of texts) {
      if (textOverlayQueue.some(q => q.id === t.id) || (currentText && currentText.id === t.id)) continue;
      if (!t.text || !t.text.trim()) continue; // string kosong → abaikan
      if (textOverlayQueue.length === 0 && !currentText && isOverlayIdle()) {
        showTextOverlay(t);
      } else {
        textOverlayQueue.push(t);
      }
    }
  } catch (_) {}
}

function isOverlayIdle() {
  const overlay = document.getElementById('textOverlay');
  return overlay.classList.contains('hidden');
}

function showTextOverlay(t) {
  currentText = t;
  document.getElementById('textOverlaySender').textContent = t.senderName || '?';
  const body = document.getElementById('textOverlayBody');
  body.textContent = t.text;

  document.getElementById('btnCopyText').textContent = '📋 Salin';
  document.getElementById('textOverlay').classList.remove('hidden');
}

function hideTextOverlay() {
  const closingId = currentText ? currentText.id : null;
  document.getElementById('textOverlay').classList.add('hidden');
  const content = document.getElementById('textOverlayContent');
  if (content) content.style.height = '';
  currentText = null;
  ackText(closingId);
  const next = textOverlayQueue.shift();
  if (next) showTextOverlay(next);
}

async function ackText(textId) {
  if (!textId) return;
  try { await api(`/transfer/text/${textId}/ack`, { method: 'POST' }); } catch (_) {}
}

async function copyText() {
  const text = currentText ? currentText.text : '';
  if (!text) return;
  const btn = document.getElementById('btnCopyText');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✅ Disalin!';
    setTimeout(() => { btn.textContent = '📋 Salin'; }, 1500);
    return;
  } catch (_) {}
  // Fallback: execCommand('copy') — works tanpa HTTPS/localhost
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    btn.textContent = '✅ Disalin!';
    setTimeout(() => { btn.textContent = '📋 Salin'; }, 1500);
  } catch (_) {
    btn.textContent = '⚠️ Gagal copy';
    setTimeout(() => { btn.textContent = '📋 Salin'; }, 3000);
  }
  document.body.removeChild(ta);
}

// Setup text overlay event handlers
function setupTextOverlay() {
  const overlay = document.getElementById('textOverlay');
  
  // Close button handler
  const closeBtn = document.getElementById('btnCloseTextOverlay');
  if (closeBtn) {
    closeBtn.addEventListener('click', hideTextOverlay);
  }
  
  // Copy button handler
  document.getElementById('btnCopyText').addEventListener('click', copyText);
  
  // Close on backdrop click (desktop only, to avoid accidental mobile closes)
  overlay.addEventListener('click', (e) => {
    if (window.innerWidth >= 700 && e.target === overlay) {
      hideTextOverlay();
    }
  });
}

// Tampilkan group berikutnya dari antrian — cuma satu modal aktif
function showNextRequest() {
  const modal = document.getElementById('requestModal');
  if (!modal.classList.contains('hidden')) return; // masih ada yg tampil
  const group = requestQueue.shift();
  if (!group) return;
  currentGroup = group;
  renderModalGroup(group);
  modal.classList.remove('hidden');
}

function hideModal() {
  document.getElementById('requestModal').classList.add('hidden');
  currentModalRequestId = null;
  currentGroup = null;
}

// ===== Accept / Reject (batch-aware) =====
async function acceptRequest() {
  const group = currentGroup;
  if (!group) return;
  hideModal();

  for (const r of group.requests) {
    try {
      await api('/transfer/respond', {
        method: 'POST',
        body: JSON.stringify({ requestId: r.requestId, accept: true })
      });
      addTransferItem(r.requestId, {
        direction: 'receive',
        fileName: r.fileName,
        senderName: group.senderName,
        status: 'transferring',
        statusText: '⏳ Menunggu pengirim...'
      });
      // Start polling progress
      pollProgress(r.requestId, 'receive');
    } catch (err) {
      showToast(`❌ Gagal ${r.fileName}: ` + err.message, 'error');
    }
  }
  showToast(`✅ ${group.requests.length} request diterima, menunggu file...`, 'success');
  showNextRequest();
}

async function rejectRequest() {
  const group = currentGroup;
  if (!group) return;
  hideModal();

  for (const r of group.requests) {
    try {
      await api('/transfer/respond', {
        method: 'POST',
        body: JSON.stringify({ requestId: r.requestId, accept: false })
      });
    } catch (_) {}
  }
  showToast('❌ Permintaan ditolak', '');
  showNextRequest();
}

// ===== Progress Polling =====
function pollProgress(requestId, type) {
  // Avoid duplicate timers
  if (progressTimers.has(requestId)) {
    clearInterval(progressTimers.get(requestId));
  }

  const timer = setInterval(async () => {
    // Item udah dihapus/dibatalkan → stop polling
    if (!activeTransfers.has(requestId)) {
      clearInterval(timer);
      progressTimers.delete(requestId);
      return;
    }
    try {
      const prog = await api(`/transfer/progress/${requestId}`);
      if (!prog) return;

      const percent = prog.percent || 0;
      const transferred = prog.bytesTransferred || 0;
      const total = prog.fileSize || 0;

      if (prog.status === 'cancelled') {
        clearInterval(timer);
        progressTimers.delete(requestId);
        updateTransferItem(requestId, {
          status: 'cancelled',
          statusText: '🚫 Dibatalkan',
          percent,
          transferred,
          total
        });
        return;
      }

      if (prog.status === 'completed') {
        clearInterval(timer);
        progressTimers.delete(requestId);
        const label = type === 'send' ? '✅ Terkirim' : '✅ Selesai diterima';
        updateTransferItem(requestId, {
          status: 'completed',
          statusText: label,
          percent: 100,
          transferred,
          total
        });
        showToast(`✅ ${prog.fileName} — ${label}`, 'success');
        return;
      }

      if (prog.status === 'failed') {
        clearInterval(timer);
        progressTimers.delete(requestId);
        updateTransferItem(requestId, {
          status: 'failed',
          statusText: '❌ Gagal',
          percent,
          transferred,
          total
        });
        showToast('❌ Transfer gagal', 'error');
        return;
      }

      // Still transferring
      const statusText = type === 'send'
        ? `📤 Mengirim ${formatBytes(transferred)} / ${formatBytes(total)}`
        : `📥 Menerima ${formatBytes(transferred)} / ${formatBytes(total)}`;

      updateTransferItem(requestId, {
        status: 'transferring',
        statusText,
        percent,
        transferred,
        total
      });
    } catch (_) {
      // Progress not found yet — keep polling
    }
  }, 800);

  progressTimers.set(requestId, timer);
}

// ===== Transfer List Rendering =====
function addTransferItem(requestId, data) {
  const list = document.getElementById('transferList');
  // Remove empty message
  const empty = list.querySelector('.empty-msg');
  if (empty) empty.remove();

  // Remove existing item for same requestId
  const existing = list.querySelector(`[data-rid="${requestId}"]`);
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'transfer-item';
  div.dataset.rid = requestId;

  const dirClass = data.direction === 'send' ? 'send' : 'receive';
  const dirLabel = data.direction === 'send'
    ? `→ ${escapeHtml(data.targetName || '?')}`
    : `← ${escapeHtml(data.senderName || '?')}`;
  const fileName = escapeHtml(data.fileName || '?');
  const fileEmoji = getFileEmoji(data.fileName || '');

  // Tombol Batal: cuma untuk pengirim, status 'waiting'/'transferring'
  const canCancel = data.direction === 'send' && (data.status === 'waiting' || data.status === 'transferring');
  const cancelBtn = canCancel
    ? `<button class="btn-cancel" data-rid="${requestId}">✕ Batal</button>`
    : '';

  div.innerHTML = `
    <div class="tf-header">
      <span class="tf-name">${fileEmoji} ${fileName}</span>
      <span class="tf-direction ${dirClass}">${dirLabel}</span>
      ${cancelBtn}
    </div>
    <div class="tf-status ${data.status}">${data.statusText || ''}</div>
    <div class="progress-bar">
      <div class="progress-fill ${data.status === 'completed' ? 'completed' : ''} ${data.status === 'failed' ? 'failed' : ''}" style="width:${data.percent || 0}%"></div>
    </div>
    <div class="progress-text">${data.percent || 0}%</div>
  `;

  list.appendChild(div);
  activeTransfers.set(requestId, { el: div, requestId });
}

function updateTransferItem(requestId, data) {
  const transfer = activeTransfers.get(requestId);
  if (!transfer || !transfer.el) return;
  const el = transfer.el;

  if (data.statusText) {
    const st = el.querySelector('.tf-status');
    if (st) {
      st.textContent = data.statusText;
      st.className = 'tf-status ' + (data.status || '');
    }
  }

  if (data.percent !== undefined) {
    const fill = el.querySelector('.progress-fill');
    if (fill) {
      fill.style.width = data.percent + '%';
      fill.className = 'progress-fill';
      if (data.status === 'completed') fill.classList.add('completed');
      if (data.status === 'failed') fill.classList.add('failed');
    }
    const pt = el.querySelector('.progress-text');
    if (pt) pt.textContent = data.percent + '%';
  }

  // Hapus tombol Batal begitu status terminal (transfer kelar) — biar gak bisa diklik lagi
  if (data.status === 'completed' || data.status === 'failed' || data.status === 'rejected' || data.status === 'cancelled') {
    const btn = el.querySelector('.btn-cancel');
    if (btn) btn.remove();
  }

  // Clean up completed/failed/cancelled from activeTransfers after a delay
  if (data.status === 'completed' || data.status === 'failed' || data.status === 'rejected' || data.status === 'cancelled') {
    setTimeout(() => {
      activeTransfers.delete(requestId);
    }, 5000);
  }
}

// ===== Button Listeners =====
document.getElementById('btnAccept').addEventListener('click', acceptRequest);
document.getElementById('btnReject').addEventListener('click', rejectRequest);

// Cancel transfer (pengirim) — event delegation biar button dinamis kebaca
document.getElementById('transferList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-cancel');
  if (!btn) return;
  const requestId = btn.dataset.rid;
  btn.disabled = true;
  try {
    await api(`/transfer/cancel/${requestId}`, {
      method: 'POST',
      body: JSON.stringify({ role: 'send' })
    });
    if (progressTimers.has(requestId)) {
      clearInterval(progressTimers.get(requestId));
      progressTimers.delete(requestId);
    }
    updateTransferItem(requestId, { status: 'cancelled', statusText: '🚫 Dibatalkan' });
    // Hapus dari activeTransfers segera → pollSendStatus/pollProgress yang masih jalan langsung stop
    activeTransfers.delete(requestId);
  } catch (err) {
    showToast('❌ Gagal membatalkan: ' + err.message, 'error');
    btn.disabled = false;
  }
});

// ===== Start =====
init();

// ===== Ripple Background Effect =====
(function initRippleBackground() {
  // Nonaktifkan untuk layar kecil (mobile) — performa
  if (window.innerWidth < 700) return;
  // Hormati preferensi reduced-motion OS
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'ripple-bg';
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.zIndex = '0';
  canvas.style.pointerEvents = 'none';
  document.body.insertBefore(canvas, document.body.firstChild);

  const ctx = canvas.getContext('2d');
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let dots = [];
  const SPACING = 40;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    dots = [];
    for (let x = 0; x < canvas.width + SPACING; x += SPACING) {
      for (let y = 0; y < canvas.height + SPACING; y += SPACING) {
        dots.push({ baseX: x, baseY: y });
      }
    }
  }
  window.addEventListener('resize', resize);
  resize();

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const dot of dots) {
      const dx = dot.baseX - mouseX;
      const dy = dot.baseY - mouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = 200;
      const influence = Math.max(0, 1 - dist / maxDist);
      const radius = 1.5 + influence * 3;
      const opacity = 0.04 + influence * 0.10;

      ctx.beginPath();
      ctx.arc(dot.baseX, dot.baseY, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(91, 141, 239, ${opacity})`;
      ctx.fill();
    }
    requestAnimationFrame(animate);
  }
  animate();
})();
