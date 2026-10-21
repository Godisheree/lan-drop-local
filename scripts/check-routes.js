#!/usr/bin/env node
/**
 * Tes 2 instance sungguhan di SEMUA jalur jaringan yang tersedia.
 *
 * Satu mesin punya tiga interface: loopback (127.0.0.1), WiFi/LAN
 * (192.168.x.x), dan Tailscale (100.x.x.x). Ketiganya benar-benar ada, jadi
 * transfer diuji lewat jalur yang nyata - bukan mock.
 *
 * Yang diuji per jalur:
 *   1. Transfer FILE dua arah (A->B dan B->A) - file beneran terkirim,
 *      ukurannya cocok, isinya identik di folder tujuan penerima.
 *   2. Transfer TEKS dua arah.
 *   3. File TIDAK mendarat di server pengirim (regresi bug "localhost":
 *      peer yang alamatnya 'localhost' bikin kiriman balik ke mesin sendiri).
 *
 * Jalur yang tidak tersedia di mesin ini (mis. Tailscale belum terpasang)
 * di-skip dengan jelas, bukan dianggap lulus.
 *
 * Usage: node scripts/check-routes.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { listLANIPv4 } = require(path.join(ROOT, 'server', 'platform.js'));
const { getSelfTailscaleIP } = require(path.join(ROOT, 'server', 'tailscale.js'));

let failures = 0;
let skipped = 0;

function check(name, passed, detail = '') {
  if (passed) {
    console.log(`  PASS  ${name}${detail ? ' - ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' - ' + detail : ''}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`  SKIP  ${name} - ${why}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      if (startPort < 65000) resolve(findFreePort(startPort + 1));
      else reject(new Error('Tidak ada port bebas'));
    });
  });
}

function startServer(port, transferPort, name, discoveryPort, saveDir) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TRANSFER_PORT: String(transferPort),
      DISCOVERY_PORT: String(discoveryPort),
      LANDROP_SAVE_DIR: saveDir,
      LANDROP_DATA_DIR: path.join(os.tmpdir(), `landrop-routes-data-${name}`),
      // Dua instance di 127.0.0.1 - izinkan target self (dipakai test ini).
      LANDROP_ALLOW_SELF_TARGET: '1',
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
      const res = await fetch(`http://127.0.0.1:${port}/me`);
      if (res.ok) return await res.json();
    } catch (_) {}
    await sleep(300);
  }
  throw new Error(`Server di port ${port} tidak ready`);
}

// ---------------------------------------------------------------------------
// Helper transfer
// ---------------------------------------------------------------------------

async function getJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  if (!res.ok) {
    const message = (body && body.error) ? body.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

/**
 * Upload file ke server dan kembalikan path server-side-nya.
 */
