/**
 * Pemilih bahasa — tombol bendera + dropdown.
 *
 * Bendera berupa SVG di `/icons/flags/` (lipis/flag-icons, MIT), bukan emoji:
 * Windows 10 tidak punya font untuk emoji bendera, jadi 🇬🇧/🇮🇩 tampil sebagai
 * huruf "GB"/"ID". SVG render sama di semua OS.
 *
 * Pola perilaku mengikuti tombol tema (`features/theme.js`): preferensi
 * disimpan di localStorage oleh `core/i18n.js`, jadi modul ini hanya urusan
 * tampilan dan pemilihan.
 *
 * Lihat docs/adr/0012-i18n-kamus-flat.md
 */

import { el } from '../core/dom.js';
import { getLocale, setLocale, t, LOCALES, onLocaleChange } from '../core/i18n.js';

const FLAG_SRC = { en: '/icons/flags/gb.svg', id: '/icons/flags/id.svg' };
const LOCALE_LABEL = { en: 'English', id: 'Indonesia' };

/** @type {HTMLElement|null} */
let root = null;
let open = false;

/** Bendera SVG sebagai <img> — dekoratif, jadi alt kosong (teks label sudah ada). */
function flag(locale) {
  return el('img', {
    class: 'flag-icon',
    src: FLAG_SRC[locale],
    alt: '',
    'aria-hidden': 'true',
    width: '20',
    height: '15',
  });
}

/**
 * Buat tombol pemilih bahasa.
 * @returns {HTMLElement}
 */
function build() {
  const button = el('button', {
    id: 'btnLocale',
    class: 'icon-btn locale-btn',
    type: 'button',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'data-i18n-attr': 'aria-label:a11y.changeLanguage,title:a11y.language',
  }, flag(getLocale()));

  const menu = el('ul', {
    class: 'locale-menu',
    role: 'listbox',
    'aria-label': t('a11y.language'),
    hidden: true,
  });

  for (const locale of LOCALES) {
    const item = el('li', { role: 'option', 'aria-selected': String(locale === getLocale()) }, [
      el('button', {
        class: 'locale-option',
        type: 'button',
        dataset: { locale },
      }, [flag(locale), el('span', { text: LOCALE_LABEL[locale] })]),
    ]);
    menu.appendChild(item);
  }

  const wrapper = el('div', { class: 'locale-picker' }, [button, menu]);

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle(!open);
  });

  menu.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-locale]');
    if (!option) return;
    await setLocale(option.dataset.locale);
    toggle(false);
    button.focus();
  });

  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      toggle(false);
      button.focus();
    }
  });

  // Klik di luar menutup menu. Dipasang di document karena menu boleh
  // kehilangan fokus (mis. user klik bagian header lain).
  document.addEventListener('click', (event) => {
    if (open && !wrapper.contains(event.target)) toggle(false);
  });

  return wrapper;
}

/** @param {boolean} next */
function toggle(next) {
  open = next;
  if (!root) return;
  const menu = root.querySelector('.locale-menu');
  const button = root.querySelector('#btnLocale');
  if (menu) menu.hidden = !open;
  if (button) button.setAttribute('aria-expanded', String(open));
}

/** Segarkan bendera + item terpilih setelah bahasa berganti. */
function sync() {
  if (!root) return;

  const button = root.querySelector('#btnLocale');
  if (button) {
    const old = button.querySelector('.flag-icon');
    if (old) old.replaceWith(flag(getLocale()));
  }

  for (const option of root.querySelectorAll('[data-locale]')) {
    const selected = option.dataset.locale === getLocale();
    const li = option.closest('[role="option"]');
    if (li) li.setAttribute('aria-selected', String(selected));
    option.classList.toggle('is-selected', selected);
  }

  const menu = root.querySelector('.locale-menu');
  if (menu) menu.setAttribute('aria-label', t('a11y.language'));
}

/**
 * Pasang pemilih bahasa ke dalam wadah (mis. `.header-right`).
 * @param {HTMLElement|null} container
 */
export function initLocale(container) {
  if (!container || root) return;
  root = build();
  container.appendChild(root);
  onLocaleChange(sync);
}
