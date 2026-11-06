/**
 * i18n — kamus flat, dua bahasa, nol dependency.
 *
 * Kenapa kamus JSON flat dan bukan gettext/ICU: frontend aplikasi ini sengaja
 * nol dependency (ADR-0002). Kebutuhannya cuma "ganti kalimat", bukan
 * pluralisasi kompleks, jadi satu objek `key -> string` cukup dan bisa
 * diperiksa skrip (`scripts/check-i18n.js`).
 *
 * Konvensi key: `area.thing` — `nav.connect`, `transfer.rejected`,
 * `dashboard.uptime`. Nilai boleh berisi placeholder `{name}`.
 *
 * Bahasa default English (permintaan produk). Indonesia tersedia penuh dan
 * pilihannya disimpan di localStorage.
 *
 * Lihat docs/adr/0012-i18n-kamus-flat.md
 */

import { el } from './dom.js';

export const LOCALES = ['en', 'id'];
export const DEFAULT_LOCALE = 'en';

const STORAGE_KEY = 'landrop-locale';

/** @type {Record<string, Record<string, string>>} */
const dictionaries = {};

/** @type {string} */
let current = DEFAULT_LOCALE;

/** @type {Set<(locale: string) => void>} */
const listeners = new Set();

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isLocale(value) {
  return typeof value === 'string' && LOCALES.includes(value);
}

/** @returns {string} */
export function getLocale() {
  return current;
}

/**
 * Baca preferensi tersimpan. `localStorage` bisa diblokir (mode privat,
 * kebijakan browser) — dalam hal itu pakai default, jangan lempar.
 * @returns {string}
 */
export function loadLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch (_) {
    // Diabaikan: storage tidak wajib ada.
  }
  // Tidak ada pilihan eksplisit → default produk (English), BUKAN
  // navigator.language. Perilaku yang bisa diprediksi lebih penting.
  return DEFAULT_LOCALE;
}

/**
 * Muat kamus satu bahasa. Aman dipanggil berulang (hasil di-cache).
 * @param {string} locale
 * @returns {Promise<Record<string,string>>}
 */
export async function loadDictionary(locale) {
  if (dictionaries[locale]) return dictionaries[locale];

  const res = await fetch(`/locales/${locale}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Locale ${locale} failed to load (${res.status})`);

  const dict = await res.json();
  dictionaries[locale] = dict;
  return dict;
}

/**
 * Terjemahkan satu key.
 *
 * Urutan fallback: bahasa aktif → English → key mentah. Key mentah sengaja
 * ditampilkan (bukan string kosong) supaya terjemahan yang kurang kelihatan
 * saat dipakai, bukan hilang diam-diam.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  const dict = dictionaries[current] || {};
  const fallback = dictionaries[DEFAULT_LOCALE] || {};
  let text = dict[key] !== undefined ? dict[key] : fallback[key];
  if (text === undefined) return key;

  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/**
 * Pasang terjemahan ke seluruh DOM bertanda.
 *
 * Dua atribut yang dikenali:
 *   data-i18n="key"                            → textContent
 *   data-i18n-attr="aria-label:key,title:key"  → atribut
 *
 * Dipanggil saat boot dan setiap bahasa berganti, jadi HTML cukup deklaratif
 * dan tidak perlu diduplikasi per bahasa.
 *
 * @param {ParentNode} [root]
 */
export function applyDom(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key);
  }

  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    const spec = node.getAttribute('data-i18n-attr');
    if (!spec) continue;
    for (const pair of spec.split(',')) {
      const [attr, key] = pair.split(':');
      if (!attr || !key) continue;
      node.setAttribute(attr.trim(), t(key.trim()));
    }
  }

  // Bahasa dokumen ikut berganti — pembaca layar memakainya untuk memilih
  // pelafalan yang benar.
  document.documentElement.lang = current;
}

/**
 * Ganti bahasa aktif: muat kamus, simpan, segarkan DOM, kabari pendengar.
 * @param {string} locale
 * @returns {Promise<boolean>} true kalau berhasil
 */
export async function setLocale(locale) {
  if (!isLocale(locale)) return false;

  try {
    await loadDictionary(locale);
  } catch (err) {
    console.warn(`[i18n] ${err.message}`);
    return false;
  }

  current = locale;

  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch (_) {
    // Diabaikan: pilihan tetap berlaku sampai tab ditutup.
  }

  applyDom();
  for (const fn of listeners) {
    try {
      fn(locale);
    } catch (_) {
      // Satu pendengar rusak tidak boleh membatalkan yang lain.
    }
  }
  document.dispatchEvent(new CustomEvent('landrop:locale', { detail: { locale } }));
  return true;
}

/**
 * Dengar perubahan bahasa. Berguna untuk teks yang dibuat di JS (bukan dari
 * HTML bertanda `data-i18n`).
 * @param {(locale: string) => void} fn
 * @returns {() => void} fungsi pelepas
 */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Siapkan i18n saat boot: muat kamus bahasa tersimpan lalu terapkan ke DOM.
 *
 * Kegagalan muat kamus TIDAK boleh mematikan UI — kalau fetch gagal (offline
 * dan service worker belum punya cache-nya), UI tetap tampil dengan key mentah
 * plus pesan di console, bukan halaman kosong.
 *
 * @returns {Promise<string>} bahasa yang akhirnya aktif
 */
export async function initI18n() {
  const wanted = loadLocale();
  try {
    await loadDictionary(wanted);
    // English selalu dimuat sebagai fallback, walaupun bukan bahasa aktif.
    if (wanted !== DEFAULT_LOCALE) await loadDictionary(DEFAULT_LOCALE);
  } catch (err) {
    console.warn(`[i18n] ${err.message} — UI shows raw keys until the dictionary loads`);
  }

  current = wanted;
  applyDom();
  return current;
}

/**
 * Elemen berisi teks terjemahan — untuk tempat yang butuh NODE, bukan string,
 * supaya bisa disegarkan lewat pendengar `landrop:locale` alih-alih jadi teks
 * mati (bug yang dulu terjadi di dashboard).
 *
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @param {string} [tag]
 * @returns {HTMLElement}
 */
export function tEl(key, vars, tag = 'span') {
  return el(tag, { text: t(key, vars) });
}
