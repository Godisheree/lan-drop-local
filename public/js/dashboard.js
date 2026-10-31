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
import { formatBytes, formatDuration, formatDateTime, formatTime, formatSpeed } from './core/format.js';

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
  active: 1000, // kartu progres: di atas 1 dtk kelihatan seperti gambar mati
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
let logPrimed = false; // log lama (300 baris pertama) jangan dianggap "error baru"
let lastSeenErrorId = 0;
let unseenErrors = 0; // error yang belum dibaca user — angka ini muncul di judul tab
let historyRows = [];
let errorShown = false;

// Jawaban /status terakhir. Uptime tidak ditampilkan apa adanya: yang disimpan
// adalah "uptime saat jawaban itu tiba" + kapan tiba, lalu detiknya ditambah
// sendiri tiap detik oleh browser. Tanpa ini angkanya beku sampai polling
// berikutnya (10 dtk) — di HP kelihatan seperti macet.
let serverStatus = null;

const uptimeDd = el('dd'); // node tetap yang ditulis ulang tiap detik (lihat paintUptime)
const transferSnapshots = new Map(); // requestId → { bytes, at } buat hitung kecepatan
const openDetails = new Set(); // baris riwayat yang sedang dibuka (bertahan walau refresh)

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
  pinStatus: byId('pinStatus'),
  pinStatusText: byId('pinStatusText'),
  pinInfo: byId('pinInfo'),
  pinNew: byId('pinNew'),
  pinSave: byId('pinSave'),
  pinLogout: byId('pinLogout'),
  pinMsg: byId('pinMsg'),
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
  toasts: byId('dashToasts'),
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Nilai tampil untuk data yang belum ada. */
const dash = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));

/** Umur waktu yang manusiawi: "3 dtk lalu", "2 mnt 5 dtk lalu". */
function agoText(ts) {
  if (!ts) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'baru saja';
  if (seconds < 60) return `${seconds} dtk lalu`;
  return `${formatDuration(seconds)} lalu`;
}

/**
 * Umur waktu sebagai ELEMEN, bukan string: `data-ts` disimpan supaya bisa
 * dihitung ulang tiap detik tanpa memanggil server. Dulu "terakhir terlihat"
 * beku di angka lama sampai polling kartu itu berikutnya (5 dtk) — persis
 * keluhan "harus refresh dulu baru update".
 */
function ago(ts) {
  return el('span', { class: 'dash-ago', dataset: { ts: ts ? String(ts) : '' }, text: agoText(ts) });
}

/** Segarkan semua label umur waktu (dipanggil tiap detik). */
function tickAges() {
  for (const node of document.querySelectorAll('.dash-ago')) {
    const ts = Number(node.dataset.ts);
    if (!ts) continue;
    const text = agoText(ts);
    if (node.textContent !== text) node.textContent = text;
  }
}

