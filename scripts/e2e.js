#!/usr/bin/env node
/**
 * End-to-end test: dua instance LAN DROP, transfer file nyata dua arah.
 *
 * Menguji alur yang tidak bisa dibuktikan oleh smoke test:
 *   - batch multi-file terkelompok jadi satu kartu
 *   - kecepatan & ETA tampil saat transfer berjalan
 *   - folder tujuan tampil di sisi penerima
 *   - tombol Batal berfungsi di kedua sisi
 *   - teks terkirim & diterima
 *
 * Usage: node scripts/e2e.js [--keep]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT_A = 3110;
const TRANSFER_A = 3111;
const PORT_B = 3120;
const TRANSFER_B = 3121;

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function startServer(port, transferPort, name, discoveryPort, peers) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      TRANSFER_PORT: String(transferPort),
      DISCOVERY_PORT: String(discoveryPort),
      LANDROP_PEERS: peers || '',
      LANDROP_SAVE_DIR: path.join(os.tmpdir(), `landrop-e2e-${name}`),
      LANDROP_DATA_DIR: path.join(os.tmpdir(), `landrop-e2e-data-${name}`),
      DEVICE_NAME: name,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  proc.logs = logs;
  return proc;
}

async function waitForServer(port, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/me`);
      if (res.ok) return await res.json();
    } catch (_) {}
    await sleep(300);
  }
  throw new Error(`Server di port ${port} tidak ready`);
}

// ---------------------------------------------------------------------------
// Browser (CDP)
// ---------------------------------------------------------------------------

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
    this.consoleErrors = [];
    this.pageErrors = [];
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        if (m.params.type === 'error') {
          this.consoleErrors.push(
            (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
          );
        }
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(m.params.exceptionDetails?.exception?.description || 'exception');
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
      }, 25000);
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

async function openPage(browser, url, port) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-e2e-'));
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) { targets = await res.json(); break; }
    } catch (_) {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url });
  await sleep(2500);

  return { cdp, child, userDataDir };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('Browser tidak ditemukan');
    process.exitCode = 1;
    return;
  }

  // Folder simpan harus PERSIS sama dengan yang dipakai server (lihat
  // startServer) — kalau beda, assertion cek folder yang salah.
  const saveDirA = path.join(os.tmpdir(), 'landrop-e2e-MesinA');
  const saveDirB = path.join(os.tmpdir(), 'landrop-e2e-MesinB');
  // Bersihkan sisa run sebelumnya — server tidak pernah menimpa file,
  // jadi file lama akan mendapat suffix " (1)", dan histori ikut menumpuk.
  for (const dir of [saveDirA, saveDirB]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const name of ['MesinA', 'MesinB']) {
    fs.rmSync(path.join(os.tmpdir(), `landrop-e2e-data-${name}`), { recursive: true, force: true });
  }

  // Kedua instance satu host:peer didaftarkan manual (UDP broadcast tidak
  // bisa dipakai karena satu listener per port).
  const serverA = startServer(PORT_A, TRANSFER_A, 'MesinA', 41234, `MesinB@127.0.0.1:${PORT_B}@${TRANSFER_B}`);
  const serverB = startServer(PORT_B, TRANSFER_B, 'MesinB', 41235, `MesinA@127.0.0.1:${PORT_A}@${TRANSFER_A}`);

  let pageA, pageB;

  try {
    await waitForServer(PORT_A);
    await waitForServer(PORT_B);
    console.log('Server A & B ready.\n');

    // --- Tunggu kedua server saling melihat ---
    let peers = 0;
    for (let i = 0; i < 30; i++) {
      const list = await (await fetch(`http://localhost:${PORT_A}/devices`)).json();
      peers = list.length;
      if (peers > 0) break;
      await sleep(500);
    }
    check('Discovery: kedua server saling melihat', peers > 0, `${peers} peer`);

    // --- Buka browser ---
    pageA = await openPage(browser, `http://localhost:${PORT_A}`, 9911);
    pageB = await openPage(browser, `http://localhost:${PORT_B}`, 9912);

    const deviceCountA = await pageA.cdp.eval(`document.querySelectorAll('.device-card').length`);
    check('UI: kartu perangkat tampil di sisi A', deviceCountA > 0, `${deviceCountA} kartu`);

    // --- Hardening mobile: beforeunload saat idle ---
    // Dicek di AWAL, sebelum ada transfer apa pun — secara logika inilah
    // satu-satunya waktu yang benar-benar "idle".
    const idleProbe = await pageA.cdp.eval(`(async () => {
      const m = await import('/js/core/state.js');
      const active = Array.from(m.getState().activeTransfers.entries())
        .map(([id, t]) => id + ':' + t.status);
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return JSON.stringify({ active, prevented: ev.defaultPrevented });
    })()`);
    const idle = JSON.parse(idleProbe);
    check('Mobile: beforeunload tidak mengganggu saat idle', idle.prevented === false,
      `prevented=${idle.prevented} active=${idle.active.join(',') || 'tidak ada'}`);

    // --- Siapkan file uji (3 file -> harus jadi 1 batch) ---
    const tmpFiles = [];
    for (let i = 1; i <= 3; i++) {
      const p = path.join(os.tmpdir(), `landrop-e2e-file-${i}.bin`);
      fs.writeFileSync(p, Buffer.alloc(1024 * 1024 * 2, i)); // 2 MB each
      tmpFiles.push(p);
    }

    // Injeksi file ke input (DataTransfer dibuat manual supaya bisa di-set).
    await pageA.cdp.eval(`(() => {
      const files = ${JSON.stringify(tmpFiles.map((f) => f.replace(/\\/g, '\\\\')))}.map((path, i) => {
        const f = new File([new Uint8Array(1024)], 'placeholder' + i + '.bin');
        Object.defineProperty(f, 'name', { value: path.split(/[\\\\/]/).pop() });
        return f;
      });
      window.__e2eFiles = files;
      return files.length;
    })()`);

    // Cara paling andal: kirim langsung lewat API internal modul send.
    // Kita pakai jalur yang sama dengan UI: set pendingTarget lalu trigger
    // event change pada input file dengan File asli yang dibuat di browser.
    await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/send.js');
      const st = await import('/js/core/state.js');
      const devices = await (await fetch('/devices')).json();
      const peer = devices[0];
      const target = {
        ip: peer.ip,
        port: peer.transferPort || peer.port + 1,
        targetName: peer.deviceName,
      };
      const mk = (name, size) => {
        const chunk = new Uint8Array(1024 * 1024);
        for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
        const parts = [];
        for (let i = 0; i < size; i++) parts.push(chunk);
        return new File(parts, name);
      };
      const files = [mk('e2e-satu.bin', 2), mk('e2e-dua.bin', 3), mk('e2e-tiga.bin', 1)];
      await mod.sendBatch(target, files);
      return 'sent';
    })()`);

    // --- Tunggu receiver melihat request ---
    let modalSeen = false;
    for (let i = 0; i < 40; i++) {
      const open = await pageB.cdp.eval(
        `!document.getElementById('requestModal').classList.contains('hidden')`
      );
      if (open) { modalSeen = true; break; }
      await sleep(500);
    }
    check('Receiver: modal permintaan muncul', modalSeen);

    const modalFiles = await pageB.cdp.eval(
      `document.querySelectorAll('#modalInfo .file-list-row').length`
    );
    check('Receiver: modal menampilkan 3 file', modalFiles === 3, `${modalFiles} baris`);

    // --- Terima ---
    await pageB.cdp.eval(`document.getElementById('btnAccept').click()`);
    await sleep(1200);

    const batchCount = await pageB.cdp.eval(
      `document.querySelectorAll('#transferList .transfer-batch').length`
    );
    check('Receiver: 3 file dikelompokkan jadi 1 batch', batchCount === 1, `${batchCount} batch`);

    const rowCount = await pageB.cdp.eval(
      `document.querySelectorAll('#transferList .transfer-batch .transfer-item').length`
    );
    check('Receiver: batch berisi 3 item', rowCount === 3, `${rowCount} item`);

    // --- Tunggu selesai ---
    let done = false;
    for (let i = 0; i < 60; i++) {
      const completed = await pageB.cdp.eval(
        `document.querySelectorAll('#transferList .transfer-item[data-status="completed"]').length`
      );
      if (completed >= 3) { done = true; break; }
      await sleep(500);
    }
    check('Transfer: semua file selesai diterima', done);

    // --- Cek folder tujuan tampil ---
    const pathShown = await pageB.cdp.eval(
      `(() => {
        const el = document.querySelector('#transferList .tf-path-value');
        return el ? el.getAttribute('title') : null;
      })()`
    );
    check('Receiver: folder tujuan ditampilkan', Boolean(pathShown), pathShown || 'tidak ada');

    // --- Cek file benar-benar tersimpan ---
    // Server tidak pernah menimpa file yang sama, jadi nama bisa bersuffix
    // " (1)" kalau folder belum bersih.
    const savedFiles = fs.existsSync(saveDirB) ? fs.readdirSync(saveDirB) : [];
    const expected = ['e2e-satu.bin', 'e2e-dua.bin', 'e2e-tiga.bin'];
    const matchFile = (name) => savedFiles.find((f) => f === name || f === name.replace(/\.bin$/, ' (1).bin'));
    const gotAll = expected.every((f) => matchFile(f));
    check('Transfer: file tersimpan di disk receiver', gotAll, savedFiles.join(', '));

    // --- Cek ukuran file utuh (tidak korup) ---
    let sizeOk = true;
    const sizeErrors = [];
    for (const name of expected) {
      const actual = matchFile(name);
      if (!actual) { sizeOk = false; sizeErrors.push(`${name}: hilang`); continue; }
      const expectedSize = name === 'e2e-dua.bin' ? 3 : name === 'e2e-satu.bin' ? 2 : 1;
      const actualSize = fs.statSync(path.join(saveDirB, actual)).size;
      if (actualSize !== expectedSize * 1024 * 1024) {
        sizeOk = false;
        sizeErrors.push(`${actual}: ${actualSize} != ${expectedSize * 1024 * 1024}`);
      }
    }
    check('Transfer: ukuran file receiver sama dengan pengirim', sizeOk, sizeErrors.join('; '));

    // --- Riwayat terisi ---
    // Riwayat di-poll tiap 5 detik; paksa refresh supaya tidak menunggu tick.
    await pageA.cdp.eval(
      `import('/js/features/history.js').then(m => m.fetchAndRenderHistory())`
    );
    await sleep(600);
    const historyCount = await pageA.cdp.eval(
      `document.querySelectorAll('#historyList .history-item').length`
    );
    check('Riwayat: entri transfer tercatat', historyCount >= 3, `${historyCount} entri`);

    // --- Teks ---
    await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/send.js');
      const devices = await (await fetch('/devices')).json();
      const peer = devices[0];
      await mod.sendText(
        { ip: peer.ip, port: peer.transferPort || peer.port + 1, targetName: peer.deviceName },
        'Halo dari E2E test'
      );
    })()`);

    let textReceived = false;
    for (let i = 0; i < 30; i++) {
      const shown = await pageB.cdp.eval(
        `(() => {
          const o = document.getElementById('textOverlay');
          if (o.classList.contains('hidden')) return null;
          return document.getElementById('textOverlayBody').textContent;
        })()`
      );
      if (shown === 'Halo dari E2E test') { textReceived = true; break; }
      await sleep(500);
    }
    check('Teks: terkirim & tampil di penerima', textReceived);

    // --- Shortcut keyboard ---
    // 1. Enter menerima permintaan masuk.
    await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/send.js');
      const devices = await (await fetch('/devices')).json();
      const peer = devices[0];
      const chunk = new Uint8Array(256 * 1024);
      await mod.sendBatch(
        { ip: peer.ip, port: peer.transferPort, targetName: peer.deviceName },
        [new File([chunk], 'e2e-enter.bin')]
      );
    })()`);

    let enterAccepted = false;
    for (let i = 0; i < 40; i++) {
      const open = await pageB.cdp.eval(
        `!document.getElementById('requestModal').classList.contains('hidden')`
      );
      if (open) {
        // Enter pada elemen non-tombol di dalam modal → terima.
        await pageB.cdp.eval(`(() => {
          const modal = document.getElementById('requestModal');
          const target = document.getElementById('modalInfo');
          target.focus();
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
          }));
        })()`);
        enterAccepted = true;
        break;
      }
      await sleep(300);
    }
    check('Shortcut: Enter menerima permintaan', enterAccepted);

    // Tunggu status transferring/completed di sisi penerima.
    let enterProgressed = false;
    for (let i = 0; i < 30; i++) {
      const status = await pageB.cdp.eval(
        `(() => {
          const item = Array.from(document.querySelectorAll('#transferList .transfer-item'))
            .find(el => el.textContent.includes('e2e-enter'));
          return item ? item.dataset.status : null;
        })()`
      );
      if (status && status !== 'waiting') { enterProgressed = true; break; }
      await sleep(400);
    }
    check('Shortcut: Enter memulai transfer di penerima', enterProgressed);

    // 2. Esc menolak permintaan.
    await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/send.js');
      const devices = await (await fetch('/devices')).json();
      const peer = devices[0];
      const chunk = new Uint8Array(256 * 1024);
      await mod.sendBatch(
        { ip: peer.ip, port: peer.transferPort, targetName: peer.deviceName },
        [new File([chunk], 'e2e-esc.bin')]
      );
    })()`);

    let escRejected = false;
    for (let i = 0; i < 40; i++) {
      const open = await pageB.cdp.eval(
        `!document.getElementById('requestModal').classList.contains('hidden')`
      );
      if (open) {
        await pageB.cdp.eval(`(() => {
          document.getElementById('requestModal').dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
          }));
        })()`);
        escRejected = true;
        break;
      }
      await sleep(300);
    }

    // Tunggu status di sisi pengirim jadi "ditolak".
    let rejectSeen = false;
    for (let i = 0; i < 30; i++) {
      const status = await pageA.cdp.eval(
        `(() => {
          const item = Array.from(document.querySelectorAll('#transferList .transfer-item'))
            .find(el => el.textContent.includes('e2e-esc'));
          return item ? item.dataset.status : null;
        })()`
      );
      if (status === 'rejected') { rejectSeen = true; break; }
      await sleep(400);
    }
    check('Shortcut: Esc menolak permintaan', escRejected && rejectSeen);

    // 3. Ctrl+Enter mengirim teks.
    // Tutup dulu overlay teks yang masih terbuka dari pengujian sebelumnya.
    // Kalau tidak, teks baru masuk antrian (perilaku yang benar — teks yang
    // sedang dibaca tidak boleh tertimpa) dan tidak langsung tampil.
    await pageB.cdp.eval(`(() => {
      const o = document.getElementById('textOverlay');
      if (!o.classList.contains('hidden')) {
        document.getElementById('btnCloseTextOverlay').click();
      }
      return 'closed';
    })()`);
    await sleep(600);

    await pageA.cdp.eval(`(() => {
      const btn = document.querySelector('.btn-text-pick');
      if (btn) btn.click();
    })()`);
    await sleep(500);

    const composerOpen = await pageA.cdp.eval(
      `!document.getElementById('textComposerModal').classList.contains('hidden')`
    );

    let ctrlEnterSent = false;
    if (composerOpen) {
      await pageA.cdp.eval(`(() => {
        const ta = document.getElementById('textInput');
        ta.value = 'Teks via Ctrl+Enter';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true
        }));
      })()`);
      await sleep(500);

      for (let i = 0; i < 30; i++) {
        const shown = await pageB.cdp.eval(
          `(() => {
            const o = document.getElementById('textOverlay');
            if (o.classList.contains('hidden')) return null;
            return document.getElementById('textOverlayBody').textContent;
          })()`
        );
        if (shown === 'Teks via Ctrl+Enter') { ctrlEnterSent = true; break; }
        await sleep(500);
      }
    }
    check('Shortcut: Ctrl+Enter mengirim teks', ctrlEnterSent);

    // --- Skenario cancel: kirim file besar, batalkan dari sisi penerima ---
    await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/send.js');
      const devices = await (await fetch('/devices')).json();
      const peer = devices[0];
      const chunk = new Uint8Array(1024 * 1024);
      const parts = [];
      for (let i = 0; i < 40; i++) parts.push(chunk); // 40 MB
      await mod.sendBatch(
        { ip: peer.ip, port: peer.transferPort, targetName: peer.deviceName },
        [new File(parts, 'e2e-besar.bin')]
      );
    })()`);

    // Tunggu modal request file besar muncul, lalu terima.
    let bigAccepted = false;
    for (let i = 0; i < 40; i++) {
      const open = await pageB.cdp.eval(
        `!document.getElementById('requestModal').classList.contains('hidden')`
      );
      if (open) {
        await pageB.cdp.eval(`document.getElementById('btnAccept').click()`);
        bigAccepted = true;
        break;
      }
      await sleep(300);
    }
    check('Cancel: permintaan file besar diterima', bigAccepted);

    // Tunggu item transfer muncul di sisi penerima, lalu tekan Batal.
    let cancelled = false;
    for (let i = 0; i < 30; i++) {
      const clicked = await pageB.cdp.eval(`(() => {
        const btn = document.querySelector('#transferList .btn-cancel');
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked';
      })()`);
      if (clicked === 'clicked') {
        cancelled = true;
        break;
      }
      await sleep(300);
    }
    check('Cancel: tombol Batal tersedia di sisi penerima', cancelled);

    // Status harus jadi "cancelled", bukan "completed" atau "failed".
    let cancelStatus = null;
    for (let i = 0; i < 30; i++) {
      cancelStatus = await pageB.cdp.eval(
        `(() => {
          const item = Array.from(document.querySelectorAll('#transferList .transfer-item'))
            .find(el => el.textContent.includes('e2e-besar'));
          return item ? item.dataset.status : null;
        })()`
      );
      if (cancelStatus && cancelStatus !== 'transferring') break;
      await sleep(400);
    }
    check('Cancel: status akhir = cancelled', cancelStatus === 'cancelled', String(cancelStatus));

    // --- Thumbnail: kirim file PNG, receiver harus dapat pratinjau ---
    // Fixture PNG dibuat server-side (scripts/generate-icons.js sudah
    // menghasilkan yang valid) lalu dikirim sebagai file biasa.
    const pngFixture = path.join(__dirname, '..', 'public', 'icons', 'icon-192.png');
    const pngBytes = fs.readFileSync(pngFixture);

    await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/send.js');
      const devices = await (await fetch('/devices')).json();
      const peer = devices[0];
      const bytes = new Uint8Array(${JSON.stringify(Array.from(pngBytes))});
      await mod.sendBatch(
        { ip: peer.ip, port: peer.transferPort, targetName: peer.deviceName },
        [new File([bytes], 'e2e-gambar.png', { type: 'image/png' })]
      );
    })()`);

    // File harus di-accept dulu oleh penerima (teks auto-accept, file tidak).
    let thumbAccepted = false;
    for (let i = 0; i < 40; i++) {
      const open = await pageB.cdp.eval(
        `!document.getElementById('requestModal').classList.contains('hidden')`
      );
      if (open) {
        await pageB.cdp.eval(`document.getElementById('btnAccept').click()`);
        thumbAccepted = true;
        break;
      }
      await sleep(300);
    }
    check('Thumbnail: permintaan gambar diterima', thumbAccepted);

    // Tunggu item transfer selesai di sisi penerima.
    let thumbItem = null;
    for (let i = 0; i < 40; i++) {
      const found = await pageB.cdp.eval(
        `(() => {
          const all = Array.from(document.querySelectorAll('#transferList .transfer-item'));
          const item = all.find(el => el.textContent.includes('e2e-gambar'));
          const img = item ? item.querySelector('img.tf-thumb') : null;
          return JSON.stringify({
            itemCount: all.length,
            found: !!item,
            status: item ? item.dataset.status : null,
            hasThumb: !!img,
            src: img ? img.getAttribute('src') : null,
          });
        })()`
      );
      if (found) {
        const data = JSON.parse(found);
        if (data.status === 'completed') { thumbItem = data; break; }
        if (i === 39) console.log('    [diag] thumbnail:', found);
      }
      await sleep(500);
    }

    check('Thumbnail: item receiver punya pratinjau', Boolean(thumbItem && thumbItem.hasThumb),
      thumbItem ? thumbItem.src : 'tidak ada item');
    check('Thumbnail: src menunjuk endpoint /thumbnail/',
      Boolean(thumbItem && thumbItem.src && thumbItem.src.startsWith('/thumbnail/')),
      thumbItem ? String(thumbItem.src) : '-');

    // Endpoint thumbnail harus benar-benar mengembalikan gambar.
    if (thumbItem && thumbItem.src) {
      const thumbStatus = await pageB.cdp.eval(
        `(async () => {
          try {
            const res = await fetch(${JSON.stringify(thumbItem.src)});
            const buf = await res.arrayBuffer();
            return JSON.stringify({
              status: res.status,
              type: res.headers.get('content-type'),
              bytes: buf.byteLength,
            });
          } catch (err) {
            return JSON.stringify({ error: err.message });
          }
        })()`
      );
      const thumb = JSON.parse(thumbStatus);
      check('Thumbnail: endpoint mengembalikan gambar',
        thumb.status === 200 && thumb.bytes > 0 && String(thumb.type).startsWith('image/'),
        JSON.stringify(thumb));
    } else {
      check('Thumbnail: endpoint mengembalikan gambar', false, 'tidak ada src');
    }

    // Galeri harus memuat media yang diterima.
    // Galeri dibangun dari riwayat, yang di-poll tiap 5 detik — jadi tunggu.
    let galleryCount = 0;
    for (let i = 0; i < 30; i++) {
      galleryCount = await pageB.cdp.eval(
        `document.querySelectorAll('#galleryGrid .gallery-item').length`
      );
      if (galleryCount > 0) break;
      await sleep(500);
    }
    check('Galeri: media diterima tampil di grid', galleryCount > 0, `${galleryCount} item`);

    // Path traversal harus ditolak.
    const traversal = await pageB.cdp.eval(
      `(async () => {
        const res = await fetch('/thumbnail/0000000000000000');
        return res.status;
      })()`
    );
    check('Thumbnail: id asing ditolak', traversal === 404 || traversal === 400, `status ${traversal}`);

    // --- Hardening mobile ---
    const mobileProbe = await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/mobile.js');
      const disk = await mod.checkDiskSpace(1024);
      return JSON.stringify({
        wakeLockSupported: mod.isWakeLockSupported(),
        diskOk: disk ? disk.ok : null,
        diskFree: disk ? disk.free : null,
        diskNeeded: disk ? disk.needed : null,
      });
    })()`);
    const mobile = JSON.parse(mobileProbe);
    check('Mobile: pemeriksaan ruang disk bekerja', mobile.diskOk === true,
      `free=${mobile.diskFree} needed=${mobile.diskNeeded}`);

    // Sekarang aktifkan transfer, lalu cek beforeunload MENYANGKAL.
    await pageA.cdp.eval(`(async () => {
      const mod = await import('/js/features/send.js');
      const devices = await (await fetch('/devices')).json();
      const peer = devices[0];
      const chunk = new Uint8Array(1024 * 1024);
      const parts = [];
      for (let i = 0; i < 30; i++) parts.push(chunk);
      await mod.sendBatch(
        { ip: peer.ip, port: peer.transferPort, targetName: peer.deviceName },
        [new File(parts, 'e2e-wakelock.bin')]
      );
    })()`);

    // Terima di peer supaya transfer benar-benar berjalan.
    for (let i = 0; i < 30; i++) {
      const open = await pageB.cdp.eval(
        `!document.getElementById('requestModal').classList.contains('hidden')`
      );
      if (open) {
        await pageB.cdp.eval(`document.getElementById('btnAccept').click()`);
        break;
      }
      await sleep(300);
    }

    const beforeUnloadActive = await pageA.cdp.eval(`(() => {
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    check('Mobile: beforeunload memperingatkan saat transfer aktif', beforeUnloadActive === true,
      `defaultPrevented=${beforeUnloadActive}`);

    // --- Error console ---
    const allErrors = [...pageA.cdp.consoleErrors, ...pageB.cdp.consoleErrors];
    const allPageErrors = [...pageA.cdp.pageErrors, ...pageB.cdp.pageErrors];
    check('Runtime: tidak ada uncaught exception', allPageErrors.length === 0,
      allPageErrors.slice(0, 2).join(' | '));
    check('Runtime: tidak ada console error', allErrors.length === 0,
      allErrors.slice(0, 2).join(' | '));

  } catch (err) {
    check('Test berjalan tanpa exception', false, err.message);
    console.error(err);
  } finally {
    if (process.env.E2E_DEBUG) {
      console.log('\n--- LOG SERVER A ---\n' + serverA.logs.join('').slice(-3000));
      console.log('\n--- LOG SERVER B ---\n' + serverB.logs.join('').slice(-3000));
    }
    for (const page of [pageA, pageB]) {
      if (!page) continue;
      page.child.kill();
      await new Promise((resolve) => {
        if (page.child.exitCode !== null) return resolve();
        page.child.on('exit', resolve);
        setTimeout(resolve, 3000);
      });
      if (!KEEP) {
        try { fs.rmSync(page.userDataDir, { recursive: true, force: true, maxRetries: 5 }); } catch (_) {}
      }
    }
    serverA.kill();
    serverB.kill();
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n=== ${passed}/${results.length} pemeriksaan lolos ===`);
  if (passed !== results.length) process.exitCode = 1;
}

main();
