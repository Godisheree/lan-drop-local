// ===== State =====
const knownRequestIds = new Set();
const activeTransfers = new Map(); // requestId -> { el, timer, type, requestId }
let currentModalRequestId = null;
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
  startPolling();
}

// ===== Polling =====
let devicesTimer = null;
let pendingTimer = null;
let progressTimers = new Map();

function startPolling() {
  devicesTimer = setInterval(fetchDevices, 2500);
  pendingTimer = setInterval(fetchPending, 2000);
  fetchDevices();
  fetchPending();
}

function stopPolling() {
  if (devicesTimer) { clearInterval(devicesTimer); devicesTimer = null; }
  if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
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
        <button class="btn-file-pick" data-ip="${d.ip}" data-port="${d.transferPort || (d.port + 1)}" data-device-name="${escapeHtml(d.deviceName)}">+ Pilih File</button>
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

    const file = e.dataTransfer.files[0];
    if (!file) return;

    const ip = card.dataset.ip;
    const port = parseInt(card.dataset.port);
    const targetName = card.dataset.deviceName;

    await uploadAndSend(ip, port, targetName, file);
  });

  // Click delegation untuk file picker button
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-file-pick');
    if (!btn) return;
    pendingTarget = {
      ip: btn.dataset.ip,
      port: parseInt(btn.dataset.port),
      targetName: btn.dataset.deviceName
    };
    document.getElementById('fileInput').click();
  });
}

// ===== File Picker Handler =====
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !pendingTarget) return;
  const { ip, port, targetName } = pendingTarget;
  pendingTarget = null;
  await uploadAndSend(ip, port, targetName, file);
  e.target.value = ''; // reset supaya file yg sama bisa dipilih lagi
});

// ===== Upload + Send Flow =====
async function uploadAndSend(ip, port, targetName, file) {
  // Show file info immediately
  showToast(`📤 Mengupload ${file.name} (${formatBytes(file.size)})...`, '');

  try {
    // Step 1: Upload file to own server
    const formData = new FormData();
    formData.append('file', file);
    const uploadRes = await fetch('/transfer/upload', { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error('Upload gagal');
    const { filePath, fileName, fileSize } = await uploadRes.json();

    showToast(`📤 Mengirim request ke ${targetName}...`, '');

    // Step 2: Send transfer request
    const reqRes = await api('/transfer/request', {
      method: 'POST',
      body: JSON.stringify({ targetIp: ip, targetPort: port, fileName, fileSize })
    });
    const { requestId } = reqRes;

    // Step 3: Add to active transfers (sending, waiting)
    addTransferItem(requestId, {
      direction: 'send',
      fileName,
      fileSize,
      targetName,
      status: 'waiting',
      statusText: '⏳ Menunggu diterima...'
    });

    // Step 4: Poll status until accepted/rejected
    await pollSendStatus(requestId, filePath);

  } catch (err) {
    showToast('❌ Gagal: ' + err.message, 'error');
  }
}

async function pollSendStatus(requestId, filePath) {
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
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
      showRequestModal(req);
    }
  } catch (_) {}
}

function showRequestModal(req) {
  currentModalRequestId = req.requestId;
  const modal = document.getElementById('requestModal');
  const info = document.getElementById('modalInfo');
  info.innerHTML = `
    <strong>${escapeHtml(req.senderName)}</strong> ingin mengirim file:<br>
    📄 <strong>${escapeHtml(req.fileName)}</strong> (${formatBytes(req.fileSize)})
  `;
  modal.classList.remove('hidden');
}

function hideModal() {
  document.getElementById('requestModal').classList.add('hidden');
  currentModalRequestId = null;
}

// ===== Accept / Reject =====
async function acceptRequest() {
  const requestId = currentModalRequestId;
  if (!requestId) return;
  hideModal();

  try {
    await api('/transfer/respond', {
      method: 'POST',
      body: JSON.stringify({ requestId, accept: true })
    });

    // Find request info from knownRequestIds or we can fetch pending again
    // We stored senderName and fileName in the modal, let's add transfer item
    const infoEl = document.getElementById('modalInfo');
    const senderMatch = infoEl.textContent.match(/(.+?) ingin mengirim/);
    const senderName = senderMatch ? senderMatch[1].trim() : 'Unknown';
    const fileNameMatch = infoEl.textContent.match(/📄\s+(.+?)\s+\(/);
    const fileName = fileNameMatch ? fileNameMatch[1].trim() : 'File';

    addTransferItem(requestId, {
      direction: 'receive',
      fileName,
      senderName,
      status: 'transferring',
      statusText: '⏳ Menunggu pengirim...'
    });

    // Start polling progress
    pollProgress(requestId, 'receive');
    showToast('✅ Request diterima, menunggu file...', 'success');
  } catch (err) {
    showToast('❌ Gagal: ' + err.message, 'error');
  }
}

async function rejectRequest() {
  const requestId = currentModalRequestId;
  if (!requestId) return;
  hideModal();

  try {
    await api('/transfer/respond', {
      method: 'POST',
      body: JSON.stringify({ requestId, accept: false })
    });
    showToast('❌ Permintaan ditolak', '');
  } catch (err) {
    showToast('❌ Gagal: ' + err.message, 'error');
  }
}

// ===== Progress Polling =====
function pollProgress(requestId, type) {
  // Avoid duplicate timers
  if (progressTimers.has(requestId)) {
    clearInterval(progressTimers.get(requestId));
  }

  const timer = setInterval(async () => {
    try {
      const prog = await api(`/transfer/progress/${requestId}`);
      if (!prog) return;

      const percent = prog.percent || 0;
      const transferred = prog.bytesTransferred || 0;
      const total = prog.fileSize || 0;

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

  div.innerHTML = `
    <div class="tf-header">
      <span class="tf-name">${fileEmoji} ${fileName}</span>
      <span class="tf-direction ${dirClass}">${dirLabel}</span>
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

  // Clean up completed/failed from activeTransfers after a delay
  if (data.status === 'completed' || data.status === 'failed' || data.status === 'rejected') {
    setTimeout(() => {
      activeTransfers.delete(requestId);
    }, 5000);
  }
}

// ===== Button Listeners =====
document.getElementById('btnAccept').addEventListener('click', acceptRequest);
document.getElementById('btnReject').addEventListener('click', rejectRequest);

// Hide modal on click outside
document.getElementById('requestModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideModal();
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
