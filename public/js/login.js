// Gerbang PIN halaman dashboard.
//
// Semua teks lewat textContent: pesan dari server (nama error) tidak pernah
// masuk ke innerHTML. Script ini sengaja TANPA import — halaman login harus
// jalan walau modul lain gagal dimuat.
(() => {
  // Halaman login sengaja tanpa import (lihat catatan di atas): kalau modul
  // lain gagal dimuat, gerbang PIN tetap harus bisa dibuka. Karena itu kamus
  // diambil sendiri di sini, bukan lewat core/i18n.js.
  const STORAGE_KEY = 'landrop-locale';
  const DEFAULT_LOCALE = 'en';

  /** @type {Record<string,string>} */
  let messages = {};

  function preferredLocale() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'en' || stored === 'id') return stored;
    } catch (_) {
      // localStorage bisa diblokir — pakai default.
    }
    return DEFAULT_LOCALE;
  }

  /**
   * Ambil pesan dari peta inline, ganti placeholder {name}.
   * @param {string} key
   * @param {Record<string,string>} [vars]
   * @returns {string}
   */
  function msg(key, vars) {
    let text = messages[key];
    if (text === undefined) return key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
    }
    return text;
  }

  let defaultHint = null;

  /**
   * Terapkan terjemahan ke seluruh DOM bertanda, sama seperti core/i18n.js.
   * Duplikasi kecil ini disengaja: halaman login tidak boleh bergantung pada
   * modul lain.
   */
  function applyDom() {
    for (const node of document.querySelectorAll('[data-i18n]')) {
      const key = node.getAttribute('data-i18n');
      if (key && messages[key] !== undefined) node.textContent = messages[key];
    }
    for (const node of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of (node.getAttribute('data-i18n-attr') || '').split(',')) {
        const [attr, key] = pair.split(':');
        if (attr && key && messages[key.trim()] !== undefined) {
          node.setAttribute(attr.trim(), messages[key.trim()]);
        }
      }
    }
    document.documentElement.lang = preferredLocale();
  }

  // Gagal memuat kamus bukan alasan menahan user di luar: teks Inggris sudah
  // tertulis langsung di HTML, jadi halaman tetap terbaca.
  fetch(`/locales/${preferredLocale()}.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((dict) => {
      messages = dict || {};
      applyDom();
      if (defaultHint) {
        hint.textContent = msg('dashboard.pinHint', { pin: defaultHint });
        hint.hidden = false;
      }
      submit.textContent = msg('dashboard.signIn');
    })
    .catch(() => {});


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
      defaultHint = info.hint;
      hint.textContent = msg('dashboard.pinHint', { pin: info.hint });
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
    submit.textContent = msg('dashboard.signingIn');

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
          ? msg('dashboard.pinTooMany')
          : msg('dashboard.pinWrong'));

      input.value = '';
      input.focus();
    } catch (_) {
      message.dataset.level = 'err';
      message.textContent = msg('dashboard.serverUnreachable');
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
