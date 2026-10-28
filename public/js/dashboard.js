/**
 * Dashboard monitoring LAN DROP.
 *
 * Halaman ini layar PANTAU, bukan layar kirim: tidak ada pemilih file, tidak
 * ada tombol kirim. Isinya cuma yang tidak kelihatan di UI utama — kesehatan
 * discovery, alamat peer per jalur, ruang disk, commit yang jalan, dan log
 * server yang selama ini cuma lewat di stdout lalu hilang.
 *
 * Aturan yang dipegang sama seperti UI utama:
 *   - elemen dibuat lewat `el()`/`clear()` (core/dom.js), TIDAK ADA string HTML
 *     dari data server — nama file & nama peer itu input tak tepercaya;
 *   - semua angka lewat core/format.js (gaya Indonesia: "12,4 MB", "8 dtk");
 *   - polling berhenti saat tab disembunyikan (dashboard bisa dibiarkan
 *     terbuka di jendela kedua sepanjang hari).
 */
import { api, postJson } from './core/api.js';
import { el, clear, byId } from './core/dom.js';
import { formatBytes, formatDuration, formatDateTime, formatTime } from './core/format.js';

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

// Interval per kartu — bukan satu interval untuk semua: peer & transfer harus
// cepat (itu yang bikin bingung kalau telat), disk & setting cukup jarang.
const POLL_MS = {
  status: 10000,
  discovery: 5000,
  disk: 15000,
  auto: 15000,
  peers: 2500,
  active: 2000,
  history: 5000,
  log: 2000,
};

const STATUS_LABEL = {
  pending: 'Menunggu konfirmasi',
  accepted: 'Diterima',
  transferring: 'Sedang jalan',
  completed: 'Berhasil',
  unconfirmed: 'Belum dikonfirmasi',
  disconnected: 'Terputus',
  failed: 'Gagal',
  rejected: 'Ditolak',
  cancelled: 'Dibatalkan',
};

const STATUS_STATE = {
  completed: 'ok',
  transferring: 'ok',
  accepted: 'ok',
  pending: 'warn',
  unconfirmed: 'warn',
  disconnected: 'warn',
  failed: 'err',
  rejected: 'err',
  cancelled: 'err',
};

// Jalur peer di URL: `?via=lan|tailscale`. Tanpa ini server pakai LAN.
const VIA = new URLSearchParams(window.location.search).get('via') || undefined;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const timers = {};
const busy = new Set();

let logLines = []; // seluruh baris yang kita punya (maks 300 dari server)
let lastLogId = 0; // id terakhir — dipakai `?since=` supaya polling ringan
let historyRows = [];
let errorShown = false;

const $ = {
  device: byId('dashDevice'),
  uptime: byId('dashUptime'),
  clock: byId('dashClock'),
  error: byId('dashError'),
  statusKv: byId('statusKv'),
  discReady: byId('discReady'),
  discBody: byId('discBody'),
  discKv: byId('discKv'),
  diskValue: byId('diskValue'),
  diskBar: byId('diskBar'),
  diskBarFill: byId('diskBarFill'),
  diskKv: byId('diskKv'),
  autoToggle: byId('autoToggle'),
  autoPeers: byId('autoPeers'),
  autoSave: byId('autoSave'),
  autoInfo: byId('autoInfo'),
  peerCount: byId('peerCount'),
  peerBody: byId('peerBody'),
  activeCount: byId('activeCount'),
  activeBody: byId('activeBody'),
  histFilter: byId('histFilter'),
  histCount: byId('histCount'),
  histClear: byId('histClear'),
  histBody: byId('histBody'),
  gallery: byId('gallery'),
  galleryEmpty: byId('galleryEmpty'),
  logCount: byId('logCount'),
  logFollow: byId('logFollow'),
  logErrorsOnly: byId('logErrorsOnly'),
  logCopy: byId('logCopy'),
  logPane: byId('logPane'),
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Nilai tampil untuk data yang belum ada. */
const dash = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));

/** Umur waktu yang manusiawi: "3 dtk lalu", "2 mnt 5 dtk lalu". */
function ago(ts) {
  if (!ts) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'baru saja';
  if (seconds < 60) return `${seconds} dtk lalu`;
  return `${formatDuration(seconds)} lalu`;
}

