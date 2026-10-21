#!/usr/bin/env node
/**
 * Verifikasi panel Sambung: dua alamat (LAN + Tailscale) & QR bisa diganti.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = process.argv[2] || 'http://localhost:3000';
const OUT = process.argv[3] || '.tmp/visual';

function findBrowser() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) if (fs.existsSync(c)) return c;
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Timeout')); } }, 20000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval gagal');
    return res.result.value;
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('WS')), { once: true }); });
    return new Cdp(ws);
  }
}

async function main() {
  const browser = findBrowser();
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const port = 9850 + Math.floor(Math.random() * 100);
  const child = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`,
    '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { targets = await r.json(); break; } } catch (_) {}
    await sleep(250);
  }
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL });
  await sleep(2600);

  await cdp.eval(`document.getElementById('btnConnect').click()`);
  await sleep(1200);

  const before = await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('#urlList .url-item'));
    const svg = document.querySelector('#qrFrame svg');
    return JSON.stringify({
      rows: rows.map(r => ({
        label: r.querySelector('.url-label')?.textContent,
        url: r.querySelector('.url-text')?.textContent,
        active: r.classList.contains('is-active'),
        pressed: r.querySelector('.url-select')?.getAttribute('aria-pressed'),
      })),
      qrPaths: svg ? svg.querySelectorAll('path').length : 0,
      qrHash: svg ? svg.innerHTML.length : 0,
      hint: document.getElementById('urlHint')?.textContent,
    });
  })()`);
  console.log('SEBELUM pilih:', before);

  // Pilih baris kedua (Tailscale)
  await cdp.eval(`(() => {
    const rows = document.querySelectorAll('#urlList .url-item');
    if (rows[1]) rows[1].querySelector('.url-select').click();
    return 'clicked';
  })()`);
  await sleep(1000);

  const after = await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('#urlList .url-item'));
    const svg = document.querySelector('#qrFrame svg');
    return JSON.stringify({
      rows: rows.map(r => ({
        label: r.querySelector('.url-label')?.textContent,
        active: r.classList.contains('is-active'),
        pressed: r.querySelector('.url-select')?.getAttribute('aria-pressed'),
      })),
      qrHash: svg ? svg.innerHTML.length : 0,
      hint: document.getElementById('urlHint')?.textContent,
      introCount: document.querySelectorAll('.connect-intro, .url-hint').length,
    });
  })()`);
  console.log('SETELAH pilih:', after);

  // Decode QR yang sedang aktif untuk memastikan isinya benar.
  const svgHtml = await cdp.eval(`document.querySelector('#qrFrame svg').outerHTML`);
  // Path harus ABSOLUT — file:// dengan path relatif jadi tidak ketemu.
  const qrHtmlPath = path.resolve(path.join(OUT, 'qr-selected.html'));
  fs.writeFileSync(qrHtmlPath, `<!DOCTYPE html><html><body style="margin:0;background:#fff">
${svgHtml.replace('<svg ', '<svg width="600" height="600" ')}
</body></html>`);

  await cdp.send('Page.navigate', { url: 'file:///' + qrHtmlPath.replace(/\\/g, '/') });
  await sleep(1200);
  const qrPng = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const qrPngPath = path.resolve(path.join(OUT, 'qr-selected.png'));
  fs.writeFileSync(qrPngPath, Buffer.from(qrPng.data, 'base64'));

  const { execFileSync } = require('child_process');
  const decodeScript = path.resolve(path.join(OUT, 'decode.py'));
  fs.writeFileSync(decodeScript, `
import cv2, sys
img = cv2.imread(sys.argv[1])
if img is None:
    print("ERROR: tidak bisa baca gambar"); sys.exit(2)
data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
print("DECODED:" + data if data else "ERROR:QR tidak terbaca")
`);
  const decoded = execFileSync('python', [decodeScript, qrPngPath], { encoding: 'utf8' }).trim();
  console.log('QR aktif ter-decode:', decoded);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, 'connect-tailscale.png');
  fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', p);

  child.kill();
  await sleep(800);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {}
}

main();
