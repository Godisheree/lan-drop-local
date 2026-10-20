#!/usr/bin/env node
/**
 * Smoke test frontend LAN DROP via Chrome DevTools Protocol.
 *
 * Menjalankan Edge/Chrome headless, memuat halaman, lalu mengumpulkan:
 *   - error console (level error/warning)
 * - uncaught exception di halaman
 *   - request HTTP gagal (404/500)
 *   - screenshot per viewport
 *
 * Nol dependency baru — CDP dijemput via WebSocket native Node 22.
 *
 * Usage:
 *   node scripts/smoke.js [--url http://localhost:3010] [--out .tmp/smoke]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Argumen
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { url: 'http://localhost:3010', out: path.join(os.tmpdir(), 'landrop-smoke'), keep: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--keep') args.keep = true;
  }
  return args;
}

const args = parseArgs(process.argv);

const VIEWPORTS = [
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
  { name: 'tablet-768x1024', width: 768, height: 1024, mobile: false },
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
];

// ---------------------------------------------------------------------------
// Temukan browser
// ---------------------------------------------------------------------------

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Klien CDP minimal
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const fn of this.listeners.get(message.method) || []) fn(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 20000);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Gagal buka WebSocket CDP')), { once: true });
      setTimeout(() => reject(new Error('Timeout buka WebSocket CDP')), 10000);
    });
    return new Cdp(ws);
  }
}

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_) {
      // belum siap
    }
    await sleep(250);
  }
  throw new Error(`Tidak bisa menjangkau ${url}`);
}

// ---------------------------------------------------------------------------
// Skenario
// ---------------------------------------------------------------------------

/**
 * Kumpulkan diagnostik halaman.
 */
