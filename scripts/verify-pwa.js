#!/usr/bin/env node
/**
 * Verifikasi PWA LAN DROP.
 *
 * Memeriksa:
 *   1. manifest.webmanifest valid & field wajibnya ada
 *   2. Semua ikon yang dirujuk manifest benar-benar ada, bertipe PNG,
 *      dan dimensinya cocok (dibaca dari chunk IHDR)
 *   3. sw.js tersaji dengan Content-Type JS
 *   4. Service worker terdaftar di localhost (secure context)
 *   5. Service worker TIDAK PERNAH meng-cache response API
 *   6. Tidak ada URL CDN di file shell
 *   7. UI install ada di DOM
 *
 * Usage: node scripts/verify-pwa.js [--url http://localhost:3000]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = { url: 'http://localhost:3000' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ── Browser + CDP ─────────────────────────────────────────────────────────

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Timeout ' + method)); }
      }, 20000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval gagal');
    return res.result.value;
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WS gagal')), { once: true });
    });
    return new Cdp(ws);
  }
}

async function fetchJson(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error(`Tidak bisa menjangkau ${url}`);
}

/**
 * Baca dimensi PNG dari chunk IHDR (byte 16..24).
 * @param {Buffer} buf
 * @returns {{width: number, height: number}|null}
 */
