/**
 * Badge "terima otomatis" di UI kirim file.
 *
 * Toggle-nya PINDAH ke Dashboard (perlu PIN). Mode ini menerima file tanpa
 * jendela terima/tolak, jadi menyalakannya tidak boleh dari halaman yang
 * terbuka untuk siapa saja di Wi-Fi — sebelumnya siapa pun cukup
 * `curl -X POST /settings/auto-approve` buat mengaktifkannya.
 *
 * Yang tersisa di sini cuma badge pengingat: user harus sadar perangkatnya
 * sedang jadi "drop box". Server hanya mengirim daftar `peers` ke pemanggil
 * ber-sesi, jadi halaman ini tidak pernah menerimanya.
 *
 * Logikanya ada di SERVER (`decideAutoAccept` di server/transfer.js), bukan
 * di sini — polling frontend berhenti saat tab disembunyikan, jadi mode ini
 * harus tetap jalan tanpa ada yang menatap layar.
 */

import { maybeById } from '../core/dom.js';
import { getState, setState, subscribe } from '../core/state.js';
import { fetchAutoApprove } from '../core/api.js';

/** Ambil status dari server lalu render badge-nya. */
export async function loadAutoApprove() {
  try {
    setState({ autoApprove: await fetchAutoApprove() });
  } catch (_) {
    // Server tidak terjangkau — biarkan nilai lama.
  }
  renderAutoApprove();
}

/** Tampilkan badge header kalau perangkat ini sedang menerima tanpa konfirmasi. */
export function renderAutoApprove() {
  const badge = maybeById('autoApproveBadge');
  if (badge) badge.hidden = !getState().autoApprove.enabled;
}

/** Setup subscriber. Dipanggil sekali saat init. */
export function setupAutoApprove() {
  subscribe((_state, changed) => {
    if (changed.has('autoApprove')) renderAutoApprove();
  });

  loadAutoApprove();
}