async function inspectPage(cdp) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'warning') return;
    const text = (params.args || [])
      .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
      .join(' ')
      .trim();
    if (text) consoleErrors.push({ type: params.type, text });
  });

  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    const text = details.exception?.description || details.text || 'Exception tidak diketahui';
    pageErrors.push(text);
  });

  cdp.on('Network.responseReceived', (params) => {
    const { status, url } = params.response;
    if (status >= 400) failedRequests.push({ status, url });
  });

  cdp.on('Network.loadingFailed', (params) => {
    failedRequests.push({ status: 'network', url: params.errorText || 'unknown' });
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('Browser tidak ditemukan. Set CHROME_PATH.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-chrome-'));
  const port = 9222 + Math.floor(Math.random() * 500);

  const child = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let exitCode = 0;

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Tidak ada target page di CDP');

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await inspectPage(cdp);

    const results = [];

    for (const viewport of VIEWPORTS) {
      const consoleErrors = [];
      const pageErrors = [];
      const failedRequests = [];

      cdp.on('Runtime.consoleAPICalled', (params) => {
        if (params.type !== 'error' && params.type !== 'warning') return;
        const text = (params.args || [])
          .map((arg) => arg.value ?? arg.description ?? '')
          .join(' ')
          .trim();
        if (text) consoleErrors.push({ type: params.type, text });
      });
      cdp.on('Runtime.exceptionThrown', (params) => {
        const details = params.exceptionDetails || {};
        pageErrors.push(details.exception?.description || details.text || 'Exception');
      });
      cdp.on('Network.responseReceived', (params) => {
        if (params.response.status >= 400) {
          failedRequests.push({ status: params.response.status, url: params.response.url });
        }
      });

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });

      await cdp.send('Page.navigate', { url: args.url });
      await sleep(2600);

      // Cek elemen penting benar-benar ter-render.
      const probe = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const q = (s) => document.querySelector(s);
          const style = (sel, prop) => {
            const el = q(sel);
            if (!el) return null;
            return getComputedStyle(el).getPropertyValue(prop).trim();
          };
          return JSON.stringify({
            title: document.title,
            hasHeader: !!q('#header'),
            hasDeviceList: !!q('#deviceList'),
            hasTransferList: !!q('#transferList'),
            hasHistory: !!q('#historyList'),
            hasConnectBtn: !!q('#btnConnect'),
            hasTabs: !!q('#mobileTabs'),
            deviceCount: document.querySelectorAll('.device-card').length,
            emptyState: !!q('#deviceList .empty-state'),
            cssLoaded: style('body', 'background-color'),
            fontSize: style('body', 'font-size'),
            toastHost: !!q('#toastHost'),
            liveRegion: !!q('#liveRegion'),
            moduleScripts: document.querySelectorAll('script[type="module"]').length,
            qrVendor: typeof window.qrcode,
          });
        })()`,
        returnByValue: true,
      });

      if (!probe.result || typeof probe.result.value !== 'string') {
        throw new Error(
          `Halaman tidak termuat dengan benar di ${args.url}. ` +
          `Pastikan server LAN DROP sudah jalan (npm start) atau URL-nya salah.`
        );
      }

      const probeData = JSON.parse(probe.result.value);

      // Buka panel Sambung untuk memastikan QR ter-generate.
      await cdp.send('Runtime.evaluate', {
        expression: `document.getElementById('btnConnect').click()`,
      });
      await sleep(900);

      const qrProbe = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const frame = document.getElementById('qrFrame');
          const svg = frame && frame.querySelector('svg');
          return JSON.stringify({
            modalOpen: !document.getElementById('connectModal').classList.contains('hidden'),
            qrSvg: !!svg,
            qrPaths: svg ? svg.querySelectorAll('path').length : 0,
            urlRows: document.querySelectorAll('#urlList .url-item').length,
            qrError: frame ? frame.classList.contains('is-error') : false,
            qrMessage: frame && frame.classList.contains('is-error') ? frame.textContent.trim() : null,
          });
        })()`,
        returnByValue: true,
      });
      const qrData = JSON.parse(qrProbe.result.value);

      // Tutup modal lagi.
      await cdp.send('Runtime.evaluate', {
        expression: `document.getElementById('btnCloseConnect').click()`,
      });
      await sleep(300);

      // Screenshot.
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shotPath = path.join(args.out, `${viewport.name}.png`);
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

      results.push({
        viewport: viewport.name,
        probe: probeData,
        qr: qrData,
        consoleErrors,
        pageErrors,
        failedRequests,
        screenshot: shotPath,
      });
    }

    // Ringkasan
    console.log('\n=== HASIL SMOKE TEST ===\n');
    let problems = 0;

    for (const result of results) {
      console.log(`--- ${result.viewport} ---`);
      console.log(`  device card : ${result.probe.deviceCount}`);
      console.log(`  empty state : ${result.probe.emptyState}`);
      console.log(`  css loaded  : ${result.probe.cssLoaded} (font ${result.probe.fontSize})`);
      console.log(`  module script: ${result.probe.moduleScripts}`);
      console.log(`  QR vendor   : ${result.probe.qrVendor}`);
      console.log(`  QR modal    : open=${result.qr.modalOpen} svg=${result.qr.qrSvg} paths=${result.qr.qrPaths} urls=${result.qr.urlRows} error=${result.qr.qrError}`);
      if (result.qr.qrMessage) console.log(`  QR message  : ${result.qr.qrMessage}`);
      console.log(`  screenshot  : ${result.screenshot}`);

      if (result.pageErrors.length) {
        problems += result.pageErrors.length;
        console.log(`  !! PAGE ERRORS (${result.pageErrors.length}):`);
        for (const err of result.pageErrors.slice(0, 5)) console.log(`     ${err.split('\n')[0]}`);
      }
      if (result.consoleErrors.length) {
        problems += result.consoleErrors.length;
        console.log(`  !! CONSOLE (${result.consoleErrors.length}):`);
        for (const err of result.consoleErrors.slice(0, 5)) console.log(`     [${err.type}] ${err.text.split('\n')[0]}`);
      }
      if (result.failedRequests.length) {
        problems += result.failedRequests.length;
        console.log(`  !! FAILED REQUESTS (${result.failedRequests.length}):`);
        for (const req of result.failedRequests.slice(0, 5)) console.log(`     ${req.status} ${req.url}`);
      }
      console.log('');
    }

    console.log(problems === 0 ? 'SEMUA BERSIH — tidak ada error.' : `${problems} masalah ditemukan.`);
    exitCode = problems > 0 ? 1 : 0;

    const reportPath = path.join(args.out, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`Report: ${reportPath}`);
  } catch (err) {
    console.error('SMOKE TEST GAGAL:', err.message);
    exitCode = 1;
  } finally {
    child.kill();
    // Tunggu browser benar-benar berhenti sebelum hapus profil — kalau tidak,
    // file lock Windows (Crashpad) bikin rmSync gagal dengan EBUSY.
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', resolve);
      setTimeout(resolve, 4000);
    });
    if (!args.keep) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (_) {
        // Profile sementara tidak terhapus — tidak memblokir hasil test.
      }
    }
  }

  process.exitCode = exitCode;
}

main();
