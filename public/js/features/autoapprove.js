/**
 * Terima otomatis (auto-approve).
 *
 * Toggle di panel Sambung: kalau aktif, server perangkat ini menerima file
 * dari peer TANPA jendela terima/tolak.
 *
 * Logikanya ada di SERVER (`decideAutoAccept` di server/transfer.js), bukan
 * di sini — polling frontend berhenti saat tab disembunyikan, jadi mode ini
 * harus tetap jalan tanpa ada yang menatap layar. Frontend hanya mengubah
 * setting dan menampilkan statusnya.
 */

import { el, clear, maybeById } from '../core/dom.js';
import { getState, setState, subscribe } from '../core/state.js';
import { showToast } from './notify.js';
import { fetchAutoApprove, postAutoApprove } from '../core/api.js';

/** Sedang menyimpan? Cegah klik beruntun menumpuk request. */
/** Request simpan yang sedang berjalan, dan perubahan yang menunggu giliran. */
let inFlight = null;
let pendingPatch = null;
/** Tanda tangan render terakhir — hindari rebuild yang menghancurkan fokus. */
let renderedSignature = null;

/**
 * Ambil setting dari server lalu render.
 */
export async function loadAutoApprove() {
  try {
    setState({ autoApprove: await fetchAutoApprove() });
  } catch (_) {
    // Server tidak terjangkau — biarkan nilai lama.
  }
  renderAutoApprove();
}

/**
 * Simpan patch ke server, lalu sinkronkan state + UI.
 *
 * Perubahan yang datang saat request lain masih jalan DIGABUNG, bukan
 * dijatuhkan: user yang mencentang beberapa peer beruntun tidak boleh
 * kehilangan centang di tengah tanpa tahu apa-apa. Tiap request mengirim
 * daftar peer yang lengkap, jadi patch terakhir selalu menang.
 *
 * @param {{enabled?: boolean, peers?: string[]}} patch
 */
async function save(patch) {
  if (inFlight) {
    pendingPatch = { ...(pendingPatch || {}), ...patch };
    return inFlight;
  }

  inFlight = (async () => {
    let current = patch;
    try {
      while (current) {
        const sent = current;
        current = null;
        const settings = await postAutoApprove(sent);
        setState({ autoApprove: settings });
        renderAutoApprove();

        if (sent.enabled === true) {
          showToast('⚡ Terima otomatis aktif — file masuk tanpa konfirmasi', 'warning');
        } else if (sent.enabled === false) {
          showToast('Terima otomatis dimatikan', 'info');
        }

        // Ada perubahan menyusul sementara request ini jalan → kirim lagi.
        current = pendingPatch;
        pendingPatch = null;
        if (current) current = { ...sent, ...current };
      }
    } catch (err) {
      showToast(`Gagal menyimpan pengaturan: ${err.message}`, 'error');
      pendingPatch = null;
      // Server mungkin menolak — tarik ulang keadaan sebenarnya.
      await loadAutoApprove();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Nama perangkat yang tampil di daftar allowlist: peer yang sedang online,
 * plus peer yang sudah dicentang tapi sedang offline — supaya centangnya
 * masih bisa dicopot.
 * @returns {string[]}
 */
function candidatePeers() {
  const { devices, autoApprove } = getState();
  const names = new Set();

  for (const device of devices.values()) {
    const name = String(device.deviceName || '').trim();
    if (name) names.add(name);
  }
  for (const name of autoApprove.peers) names.add(name);

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Render badge header + isi panel terima otomatis.
 */
export function renderAutoApprove() {
  const { autoApprove } = getState();

  const badge = maybeById('autoApproveBadge');
  if (badge) badge.hidden = !autoApprove.enabled;

  const toggle = maybeById('autoApproveToggle');
  if (toggle) toggle.checked = autoApprove.enabled;

  const box = maybeById('autoApprovePeers');
  const list = maybeById('autoApprovePeerList');
  if (!box || !list) return;

  box.hidden = !autoApprove.enabled;
  if (!autoApprove.enabled) {
    renderedSignature = null;
    return;
  }

  // renderAutoApprove() dipanggil juga tiap polling perangkat (2,5 s). Kalau
  // daftar peer tidak berubah, JANGAN bangun ulang: membangun ulang menghapus
  // node yang sedang difokus/diklik, sehingga centang pertama bisa hilang di
  // tengah interaksi.
  const peers = candidatePeers();
  const signature = JSON.stringify([peers, autoApprove.peers]);
  if (signature === renderedSignature) return;
  renderedSignature = signature;

  clear(list);

  if (peers.length === 0) {
    list.appendChild(el('li', {
      class: 'auto-peer-empty',
      text: 'Belum ada perangkat lain yang terdeteksi.',
    }));
    return;
  }

  for (const name of peers) {
    const input = el('input', {
      type: 'checkbox',
      class: 'auto-peer-check',
      checked: autoApprove.peers.includes(name),
      onchange: (event) => {
        const next = new Set(getState().autoApprove.peers);
        if (event.currentTarget.checked) next.add(name);
        else next.delete(name);
        save({ peers: Array.from(next) });
      },
    });

    list.appendChild(el('li', {}, [
      el('label', { class: 'auto-peer-row' }, [input, el('span', { text: name })]),
    ]));
  }
}

/**
 * Setup toggle + subscriber. Dipanggil sekali saat init.
 */
export function setupAutoApprove() {
  const toggle = maybeById('autoApproveToggle');
  if (toggle) {
    toggle.addEventListener('change', (event) => {
      save({ enabled: event.currentTarget.checked });
    });
  }

  // Badge & daftar peer ikut berubah saat state berubah (mis. peer baru online).
  subscribe((_state, changed) => {
    if (changed.has('autoApprove') || changed.has('devices')) renderAutoApprove();
  });

  loadAutoApprove();
}
