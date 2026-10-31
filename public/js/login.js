// Gerbang PIN halaman dashboard.
//
// Semua teks lewat textContent: pesan dari server (nama error) tidak pernah
// masuk ke innerHTML. Script ini sengaja TANPA import — halaman login harus
// jalan walau modul lain gagal dimuat.
(() => {
  const form = document.getElementById('pinForm');
  const input = document.getElementById('pinInput');
  const submit = document.getElementById('pinSubmit');
  const message = document.getElementById('pinMessage');
  const hint = document.getElementById('pinHint');

  const SUBMIT_LABEL = submit.textContent;

  // PIN bawaan cuma relevan sampai diganti user. Setelah diganti server balas
  // hint: null, dan hint-nya hilang sendiri dari halaman.
  fetch('/dashboard/pin-info', { cache: 'no-store' })
    .then((r) => r.json())
    .then((info) => {
      if (!info || !info.default || !info.hint) return;
      hint.textContent = `PIN bawaan: ${info.hint} — sebaiknya diganti setelah masuk.`;
      hint.hidden = false;
    })
    .catch(() => {
      // Hint bukan syarat bisa masuk — gagal ambil, halaman tetap jalan.
    });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '';
    message.dataset.level = '';
    submit.disabled = true;
    submit.textContent = 'Memeriksa…';

    try {
      const response = await fetch('/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: input.value }),
      });

      if (response.ok) {
        // Server yang memilih halaman: /dashboard sekarang balas dashboard.html
        // karena cookie sesi sudah terpasang.
        window.location.href = '/dashboard';
        return;
      }

      const data = await response.json().catch(() => ({}));
      // 429 dan 401 dibedakan: "PIN salah" mengundang coba lagi, "terlalu banyak
      // percobaan" tidak — user harus menunggu, dan itu bukan salah ketiknya.
      message.dataset.level = 'err';
      message.textContent =
        data.error ||
        (response.status === 429
          ? 'Terlalu banyak percobaan PIN. Tunggu sebentar.'
          : 'PIN salah. Coba lagi.');

      input.value = '';
      input.focus();
    } catch (_) {
      message.dataset.level = 'err';
      message.textContent = 'Tidak bisa menghubungi server. Cek koneksi lalu coba lagi.';
      input.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = SUBMIT_LABEL;
    }
  });

  // Huruf yang tidak sengaja masuk (keyboard fisik) dibuang sebelum sempat
  // bikin PIN ditolak tanpa user tahu kenapa.
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    if (digits !== input.value) input.value = digits;
  });

  // Halaman ini dibuka cuma untuk satu hal. Kunci angka langsung siap tanpa
  // satu ketukan tambahan — di HP itu bedanya terasa.
  input.focus();
})();