/** Jam dengan detik — biar kelihatan halamannya hidup, bukan tangkapan layar. */
function clockWithSeconds(ts) {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Uptime berjalan: angka server + selisih waktu sejak jawaban itu tiba. */
function liveUptime() {
  if (!serverStatus) return null;
  return serverStatus.seconds + (Date.now() - serverStatus.at) / 1000;
}

/** Pesan singkat yang muncul lalu hilang sendiri — umpan balik aksi user. */
function toast(message, level = 'ok') {
  const node = el('div', { class: 'dash-toast', dataset: { level }, role: 'status', text: message });
  $.toasts.appendChild(node);
  setTimeout(() => node.remove(), level === 'err' ? 6000 : 3000);
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

  serverStatus = { seconds: Number(s.uptimeSeconds) || 0, at: Date.now(), startedAt: s.startedAt };
  $.device.textContent = s.deviceName || '—';
  paintUptime();

  fillKv($.statusKv, [
    ['Perangkat', dash(s.deviceName)],
    ['Versi', dash(s.version)],
    ['Commit', el('span', { class: 'dash-mono', text: dash(s.commit) })],
    ['Proses', `pid ${dash(s.pid)}`],
    ['Node', el('span', { class: 'dash-mono', text: dash(s.node) })],
    ['Platform', dash(s.platform)],
    ['Uptime', uptimeDd],
    ['Port HTTP', dash(s.port)],
    ['Port transfer', dash(s.transferPort)],
    ['Port discovery', dash(s.discoveryPort)],
    ['Folder simpan', el('span', { class: 'dash-mono', text: dash(s.saveDir) })],
    ['Folder data', el('span', { class: 'dash-mono', text: dash(s.dataDir) })],
  ]);
}

/** Tulis uptime ke pil header + baris tabel. Dipanggil tiap detik, bukan tiap polling. */
function paintUptime() {
  const seconds = liveUptime();
  if (seconds === null) return;

  const text = formatDuration(seconds);
  const pill = `up ${text}`;
  if ($.uptime.textContent !== pill) $.uptime.textContent = pill;

  const detail = `${text} (sejak ${formatDateTime(serverStatus.startedAt)})`;
  if (uptimeDd.textContent !== detail) uptimeDd.textContent = detail;
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
    toast(saved.enabled ? 'Terima otomatis: aktif' : 'Terima otomatis: mati');
    $.autoInfo.textContent = saved.enabled
      ? `Tersimpan ${formatTime(Date.now())} — aktif untuk ${saved.peers.length ? saved.peers.join(', ') : 'semua peer'}`
      : `Tersimpan ${formatTime(Date.now())} — terima otomatis mati`;
  } finally {
    $.autoSave.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 4b. PIN dashboard
// ---------------------------------------------------------------------------

// Status diambil sekali saat halaman dibuka, bukan lewat polling: PIN cuma
// berubah kalau user di halaman ini sendiri yang menggantinya. Kartu ini juga
// bukan data yang perlu "segar" — nilai basi di sini tidak menyesatkan.
async function refreshPin() {
  const info = await api('/dashboard/pin-info');

  $.pinStatus.dataset.state = info.default ? 'warn' : 'ok';
  $.pinStatusText.textContent = info.default ? 'Masih PIN bawaan' : 'Sudah diganti';
  $.pinInfo.textContent = info.default
    ? 'PIN masih bawaan (123456). Siapa pun di Wi-Fi yang sama bisa membuka dashboard ini — sebaiknya segera diganti.'
    : 'PIN bawaan sudah tidak dipakai. Angka PIN tidak ditampilkan di sini.';
}

/** PIN valid menurut aturan server: 4-8 angka. */
const pinValid = (value) => /^\d{4,8}$/.test(value);

function syncPinButton() {
  $.pinSave.disabled = !pinValid($.pinNew.value);
}

async function savePin() {
  const pin = $.pinNew.value;
  if (!pinValid(pin)) return;

  $.pinSave.disabled = true;
  $.pinMsg.textContent = 'Menyimpan…';

  try {
    await postJson('/dashboard/pin', { pin });

    // Server mencabut SEMUA sesi, termasuk yang barusan dipakai mengganti —
    // jadi halaman ini sudah tidak punya izin apa pun lagi. Diberi jeda 1,5 dtk
    // supaya pesannya sempat terbaca sebelum halaman login muncul.
    $.pinMsg.textContent = 'PIN diganti. Semua browser harus masuk ulang.';
    $.pinNew.value = '';
    setTimeout(() => {
      window.location.href = '/dashboard';
    }, 1500);
  } catch (err) {
    $.pinMsg.textContent = `Gagal mengganti PIN: ${err.message}`;
    $.pinSave.disabled = false;
  }
}

async function logout() {
  $.pinLogout.disabled = true;
  try {
    await postJson('/dashboard/logout', {});
  } catch (_) {
    // Sesi dicabut server lewat cookie; kalau pun balasannya gagal terbaca,
    // muat ulang tetap membawa user ke halaman login.
  }
  window.location.href = '/dashboard';
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

/**
 * Kecepatan & sisa waktu dari selisih dua polling. Server cuma memberi
 * `bytesTransferred` (angka keras), jadi kecepatannya dihitung di sini — tanpa
 * ini kartu cuma bilang "45%", dan "45%"-nya diam 2 menit tidak bisa dibedakan
 * antara lambat atau macet.
 */
function measure(t) {
  const now = Date.now();
  const bytes = Number(t.bytesTransferred) || 0;
  const prev = transferSnapshots.get(t.requestId);
  transferSnapshots.set(t.requestId, { bytes, at: now });

  if (!prev || bytes <= prev.bytes || now <= prev.at) return { speed: 0, eta: 0 };

  const speed = ((bytes - prev.bytes) / (now - prev.at)) * 1000;
  const remaining = Math.max(0, (Number(t.fileSize) || 0) - bytes);
  return { speed, eta: speed > 0 ? remaining / speed : 0 };
}

async function refreshActive() {
  const transfers = await api('/transfer/active');

  $.activeCount.textContent = String(transfers.length);

  // Snapshot transfer yang sudah tidak ada dibuang — kalau tidak, peta ini
  // tumbuh terus sepanjang umur halaman.
  const alive = new Set(transfers.map((t) => t.requestId));
  for (const id of transferSnapshots.keys()) if (!alive.has(id)) transferSnapshots.delete(id);

  const rows = transfers.map((t) => {
    const percent = Number(t.percent) || 0;
    const { speed, eta } = measure(t);

    const progress = el('div', { class: 'dash-progress' }, [
      el('div', { class: 'dash-progress-track' }, [
        el('span', { class: 'dash-progress-fill', style: { width: `${percent}%` } }),
      ]),
      el('span', { class: 'dash-mono', text: `${percent}%` }),
    ]);

    if (speed > 0) {
      progress.appendChild(
        el('span', { class: 'dash-mono dash-speed', text: `${formatSpeed(speed)} • sisa ${formatDuration(eta)}` })
      );
    }

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
    toast(role === 'receive' ? 'Transfer masuk dibatalkan' : 'Transfer dibatalkan');
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

  const rows = [];
  for (const entry of visible) {
    // Kunci stabil supaya baris yang sedang dibuka tetap terbuka setelah
    // polling riwayat berikutnya (kartu ini di-refresh tiap 5 dtk).
    const key = `${entry.ts}-${entry.fileName}-${entry.direction}`;
    const isOpen = openDetails.has(key);

    const main = row([
      formatDateTime(entry.ts),
      entry.direction === 'receive' ? '⬇️ Terima' : '⬆️ Kirim',
      statusTag(entry.status),
      el('div', { class: 'dash-file', text: dash(entry.fileName), title: dash(entry.fileName) }),
      entry.fileSize ? formatBytes(entry.fileSize) : '—',
      dash(entry.peer),
      entry.savedTo
        ? el('span', { class: 'dash-mono', text: entry.savedTo })
        : entry.reason || '—',
    ]);
    main.classList.add('dash-row-click');
    main.tabIndex = 0;
    main.setAttribute('aria-expanded', String(isOpen));

    // Tabel 7 kolom tidak kebaca di HP: satu klik buka rinciannya di bawah
    // baris, bukan tooltip atau halaman baru.
    const detail = el('tr', { class: 'dash-detail', hidden: !isOpen }, [
      el('td', { colspan: '7' }, [
        el('dl', { class: 'dash-kv' }, [
          el('dt', { text: 'Waktu' }),
          el('dd', { text: formatDateTime(entry.ts) }),
          el('dt', { text: 'Arah' }),
          el('dd', { text: entry.direction === 'receive' ? 'Terima' : 'Kirim' }),
          el('dt', { text: 'Status' }),
          el('dd', {}, [
            statusTag(entry.status),
            entry.reason ? el('span', { class: 'dash-detail-reason', text: entry.reason }) : null,
          ]),
          el('dt', { text: 'File' }),
          el('dd', { class: 'dash-mono', text: dash(entry.fileName) }),
          el('dt', { text: 'Ukuran' }),
          el('dd', { text: entry.fileSize ? formatBytes(entry.fileSize) : '—' }),
          el('dt', { text: 'Peer' }),
          el('dd', { text: dash(entry.peer) }),
          el('dt', { text: 'Tersimpan di' }),
          el('dd', { class: 'dash-mono', text: dash(entry.savedTo) }),
        ]),
      ]),
    ]);

    const toggle = () => {
      const nowOpen = detail.hidden;
      detail.hidden = !nowOpen;
      main.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) openDetails.add(key);
      else openDetails.delete(key);
    };

    main.addEventListener('click', toggle);
    main.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });

    rows.push(main, detail);
  }

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
    toast('Riwayat dihapus');
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

  if (logPrimed) {
    notifyNewErrors();
  } else {
    // Muat pertama: 300 baris lama itu sejarah, bukan "error baru" — jangan
    // memunculkan 100 pesan sekaligus.
    logPrimed = true;
    lastSeenErrorId = data.lastId;
  }

  renderLog();
}

/**
 * Error baru = hal yang paling dicari orang, tapi kartunya paling bawah.
 * Jadi: pesan singkat + angka di judul tab, sekali per baris.
 */
function notifyNewErrors() {
  let notified = 0;

  for (const line of logLines) {
    if (line.id <= lastSeenErrorId) continue;
    lastSeenErrorId = line.id;
    if (line.level !== 'error') continue;
    notified += 1;
    unseenErrors += 1;
    toast(`Error baru: ${line.text.slice(0, 90)}`, 'err');
  }

  if (notified) paintErrorBadge();
}

function paintErrorBadge() {
  const title = unseenErrors ? `(${unseenErrors}) LAN DROP — Dashboard` : 'LAN DROP — Dashboard';
  if (document.title !== title) document.title = title;

  $.logCount.dataset.state = unseenErrors ? 'err' : '';
  $.logCount.title = unseenErrors ? `${unseenErrors} error belum dibaca` : '';
}

/** User sudah lihat lognya — angka di judul tab tidak perlu lagi. */
function markErrorsRead() {
  if (!unseenErrors) return;
  unseenErrors = 0;
  paintErrorBadge();
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
  toast('Log disalin ke clipboard');
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
function tick() {
  $.clock.textContent = clockWithSeconds(Date.now());
  paintUptime();
  tickAges();
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

byId('dashReload').addEventListener('click', () => {
  // Muat ulang = mulai dari nol lagi, termasuk log (id direset supaya 300 baris
  // terakhir ikut tampil walau sebelumnya sempat bolong).
  logLines = [];
  lastLogId = 0;
  logPrimed = false; // log yang diambil ulang = sejarah, bukan "error baru"
  lastSeenErrorId = 0;
  unseenErrors = 0;
  paintErrorBadge();
  transferSnapshots.clear(); // angka kecepatan lama jangan dihitung ulang
  errorShown = false;
  $.error.hidden = true;

  stopPolling(); // tanpa ini tiap klik menambah satu set interval baru
  startPolling();
  tick();
  toast('Data dimuat ulang dari server');
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
$.logErrorsOnly.addEventListener('change', () => {
  if ($.logErrorsOnly.checked) markErrorsRead();
  renderLog();
});
// Menyentuh lognya = sudah dibaca. Angka merah di judul tab ikut hilang.
$.logPane.addEventListener('click', markErrorsRead);
$.logPane.addEventListener('focus', markErrorsRead);
$.logCount.addEventListener('click', markErrorsRead);
$.logCopy.addEventListener('click', () => {
  copyLog().catch(() => {});
});

$.pinNew.addEventListener('input', () => {
  // PIN cuma angka: buang karakter lain di sini supaya user tidak menekan
  // "Ganti PIN" lalu ditolak server tanpa tahu kenapa.
  const digits = $.pinNew.value.replace(/\D/g, '').slice(0, 8);
  if (digits !== $.pinNew.value) $.pinNew.value = digits;
  syncPinButton();
});
$.pinSave.addEventListener('click', () => {
  savePin().catch((err) => {
    $.pinMsg.textContent = `Gagal mengganti PIN: ${err.message}`;
    $.pinSave.disabled = false;
  });
});
$.pinLogout.addEventListener('click', () => {
  logout().catch(() => {});
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
  else {
    startPolling();
    tick(); // jam, uptime, dan umur waktu jangan ketinggalan selama tab disembunyikan
  }
});

// ---------------------------------------------------------------------------
// Mulai
// ---------------------------------------------------------------------------

// Pintasan keyboard: dipakai sambil kerja, jangan sampai harus membidik tombol
// kecil di layar.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const tag = event.target instanceof HTMLElement ? event.target.tagName : '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const key = event.key.toLowerCase();
  if (key === 'r') {
    byId('dashReload').click();
  } else if (key === 'e') {
    $.logErrorsOnly.checked = !$.logErrorsOnly.checked;
    if ($.logErrorsOnly.checked) markErrorsRead();
    renderLog();
    toast($.logErrorsOnly.checked ? 'Log: error saja' : 'Log: semua baris');
  } else if (key === 'f') {
    $.logFollow.checked = !$.logFollow.checked;
    renderLog();
    toast($.logFollow.checked ? 'Log: ikut otomatis' : 'Log: berhenti mengikuti');
  } else if (key === 'c') {
    copyLog().catch(() => {});
  }
});

startPolling();
// Status PIN diambil sekali saja (bukan lewat schedule): nilainya cuma berubah
// kalau user di halaman ini sendiri yang menggantinya.
guard('pin', refreshPin);
syncPinButton();
tick();
setInterval(tick, 1000);

paintErrorBadge();