/** Tag status berwarna (lihat .dash-tag[data-state] di dashboard.css). */
function statusTag(status) {
  return el('span', {
    class: 'dash-tag',
    dataset: { state: STATUS_STATE[status] || '' },
    text: STATUS_LABEL[status] || dash(status),
  });
}

/** Baris tabel dari daftar sel (string atau Node). */
function row(cells) {
  return el('tr', {}, cells.map((cell) => el('td', {}, cell)));
}

/** Kelompokkan node ke satu DocumentFragment supaya DOM cuma di-update sekali. */
function group(nodes) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) frag.appendChild(node);
  return frag;
}

/** Isi tabel; kalau kosong, satu baris "kosong" yang melebar sejumlah kolom. */
function fillTable(tbody, columns, rows, emptyText) {
  clear(tbody);
  if (rows.length === 0) {
    tbody.appendChild(
      el('tr', {}, el('td', { class: 'dash-empty', colspan: String(columns), text: emptyText }))
    );
    return;
  }
  tbody.appendChild(group(rows));
}

/** Isi <dl> dari pasangan [label, nilai]. */
function fillKv(dl, pairs) {
  clear(dl);
  dl.appendChild(group(pairs.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', {}, value)])));
}

/**
 * Bungkus satu siklus refresh: kalau gagal, tampilkan banner — tapi jangan
 * bikin seluruh dashboard berhenti. Satu kartu rusak, kartu lain tetap jalan.
 */
function guard(key, fn) {
  if (busy.has(key)) return;
  busy.add(key);
  Promise.resolve()
    .then(fn)
    .then(() => {
      if (errorShown) {
        errorShown = false;
        $.error.hidden = true;
        $.error.textContent = '';
      }
    })
    .catch((err) => {
      if (errorShown) return;
      errorShown = true;
      $.error.hidden = false;
      $.error.textContent = `Gagal memperbarui ${key}: ${err.message}`;
    })
    .finally(() => busy.delete(key));
}

// ---------------------------------------------------------------------------
// 1. Status server
// ---------------------------------------------------------------------------

async function refreshStatus() {
  const s = await api('/status');

  $.device.textContent = s.deviceName || '—';
  $.uptime.textContent = `up ${formatDuration(s.uptimeSeconds)}`;

  fillKv($.statusKv, [
    ['Perangkat', dash(s.deviceName)],
    ['Versi', dash(s.version)],
    ['Commit', el('span', { class: 'dash-mono', text: dash(s.commit) })],
    ['Proses', `pid ${dash(s.pid)}`],
    ['Node', el('span', { class: 'dash-mono', text: dash(s.node) })],
    ['Platform', dash(s.platform)],
    ['Uptime', `${formatDuration(s.uptimeSeconds)} (sejak ${formatDateTime(s.startedAt)})`],
    ['Port HTTP', dash(s.port)],
    ['Port transfer', dash(s.transferPort)],
    ['Port discovery', dash(s.discoveryPort)],
    ['Folder simpan', el('span', { class: 'dash-mono', text: dash(s.saveDir) })],
    ['Folder data', el('span', { class: 'dash-mono', text: dash(s.dataDir) })],
  ]);
}

// ---------------------------------------------------------------------------
// 2. Kesehatan discovery
// ---------------------------------------------------------------------------

async function refreshDiscovery() {
  const d = await api('/discovery/status');

  $.discReady.textContent = d.ready ? 'Siap' : 'Bermasalah';
  $.discReady.dataset.state = d.ready ? 'ok' : 'err';

  const rows = (d.interfaces || []).map((iface) =>
    row([
      el('span', { class: 'dash-mono', text: dash(iface.address) }),
      el('span', { class: 'dash-mono', text: dash(iface.broadcast) }),
      iface.bound ? 'ya' : 'tidak',
      iface.lastSentAt ? ago(iface.lastSentAt) : 'belum pernah',
      iface.lastError
        ? el('span', { class: 'dash-tag', dataset: { state: 'err' }, text: iface.lastError })
        : '—',
    ])
  );
  fillTable($.discBody, 5, rows, 'Tidak ada interface LAN yang bisa dipakai broadcast.');

  const listener = d.listener || {};
  const peers = d.peers || {};
  const ts = d.tailscale || {};

  fillKv($.discKv, [
    ['Listener', `port ${dash(listener.port)} — ${listener.bound ? 'terikat' : 'TIDAK terikat'}`],
    ['Error listener', listener.error ? el('span', { class: 'dash-tag', dataset: { state: 'err' }, text: listener.error }) : '—'],
    ['Peer dikenal', `${dash(peers.count)} — announce terakhir ${peers.lastAnnounceAt ? ago(peers.lastAnnounceAt) : 'belum ada'}`],
    ['Tailscale', ts.selfIp ? `ip ${ts.selfIp}` : 'tidak aktif'],
    ['Tailscale CLI', ts.cliFound ? 'ada' : 'tidak ada (normal di HP)'],
    ['Peer tailnet', dash(ts.peerCount)],
  ]);
}

// ---------------------------------------------------------------------------
// 3. Ruang disk
// ---------------------------------------------------------------------------

async function refreshDisk() {
  let data;
  try {
    data = await api('/system/disk');
  } catch (err) {
    // 501 = server tidak bisa mengukur (filesystem virtual). Itu jawaban, bukan
    // kegagalan: tampilkan apa adanya, jangan bikin banner merah.
    $.diskValue.textContent = 'tidak terukur';
    fillKv($.diskKv, [['Keterangan', err.message]]);
    $.diskBar.hidden = true;
    return;
  }

  $.diskValue.textContent = `${formatBytes(data.free)} bebas`;

  if (data.total) {
    const usedPercent = Math.min(100, Math.round((1 - data.free / data.total) * 100));
    $.diskBar.hidden = false;
    $.diskBarFill.style.setProperty('width', `${usedPercent}%`);
    fillKv($.diskKv, [
      ['Kapasitas', formatBytes(data.total)],
      ['Terpakai', `${usedPercent}%`],
      ['Folder', el('span', { class: 'dash-mono', text: dash(data.path) })],
    ]);
  } else {
    // Kapasitas drive tidak selalu bisa dibaca (mis. share jaringan).
    $.diskBar.hidden = true;
    fillKv($.diskKv, [
      ['Kapasitas', 'tidak tersedia'],
      ['Folder', el('span', { class: 'dash-mono', text: dash(data.path) })],
    ]);
  }
}

// ---------------------------------------------------------------------------
// 4. Terima otomatis
// ---------------------------------------------------------------------------

// Sedang ada perubahan yang belum disimpan user? Kalau ya, polling berikutnya
// tidak boleh menimpa ketikan user di kolom peer.
let autoDirty = false;

async function refreshAuto() {
  const s = await api('/settings/auto-approve');
  if (autoDirty) return;

  $.autoToggle.checked = !!s.enabled;
  $.autoPeers.value = (s.peers || []).join(', ');
  $.autoInfo.textContent = s.enabled
    ? `Aktif — ${s.peers.length ? `hanya dari: ${s.peers.join(', ')}` : 'semua peer'}`
    : 'Mati — file masuk selalu minta konfirmasi';
}

async function saveAuto() {
  $.autoSave.disabled = true;
  try {
    const peers = $.autoPeers.value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const saved = await postJson('/settings/auto-approve', {
      enabled: $.autoToggle.checked,
      peers,
    });

    autoDirty = false;
    $.autoInfo.textContent = saved.enabled
      ? `Tersimpan ${formatTime(Date.now())} — aktif untuk ${saved.peers.length ? saved.peers.join(', ') : 'semua peer'}`
      : `Tersimpan ${formatTime(Date.now())} — terima otomatis mati`;
  } finally {
    $.autoSave.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 5. Perangkat online
// ---------------------------------------------------------------------------

async function refreshPeers() {
  const devices = await api(VIA ? `/devices?via=${encodeURIComponent(VIA)}` : '/devices');

  $.peerCount.textContent = String(devices.length);

  const rows = devices.map((peer) =>
    row([
      dash(peer.deviceName),
      el('span', { class: 'dash-mono', text: dash(peer.ip) }),
      peer.via === 'tailscale' ? '🔒 Tailscale' : '📶 LAN',
      dash(peer.port),
      dash(peer.transferPort),
      ago(peer.lastSeen),
    ])
  );
  fillTable($.peerBody, 6, rows, 'Belum ada perangkat lain yang terlihat.');
}

// ---------------------------------------------------------------------------
// 6. Transfer aktif
// ---------------------------------------------------------------------------

async function refreshActive() {
  const transfers = await api('/transfer/active');

  $.activeCount.textContent = String(transfers.length);

  const rows = transfers.map((t) => {
    const percent = Number(t.percent) || 0;
    const progress = el('div', { class: 'dash-progress' }, [
      el('div', { class: 'dash-progress-track' }, [
        el('span', { class: 'dash-progress-fill', style: { width: `${percent}%` } }),
      ]),
      el('span', { class: 'dash-mono', text: `${percent}%` }),
    ]);

    const cancel = el('button', {
      class: 'dash-btn dash-btn-danger',
      type: 'button',
      text: 'Batal',
      title: 'Batalkan transfer ini',
      onclick: () => cancelTransfer(t.requestId, t.direction === 'receive' ? 'receive' : 'send', cancel),
    });

    return row([
      t.direction === 'receive' ? '⬇️ Terima' : '⬆️ Kirim',
      el('div', { class: 'dash-file', text: dash(t.fileName), title: dash(t.fileName) }),
      formatBytes(t.fileSize),
      dash(t.peer),
      statusTag(t.status),
      t.bytesTransferred ? progress : el('span', { class: 'dash-mono', text: dash(t.status) }),
      cancel,
    ]);
  });
  fillTable($.activeBody, 7, rows, 'Tidak ada transfer yang sedang berjalan.');
}

async function cancelTransfer(requestId, role, button) {
  button.disabled = true;
  try {
    await postJson(`/transfer/cancel/${encodeURIComponent(requestId)}`, { role });
    await refreshActive();
  } catch (err) {
    button.disabled = false;
    $.error.hidden = false;
    $.error.textContent = `Gagal membatalkan transfer: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// 7. Riwayat + galeri
// ---------------------------------------------------------------------------

function matchesHistoryFilter(entry, filter) {
  if (filter === 'all') return true;
  if (filter === 'send' || filter === 'receive') return entry.direction === filter;
  return entry.status === filter;
}

function renderHistory() {
  const filter = $.histFilter.value;
  const visible = historyRows.filter((entry) => matchesHistoryFilter(entry, filter));

  $.histCount.textContent = `${visible.length}/${historyRows.length}`;

  const rows = visible.map((entry) =>
    row([
      formatDateTime(entry.ts),
      entry.direction === 'receive' ? '⬇️ Terima' : '⬆️ Kirim',
      statusTag(entry.status),
      el('div', { class: 'dash-file', text: dash(entry.fileName), title: dash(entry.fileName) }),
      entry.fileSize ? formatBytes(entry.fileSize) : '—',
      dash(entry.peer),
      entry.savedTo
        ? el('span', { class: 'dash-mono', text: entry.savedTo })
        : entry.reason || '—',
    ])
  );
  fillTable($.histBody, 7, rows, 'Belum ada riwayat yang cocok dengan filter ini.');

  renderGallery();
}

function renderGallery() {
  // Thumbnail cuma ada untuk file gambar/video yang diterima — itu saja yang
  // bisa ditampilkan. Ambil 12 terbaru.
  const withThumbs = historyRows.filter((entry) => entry.thumbnailId).slice(0, 12);

  clear($.gallery);
  $.galleryEmpty.hidden = withThumbs.length > 0;

  $.gallery.appendChild(
    group(
      withThumbs.map((entry) =>
        el('figure', { class: 'dash-thumb', title: dash(entry.fileName) }, [
          // src dibuat dari id heksadesimal yang dipetakan server — bukan path.
          el('img', { src: `/thumbnail/${entry.thumbnailId}`, alt: dash(entry.fileName), loading: 'lazy' }),
          el('figcaption', { class: 'dash-thumb-caption', text: dash(entry.fileName) }),
        ])
      )
    )
  );
}

async function refreshHistory() {
  historyRows = await api('/history');
  renderHistory();
}

async function clearHistory() {
  if (!window.confirm('Hapus seluruh riwayat transfer? Tindakan ini tidak bisa dibatalkan.')) return;
  $.histClear.disabled = true;
  try {
    await postJson('/history/clear', {});
    historyRows = [];
    renderHistory();
  } finally {
    $.histClear.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 8. Log server
// ---------------------------------------------------------------------------

function visibleLogLines() {
  return $.logErrorsOnly.checked ? logLines.filter((line) => line.level === 'error') : logLines;
}

function renderLog() {
  const lines = visibleLogLines();
  clear($.logPane);

  const frag = document.createDocumentFragment();
  for (const line of lines) {
    frag.appendChild(
      el('div', { class: 'dash-log-line', dataset: { level: line.level } }, [
        el('span', { class: 'dash-log-time', text: `${formatTime(line.ts)}  ` }),
        line.text,
      ])
    );
  }
  $.logPane.appendChild(frag);

  $.logCount.textContent = String(lines.length);
  if ($.logFollow.checked) $.logPane.scrollTop = $.logPane.scrollHeight;
}

async function refreshLog() {
  const data = await api(`/logs?since=${lastLogId}`);

  // Server baru restart: id-nya balik ke 1, sedangkan kita masih menyimpan id
  // lama yang lebih besar — kalau tidak direset, log tidak akan pernah muncul.
  if (data.lastId < lastLogId) {
    logLines = [];
    lastLogId = 0;
  }

  if (data.lines.length) {
    logLines = logLines.concat(data.lines).slice(-data.depth);
    lastLogId = data.lastId;
  }
  renderLog();
}

/** Salin log yang terlihat ke clipboard (dengan fallback untuk HTTP di LAN). */
async function copyLog() {
  const text = visibleLogLines().map((line) => `${formatTime(line.ts)}  ${line.text}`).join('\n');

  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // navigator.clipboard cuma ada di secure context (HTTPS/localhost). Di LAN
    // lewat HTTP, satu-satunya jalan: pilih isinya lalu execCommand.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($.logPane);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }

  $.logCopy.textContent = 'Tersalin';
  setTimeout(() => {
    $.logCopy.textContent = 'Salin log';
  }, 1500);
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Jadwalkan satu kartu: jalan langsung, lalu berkala saat tab terlihat. */
function schedule(key, fn) {
  guard(key, fn);
  timers[key] = setInterval(() => {
    if (document.hidden) return;
    guard(key, fn);
  }, POLL_MS[key]);
}

function startPolling() {
  schedule('status', refreshStatus);
  schedule('discovery', refreshDiscovery);
  schedule('disk', refreshDisk);
  schedule('auto', refreshAuto);
  schedule('peers', refreshPeers);
  schedule('active', refreshActive);
  schedule('history', refreshHistory);
  schedule('log', refreshLog);
}

function stopPolling() {
  for (const timer of Object.values(timers)) clearInterval(timer);
}

/** Jam server diperbarui — dipakai buat lihat sendiri "dashboard ini hidup". */
function tickClock() {
  $.clock.textContent = formatTime(Date.now());
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

byId('dashReload').addEventListener('click', () => {
  // Muat ulang = mulai dari nol lagi, termasuk log (id direset supaya 300 baris
  // terakhir ikut tampil walau sebelumnya sempat bolong).
  logLines = [];
  lastLogId = 0;
  errorShown = false;
  $.error.hidden = true;

  stopPolling(); // tanpa ini tiap klik menambah satu set interval baru
  startPolling();
});

$.histFilter.addEventListener('change', renderHistory);
$.histClear.addEventListener('click', () => {
  clearHistory().catch((err) => {
    $.error.hidden = false;
    $.error.textContent = `Gagal menghapus riwayat: ${err.message}`;
  });
});

$.logFollow.addEventListener('change', () => {
  if ($.logFollow.checked) renderLog();
});
$.logErrorsOnly.addEventListener('change', renderLog);
$.logCopy.addEventListener('click', () => {
  copyLog().catch(() => {});
});

$.autoToggle.addEventListener('change', () => {
  autoDirty = true;
});
$.autoPeers.addEventListener('input', () => {
  autoDirty = true;
});
$.autoSave.addEventListener('click', () => {
  saveAuto().catch((err) => {
    $.autoInfo.textContent = `Gagal menyimpan: ${err.message}`;
  });
});

// Tab disembunyikan → berhenti polling (dashboard dibiarkan terbuka seharian).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else startPolling();
});

// ---------------------------------------------------------------------------
// Mulai
// ---------------------------------------------------------------------------

startPolling();
tickClock();
setInterval(tickClock, 1000);

document.title = 'LAN DROP — Dashboard';