function readPngSize(buf) {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ── Pemeriksaan statis (tanpa browser) ───────────────────────────────────

function verifyStatic() {
  console.log('\n=== PEMERIKSAAN STATIS ===');

  // 1. Manifest
  const manifestPath = path.join(ROOT, 'public', 'manifest.webmanifest');
  if (!fs.existsSync(manifestPath)) {
    check('manifest.webmanifest ada', false, 'berkas tidak ditemukan');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    check('manifest.webmanifest valid JSON', true);
  } catch (err) {
    check('manifest.webmanifest valid JSON', false, err.message);
    return;
  }

  const required = ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons'];
  const missing = required.filter((field) => !manifest[field]);
  check('manifest punya field wajib', missing.length === 0, missing.join(', '));

  check('short_name <= 12 karakter', (manifest.short_name || '').length <= 12,
    `${(manifest.short_name || '').length} karakter`);

  check('name <= 60 karakter', (manifest.name || '').length <= 60,
    `${(manifest.name || '').length} karakter`);

  // 2. Ikon
  let iconOk = true;
  const iconDetail = [];
  for (const icon of manifest.icons || []) {
    const iconPath = path.join(ROOT, 'public', icon.src.replace(/^\//, ''));
    if (!fs.existsSync(iconPath)) {
      iconOk = false;
      iconDetail.push(`${icon.src} (hilang)`);
      continue;
    }
    const buf = fs.readFileSync(iconPath);
    const size = readPngSize(buf);
    if (!size) {
      iconOk = false;
      iconDetail.push(`${icon.src} (bukan PNG valid)`);
      continue;
    }
    const expected = icon.sizes.split('x').map(Number);
    if (size.width !== expected[0] || size.height !== expected[1]) {
      iconOk = false;
      iconDetail.push(`${icon.src} (${size.width}x${size.height}, harus ${icon.sizes})`);
    }
  }
  check('semua ikon manifest ada & dimensinya benar', iconOk, iconDetail.join('; '));

  // 3. Service worker tidak boleh menyentuh API
  const swPath = path.join(ROOT, 'public', 'sw.js');
  const swSource = fs.existsSync(swPath) ? fs.readFileSync(swPath, 'utf8') : '';

  const neverCache = ['/devices', '/me', '/history', '/transfer/', '/thumbnail/'];
  const missingDeny = neverCache.filter((p) => !swSource.includes(`'${p}'`));
  check('service worker men-deny-list path API', missingDeny.length === 0, missingDeny.join(', '));

  // Precache tidak boleh memuat path API.
  const precacheBlock = swSource.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  const precache = precacheBlock ? precacheBlock[1] : '';
  const apiInPrecache = neverCache.filter((p) => precache.includes(`'${p}'`));
  check('tidak ada path API di precache', apiInPrecache.length === 0, apiInPrecache.join(', '));

  // 4. Tidak ada CDN
  const shellFiles = [
    'public/sw.js',
    'public/js/main.js',
    'public/js/core/api.js',
    'public/js/features/pwa.js',
    'public/js/features/connect.js',
  ];
  const cdnHits = [];
  for (const file of shellFiles) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, 'utf8');
    const matches = source.match(/https?:\/\/[^\s'")]+/g) || [];
    for (const url of matches) {
      // URL LAN sendiri (192.168.x.x / localhost) bukan CDN.
      if (/https?:\/\/(www\.)?(cdn|unpkg|jsdelivr|cdnjs|googleapis|gstatic)/i.test(url)) {
        cdnHits.push(`${file}: ${url}`);
      }
    }
  }
  check('tidak ada URL CDN di kode shell', cdnHits.length === 0, cdnHits.join('; '));
}

// ── Pemeriksaan runtime ──────────────────────────────────────────────────

async function verifyRuntime(browser) {
  console.log('\n=== PEMERIKSAAN RUNTIME ===');

  // Manifest via HTTP
  try {
    const res = await fetch(`${args.url}/manifest.webmanifest`);
    const contentType = res.headers.get('content-type') || '';
    check('GET /manifest.webmanifest 200', res.ok, `status ${res.status}`);
    check('Content-Type manifest benar', contentType.includes('manifest+json'), contentType);
  } catch (err) {
    check('GET /manifest.webmanifest 200', false, err.message);
  }

  // sw.js via HTTP
  try {
    const res = await fetch(`${args.url}/sw.js`);
    const contentType = res.headers.get('content-type') || '';
    check('GET /sw.js 200', res.ok, `status ${res.status}`);
    check('Content-Type sw.js benar', contentType.includes('javascript'), contentType);
  } catch (err) {
    check('GET /sw.js 200', false, err.message);
  }

  // Ikon via HTTP
  let iconsOk = true;
  const iconDetail = [];
  for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png']) {
    const res = await fetch(`${args.url}${icon}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const size = readPngSize(buf);
    if (!res.ok || !size) {
      iconsOk = false;
      iconDetail.push(`${icon} (${res.status})`);
    }
  }
  check('semua ikon tersaji dengan benar', iconsOk, iconDetail.join('; '));

  // Di browser
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-pwa-'));
  const port = 9600 + Math.floor(Math.random() * 200);
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: args.url });
    await sleep(3000);

    // Service worker terdaftar?
    let swRegistered = false;
    for (let i = 0; i < 20; i++) {
      const state = await cdp.eval(`(async () => {
        if (!('serviceWorker' in navigator)) return 'unsupported';
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return 'none';
        if (reg.active) return 'active';
        if (reg.installing || reg.waiting) return 'installing';
        return 'registered';
      })()`);
      if (state === 'active') { swRegistered = true; break; }
      if (state === 'none' || state === 'unsupported') break;
      await sleep(500);
    }
    check('service worker terdaftar di localhost (secure context)', swRegistered);

    // UI install ada?
    const installUi = await cdp.eval(`(() => {
      const section = document.getElementById('installSection');
      return JSON.stringify({
        exists: !!section,
        childCount: section ? section.children.length : 0,
        hasSteps: !!document.querySelector('#installSection .install-steps'),
        hasButton: !!document.querySelector('#installSection .install-button'),
        hasStatus: !!document.querySelector('#installSection .install-status'),
      });
    })()`);
    const ui = JSON.parse(installUi);
    check('UI install ada di DOM', ui.exists && ui.childCount > 0, JSON.stringify(ui));

    // Halaman shouldn't punya error
    const errors = await cdp.eval(`window.__landropErrors ? window.__landropErrors.length : 0`);
    check('tidak ada error runtime terdeteksi', errors === 0, String(errors));

    // Cleanup: unregister SW + hapus cache supaya test lain tidak terpengaruh.
    await cdp.eval(`(async () => {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) await reg.unregister();
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const key of keys) await caches.delete(key);
      }
      return 'cleaned';
    })()`);
  } catch (err) {
    check('pemeriksaan runtime browser', false, err.message);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', resolve);
      setTimeout(resolve, 3000);
    });
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }); } catch (_) {}
  }
}

async function main() {
  verifyStatic();

  const browser = findBrowser();
  if (!browser) {
    check('browser ditemukan', false, 'set CHROME_PATH');
  } else {
    await verifyRuntime(browser);
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n=== ${passed}/${results.length} pemeriksaan lolos ===`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main();
