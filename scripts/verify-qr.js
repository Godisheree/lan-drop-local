#!/usr/bin/env node
/**
 * Verifikasi QR: render QR dari panel Sambung, lalu decode dengan OpenCV.
 *
 * Membuktikan QR benar-benar bisa dipindai — bukan cuma "SVG-nya ada".
 *butuh: pip install opencv-python-headless pillow
 *
 * Usage: node scripts/verify-qr.js [--url http://localhost:3010]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = { url: 'http://localhost:3010' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
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
  throw new Error('CDP tidak terjangkau');
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('Browser tidak ditemukan');
    process.exitCode = 1;
    return;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-qr-'));
  const port = 9800 + Math.floor(Math.random() * 100);
  const outDir = path.join(process.cwd(), '.tmp', 'qr');
  fs.mkdirSync(outDir, { recursive: true });

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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    });

    await cdp.send('Page.navigate', { url: args.url });
    await sleep(2500);

    // Buka panel Sambung.
    await cdp.send('Runtime.evaluate', {
      expression: `document.getElementById('btnConnect').click()`,
    });
    await sleep(1000);

    // Ambil SVG QR dan URL yang diharapkan.
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const svg = document.querySelector('#qrFrame svg');
        return JSON.stringify({
          svg: svg ? svg.outerHTML : null,
          expected: (document.querySelector('#urlList .url-text')||{}).textContent || null,
        });
      })()`,
      returnByValue: true,
    });
    const data = JSON.parse(probe.result.value);

    if (!data.svg) throw new Error('QR SVG tidak ditemukan');

    // Render SVG ke PNG lewat browser, lalu decode dengan OpenCV.
    const htmlPath = path.join(outDir, 'qr.html');
    fs.writeFileSync(htmlPath, `<!DOCTYPE html><html><body style="margin:0;background:#fff">
${data.svg.replace('<svg ', '<svg width="600" height="600" ')}
</body></html>`);

    const shot = await cdp.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(1200);
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const pngPath = path.join(outDir, 'qr.png');
    fs.writeFileSync(pngPath, Buffer.from(png.data, 'base64'));

    console.log('PNG QR  :', pngPath);
    console.log('URL tabs:', data.expected);

    // Decode dengan OpenCV.
    const { execFileSync } = require('child_process');
    const decodeScript = path.join(outDir, 'decode.py');
    fs.writeFileSync(decodeScript, `
import cv2, sys
img = cv2.imread(sys.argv[1])
if img is None:
    print("ERROR: tidak bisa baca gambar"); sys.exit(2)
detector = cv2.QRCodeDetector()
data, points, _ = detector.detectAndDecode(img)
if data:
    print("DECODED:" + data)
else:
    # Coba lagi dengan grescale + threshold
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    data2, _, _ = detector.detectAndDecode(bw)
    print("DECODED:" + data2 if data2 else "ERROR:QR tidak terbaca")
`);

    const output = execFileSync('python', [decodeScript, pngPath], { encoding: 'utf8' }).trim();
    console.log('OpenCV  :', output);

    if (output.startsWith('DECODED:')) {
      const decoded = output.slice('DECODED:'.length).trim();
      if (decoded === data.expected) {
        console.log('\nPASS — QR ter-decode dan cocok dengan URL yang ditampilkan.');
      } else {
        console.log(`\nFAIL — QR berisi "${decoded}" tapi UI menampilkan "${data.expected}"`);
        process.exitCode = 1;
      }
    } else {
      console.log('\nFAIL — QR tidak bisa di-decode.');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('GAGAL:', err.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', resolve);
      setTimeout(resolve, 4000);
    });
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {}
  }
}

main();
