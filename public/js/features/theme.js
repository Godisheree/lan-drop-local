/**
 * Tema terang/gelap.
 *
 * Preferensi manual (disimpan di localStorage) menang atas preferensi OS.
 * Kalau belum ada preferensi manual, ikuti `prefers-color-scheme`.
 *
 * Lihat docs/adr/0003-dark-mode-via-tokens.md
 */

const STORAGE_KEY = 'landrop-theme';

/** @type {'light'|'dark'|'system'} */
let preference = 'system';

/**
 * Baca preferensi tersimpan.
 * @returns {'light'|'dark'|'system'}
 */
export function loadTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch (_) {
    // localStorage bisa diblokir — abaikan.
  }
  return 'system';
}

/**
 * Simpan preferensi & terapkan.
 * @param {'light'|'dark'|'system'} value
 */
export function setTheme(value) {
  preference = value;
  applyTheme();

  try {
    if (value === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch (_) {
    // abaikan
  }
}

/**
 * Terapkan tema ke elemen <html>.
 */
export function applyTheme() {
  const root = document.documentElement;

  root.classList.remove('theme-light', 'theme-dark');

  if (preference === 'light') root.classList.add('theme-light');
  else if (preference === 'dark') root.classList.add('theme-dark');

  // Perbarui meta theme-color supaya address bar browser ikut warna.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const isDark = preference === 'dark' ||
      (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', isDark ? '#101318' : '#F7F7F9');
  }
}

/**
 * @returns {'light'|'dark'|'system'}
 */
export function getTheme() {
  return preference;
}

/**
 * Setup tombol toggle tema + dengarkan perubahan preferensi OS.
 * @param {HTMLElement} button
 */
export function setupThemeToggle(button) {
  preference = loadTheme();
  applyTheme();

  button.addEventListener('click', () => {
    const current = getEffectiveTheme();
    setTheme(current === 'dark' ? 'light' : 'dark');
    announceTheme(button);
  });

  // Ikuti OS selama user belum memilih manual.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getTheme() === 'system') applyTheme();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

function announceTheme(button) {
  const isDark = getEffectiveTheme() === 'dark';
  button.setAttribute('aria-label', isDark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap');
}

/**
 * Tema yang benar-benar terlihat sekarang.
 * @returns {'light'|'dark'}
 */
export function getEffectiveTheme() {
  if (preference === 'light') return 'light';
  if (preference === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
