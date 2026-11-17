/**
 * Layar "pasangkan perangkat ini dulu".
 *
 * Kenapa ada: semua endpoint data (daftar perangkat, transfer, history)
 * sekarang butuh kunci perangkat — kunci 48 hex yang dikirim server di URL QR
 * (`/?k=...`). Browser di mesin server sendiri dapat kunci itu otomatis; HP
 * atau laptop lain harus memindai QR dari panel "Sambung".
 *
 * Kalau perangkat ini membuka alamat tanpa kunci, UI tidak boleh menampilkan
 * kotak-kotak kosong tanpa penjelasan. Yang muncul: satu layar dengan instruksi
 * dan tombol "Coba lagi" — bukan toast yang lewat begitu saja.
 */

import { t } from '../core/i18n.js';

let shown = false;

/**
 * Tampilkan layar pairing. Idempoten: dipanggil berkali-kali tidak menumpuk.
 * @param {string} [reason] pesan tambahan dari server (opsional)
 */
export function showPairingScreen(reason) {
  if (shown) return;
  shown = true;

  const overlay = document.createElement('div');
  overlay.className = 'pairing-screen';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pairingTitle');

  const card = document.createElement('div');
  card.className = 'pairing-card';

  const title = document.createElement('h1');
  title.id = 'pairingTitle';
  title.textContent = t('pairing.title');

  const body = document.createElement('p');
  body.textContent = t('pairing.body');

  const hint = document.createElement('p');
  hint.className = 'pairing-hint';
  hint.textContent = t('pairing.hint');

  const actions = document.createElement('div');
  actions.className = 'pairing-actions';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-primary';
  retry.textContent = t('pairing.retry');
  retry.addEventListener('click', () => {
    // Muat ulang penuh: kunci disimpan di cookie, jadi kalau perangkat ini
    // baru saja dipasangkan lewat tab lain, reload akan memakainya.
    window.location.reload();
  });

  actions.appendChild(retry);
  card.appendChild(title);
  card.appendChild(body);
  if (reason) {
    const detail = document.createElement('p');
    detail.className = 'pairing-detail';
    detail.textContent = reason;
    card.appendChild(detail);
  }
  card.appendChild(hint);
  card.appendChild(actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Fokus ke tombol supaya langsung bisa diaktifkan dengan keyboard.
  retry.focus();
}

export default { showPairingScreen };
