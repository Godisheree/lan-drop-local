/**
 * Helper pembuatan DOM yang aman.
 *
 * Aturan repo: JANGAN pernah membangun HTML dari string berisi data dinamis.
 * Semua elemen dibuat lewat `el()` atau `frag()` supaya atribut selalu
 * di-escape oleh DOM API browser, bukan oleh kita.
 *
 * Lihat docs/adr/0001-frontend-modularization.md
 */

/**
 * Buat elemen DOM.
 *
 * @param {string} tag
 * @param {Object} [attrs] - atribut; key `class`, `text`, `html` punya makna khusus
 * @param {Array<Node|string>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') {
      node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [dKey, dValue] of Object.entries(value)) {
        if (dValue === null || dValue === undefined) continue;
        node.dataset[dKey] = String(dValue);
      }
    } else if (key === 'style' && typeof value === 'object') {
      for (const [sKey, sValue] of Object.entries(value)) {
        if (sValue === null || sValue === undefined) continue;
        node.style.setProperty(sKey, String(sValue));
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/**
 * Buat DocumentFragment dari daftar anak.
 * @param {Array<Node|string>} children
 * @returns {DocumentFragment}
 */
export function frag(children = []) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/**
 * Gabungkan anak ke node induk, abaikan null/undefined.
 * @param {Node} parent
 * @param {Array<Node|string>|Node|string} children
 */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' ? document.createTextNode(child) : child
    );
  }
  return parent;
}

/**
 * Kosongkan elemen (safe — bukan innerHTML = '').
 * @param {HTMLElement} node
 */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Ganti isi elemen dengan daftar anak.
 * @param {HTMLElement} node
 * @param {Array<Node|string>|Node|string} children
 */
export function replace(node, children) {
  if (!node) return node;
  clear(node);
  append(node, children);
  return node;
}

/**
 * Ambil elemen berdasarkan id, lempar error kalau tidak ada.
 * Memakai ini sebagai ganti `document.getElementById` supaya ketiadaan
 * elemen ketahuan lebih awal.
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemen #${id} tidak ditemukan di DOM`);
  return node;
}

/**
 * Ambil elemen opsional berdasarkan id.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export function maybeById(id) {
  return document.getElementById(id);
}