async function uploadFile(port, name, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  const res = await fetch(`http://127.0.0.1:${port}/transfer/upload`, { method: 'POST', body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.files[0];
}

/**
 * Kirim file dari instance `from` ke instance `to` lewat alamat tertentu.
 */
async function transferFile(from, to, targetIp, targetTransferPort, fileName, content) {
  const uploaded = await uploadFile(from.port, fileName, content);

  const { requestId } = await getJson(`http://127.0.0.1:${from.port}/transfer/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetIp,
      targetPort: targetTransferPort,
      fileName,
      fileSize: content.length,
    }),
  });

  // Penerima harus menyetujui (kalau belum, tunggu).
  let accepted = false;
  for (let i = 0; i < 40; i++) {
    const pending = await getJson(`http://127.0.0.1:${to.port}/transfer/pending`);
    const req = pending.find((p) => p.fileName === fileName && p.status === 'pending');
    if (req) {
      await getJson(`http://127.0.0.1:${to.port}/transfer/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: req.requestId, accept: true }),
      });
      accepted = true;
      break;
    }
    await sleep(150);
  }
  if (!accepted) throw new Error('Penerima tidak menampilkan permintaan');

  // Tunggu status accepted di sisi pengirim.
  for (let i = 0; i < 40; i++) {
    const status = await getJson(`http://127.0.0.1:${from.port}/transfer/status/${requestId}`);
    if (status.status === 'accepted') break;
    if (status.status === 'rejected') throw new Error('Permintaan ditolak');
    await sleep(150);
  }

  await getJson(`http://127.0.0.1:${from.port}/transfer/send-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, filePath: uploaded.filePath }),
  });

  // Tunggu selesai di sisi pengirim.
  for (let i = 0; i < 80; i++) {
    const progress = await getJson(`http://127.0.0.1:${from.port}/transfer/progress/${requestId}`);
    if (progress.status === 'completed') return { requestId, uploaded };
    if (progress.status === 'failed' || progress.status === 'cancelled') {
      throw new Error(`Transfer ${progress.status}`);
    }
    await sleep(150);
  }
  throw new Error('Transfer tidak selesai dalam waktu batas');
}

/**
 * Kirim teks dari `from` ke `to` lewat alamat tertentu.
 */
async function transferText(from, to, targetIp, targetTransferPort, text) {
  const { requestId } = await getJson(`http://127.0.0.1:${from.port}/transfer/request-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetIp, targetPort: targetTransferPort, fileName: 'Teks' }),
  });

  // Teks langsung diterima tanpa modal.
  for (let i = 0; i < 40; i++) {
    const status = await getJson(`http://127.0.0.1:${from.port}/transfer/status/${requestId}`);
    if (status.status === 'accepted') break;
    await sleep(150);
  }

  await getJson(`http://127.0.0.1:${from.port}/transfer/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, text }),
  });

  for (let i = 0; i < 40; i++) {
    const texts = await getJson(`http://127.0.0.1:${to.port}/transfer/text`);
    const found = texts.find((t) => t.text === text);
    if (found) {
      await getJson(`http://127.0.0.1:${to.port}/transfer/text/${found.id}/ack`, { method: 'POST' });
      return true;
    }
    await sleep(150);
  }
  throw new Error('Teks tidak diterima');
}

// ---------------------------------------------------------------------------
// Skenario per jalur
// ---------------------------------------------------------------------------

function listSavedFiles(saveDir) {
  try {
    return fs.readdirSync(saveDir).map((f) => path.join(saveDir, f));
  } catch (_) {
    return [];
  }
}

function clearDir(dir) {
  for (const f of listSavedFiles(dir)) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

async function runRoute(label, a, b, targetIp, procs) {
  console.log(`\n[${label}] ${targetIp}`);

  const dumpLogs = () => {
    for (const [name, proc] of Object.entries(procs || {})) {
      const lines = proc.logs.join('').split('\n').filter(Boolean).slice(-14);
      if (lines.length) {
        console.log(`    --- log ${name} ---`);
        lines.forEach((l) => console.log('    ' + l));
      }
    }
  };

  clearDir(a.saveDir);
  clearDir(b.saveDir);

  const content = Buffer.from(`LAN DROP route test ${label} ${Date.now()} - isi file harus sama persis.`);

  // --- A -> B (file) ---
  try {
    await transferFile(a, b, targetIp, b.transferPort, `route-${label}.txt`, content);
    await sleep(700);

    const received = listSavedFiles(b.saveDir).filter((f) => f.endsWith(`route-${label}.txt`));
    check(`${label}: file A->B diterima`, received.length === 1, `jumlah file: ${received.length}`);
    if (received.length === 1) {
      const saved = fs.readFileSync(received[0]);
      check(`${label}: isi file A->B identik`, saved.equals(content),
        `terkirim ${content.length} B, tersimpan ${saved.length} B`);
    } else {
      dumpLogs();
    }

    // Regresi bug "localhost": file harus TIDAK mendarat di server pengirim.
    const landedAtSender = listSavedFiles(a.saveDir).some((f) => f.endsWith(`route-${label}.txt`));
    check(`${label}: file tidak mendarat di server pengirim`, !landedAtSender,
      landedAtSender ? 'MENDARAT DI PENGIRIM - bug localhost belum beres' : '');
  } catch (err) {
    check(`${label}: file A->B diterima`, false, err.message);
    dumpLogs();
  }

  // --- B -> A (file) ---
  try {
    const content2 = Buffer.from(`balik ${label} ${Date.now()}`);
    await transferFile(b, a, targetIp, a.transferPort, `route-balik-${label}.txt`, content2);
    await sleep(700);

    const received = listSavedFiles(a.saveDir).filter((f) => f.endsWith(`route-balik-${label}.txt`));
    check(`${label}: file B->A diterima`, received.length === 1, `jumlah file: ${received.length}`);
    if (received.length === 1) {
      const saved = fs.readFileSync(received[0]);
      check(`${label}: isi file B->A identik`, saved.equals(content2),
        `terkirim ${content2.length} B, tersimpan ${saved.length} B`);
    } else {
      dumpLogs();
    }
  } catch (err) {
    check(`${label}: file B->A diterima`, false, err.message);
    dumpLogs();
  }

  // --- teks dua arah ---
  try {
    const text = `halo dari ${label} ${Date.now()}`;
    await transferText(a, b, targetIp, b.transferPort, text);
    check(`${label}: teks A->B diterima`, true);
  } catch (err) {
    check(`${label}: teks A->B diterima`, false, err.message);
  }

  try {
    const text = `balik teks ${label} ${Date.now()}`;
    await transferText(b, a, targetIp, a.transferPort, text);
    check(`${label}: teks B->A diterima`, true);
  } catch (err) {
    check(`${label}: teks B->A diterima`, false, err.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const portA = await findFreePort(3300);
  const transferA = await findFreePort(3310);
  const portB = await findFreePort(3320);
  const transferB = await findFreePort(3330);
  const discoveryA = await findFreePort(3400);
  const discoveryB = await findFreePort(3410);

  const saveA = path.join(os.tmpdir(), 'landrop-routes-A');
  const saveB = path.join(os.tmpdir(), 'landrop-routes-B');
  for (const dir of [saveA, saveB]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  const procA = startServer(portA, transferA, 'MesinA', discoveryA, saveA);
  const procB = startServer(portB, transferB, 'MesinB', discoveryB, saveB);
  const procs = { A: procA, B: procB };

  try {
    await waitForServer(portA);
    await waitForServer(portB);

    const a = { port: portA, transferPort: transferA, saveDir: saveA };
    const b = { port: portB, transferPort: transferB, saveDir: saveB };

    // 1. Loopback
    await runRoute('loopback', a, b, '127.0.0.1', procs);

    // 2. WiFi / LAN
    const lan = listLANIPv4()[0];
    if (lan) {
      await runRoute('wifi', a, b, lan.address, procs);
    } else {
      skip('wifi: file & teks dua arah', 'tidak ada interface LAN di mesin ini');
    }

    // 3. Tailscale
    const ts = getSelfTailscaleIP();
    if (ts) {
      await runRoute('tailscale', a, b, ts, procs);
    } else {
      skip('tailscale: file & teks dua arah', 'Tailscale tidak aktif / alamat tidak terdeteksi');
    }
  } finally {
    procA.kill();
    procB.kill();
    await sleep(300);
  }

  console.log(
    failures === 0
      ? `\nOK - semua jalur lolos${skipped ? ` (${skipped} dilewati karena interface tidak tersedia)` : ''}.`
      : `\nGAGAL - ${failures} pemeriksaan gagal.`
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
