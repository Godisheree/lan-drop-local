#!/usr/bin/env node
/**
 * Uji jalur transcode video setelah ffmpeg di-refactor ke server/ffmpeg.js.
 *
 * Kirim file .mkv (format yang harus di-transcode ke H.264) lalu pastikan
 * file yang diterima benar-benar .mp4 — bukan .mkv mentah.
 *
 * Butuh ffmpeg di PATH (untuk bikin video uji & untuk transcode-nya).
 * Usage: node scripts/check-transcode.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Timeout ' + method)); } }, 25000);
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

/** Buka browser headless baru + halaman, kembalikan { cdp, child, userDataDir }. */
async function openPage(browser, url, port) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-udd-'));
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) { targets = await res.json(); break; }
    } catch (_) {}
    await sleep(250);
  }
  if (!targets) throw new Error('Browser tidak merespon');

  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await sleep(2600);

  return { cdp, child, userDataDir };
}

async function main() {
  const browser = findBrowser();
  if (!browser) throw new Error('Browser tidak ditemukan');

  // 1. Video uji .mkv (butuh ffmpeg).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-test-'));
  const srcVideo = path.join(tmpDir, 'sample.mkv');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', srcVideo,
  ], { stdio: 'ignore' });
  console.log('video uji:', srcVideo, fs.statSync(srcVideo).size, 'byte');

  const saveDir = path.join(tmpDir, 'save');
  fs.mkdirSync(saveDir, { recursive: true });

  // 2. Dua server.
  const PORT_A = 3310, TA = 3311, PORT_B = 3320, TB = 3321;
  const startServer = (port, tp, name, peers) => {
    const proc = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, PORT: String(port), TRANSFER_PORT: String(tp), DISCOVERY_PORT: String(port + 100),
        LANDROP_PEERS: peers, LANDROP_SAVE_DIR: saveDir, LANDROP_DATA_DIR: path.join(tmpDir, 'data-' + name), DEVICE_NAME: name },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.logs = [];
    proc.stdout.on('data', (d) => proc.logs.push(d.toString()));
    proc.stderr.on('data', (d) => proc.logs.push(d.toString()));
    return proc;
  };

  const A = startServer(PORT_A, TA, 'MesinA', `MesinB@127.0.0.1:${PORT_B}@${TB}`);
  const B = startServer(PORT_B, TB, 'MesinB', `MesinA@127.0.0.1:${PORT_A}@${TA}`);

  await sleep(2500);

  const pageA = await openPage(browser, `http://localhost:${PORT_A}`, 9871);
  const pageB = await openPage(browser, `http://localhost:${PORT_B}`, 9872);

  // 3. Kirim video dari A ke B.
  const b64 = fs.readFileSync(srcVideo).toString('base64');
  await pageA.cdp.eval(`(async () => {
    const mod = await import('/js/features/send.js');
    const devices = await (await fetch('/devices')).json();
    const peer = devices[0];
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    await mod.sendBatch(
      { ip: peer.ip, port: peer.transferPort, targetName: peer.deviceName },
      [new File([arr], 'uji-video.mkv')]
    );
  })()`);

  // 4. Terima di B.
  for (let i = 0; i < 60; i++) {
    const open = await pageB.cdp.eval(`!document.getElementById('requestModal').classList.contains('hidden')`);
    if (open) { await pageB.cdp.eval(`document.getElementById('btnAccept').click()`); break; }
    await sleep(300);
  }

  // 5. Tunggu selesai.
  let done = false;
  for (let i = 0; i < 80; i++) {
    const st = await pageB.cdp.eval(`(() => {
      const it = Array.from(document.querySelectorAll('#transferList .transfer-item'))
        .find(e => e.textContent.includes('uji-video'));
      return it ? it.dataset.status : null;
    })()`);
    if (st === 'completed') { done = true; break; }
    await sleep(500);
  }

  const saved = fs.readdirSync(saveDir);
  const transcoded = saved.find((f) => f.endsWith('.mp4'));
  const original = saved.find((f) => f.endsWith('.mkv'));

  console.log('\n=== HASIL ===');
  console.log('transfer selesai :', done);
  console.log('file tersimpan   :', saved);
  console.log('transcode mp4    :', transcoded ? 'OK' : 'GAGAL');
  console.log('kirim .mkv mentah:', original ? 'ADA (transcode gagal)' : 'tidak ada (bagus)');

  const transcodeLog = A.logs.join('').split('\n')
    .filter((l) => /TRANSCODE|FFMPEG/.test(l)).slice(-6);
  console.log('\n--- log transcode server A ---');
  console.log(transcodeLog.join('\n'));

  pageA.child.kill(); pageB.child.kill(); A.kill(); B.kill();
  await sleep(1500);
  for (const dir of [tmpDir, pageA.userDataDir, pageB.userDataDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {}
  }

  const ok = done && transcoded && !original;
  console.log('\n=== ' + (ok ? 'PASS' : 'GAGAL') + ' ===');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
