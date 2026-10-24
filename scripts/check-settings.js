#!/usr/bin/env node
/**
 * Uji persistensi setting (dan riwayat) saat proses berhenti mendadak.
 *
 * Kenapa skrip terpisah dari check-autoapprove.js? Yang diuji di sini bukan
 * keputusan terima otomatis, melainkan satu hal spesifik yang gampang rusak:
 * **nilai yang diubah user harus sudah ada di disk sebelum proses mati.**
 *
 * Tulisannya dulu di-debounce 300 ms (batch riwayat memang perlu itu). Efeknya
 * setting hilang kalau user menekan Ctrl+C — atau menutup jendela Electron —
 * dalam 300 ms setelah mengklik toggle. Proses yang sudah `process.exit()`
 * tidak pernah menjalankan timer yang belum jatuh tempo.
 *
 * Tiap kasus dijalankan di proses anak terpisah yang MATI SEGERA setelah
 * mengubah nilai, jadi hasilnya tidak tergantung kecepatan mesin.
 *
 * Usage: node scripts/check-settings.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Jalankan potongan kode di proses NODE terpisah, dengan data dir sementara,
 * lalu mati segera (tanpa menunggu timer apa pun).
 */
function runAndDie(code, dataDir) {
  const res = spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { ...process.env, LANDROP_DATA_DIR: dataDir },
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    throw new Error(`Proses anak gagal: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) {
    return null;
  }
}

const settingsPath = (dir) => path.join(dir, 'settings.json');
const historyPath = (dir) => path.join(dir, 'history.json');
const SETTINGS = `require(${JSON.stringify(path.join(ROOT, 'server', 'settings.js'))})`;
const HISTORY = `require(${JSON.stringify(path.join(ROOT, 'server', 'history.js'))})`;

// ---------------------------------------------------------------------------

// 1. Toggle ON lalu proses langsung berhenti (Ctrl+C / tutup jendela).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-settings-'));
  runAndDie(
    `${SETTINGS}.setAutoApprove({ enabled: true, peers: ['CPH2579'] }); process.exit(0);`,
    dir
  );
  const raw = readJson(settingsPath(dir));
  check(
    'toggle nyala tersimpan walau proses langsung berhenti',
    raw && raw.autoApprove && raw.autoApprove.enabled === true,
    raw ? JSON.stringify(raw.autoApprove) : 'settings.json belum ditulis'
  );
  check(
    'allowlist peer ikut tersimpan',
    raw && Array.isArray(raw.autoApprove.peers) && raw.autoApprove.peers.join(',') === 'CPH2579'
  );

  // 2. "Restart": proses baru baca nilai yang sama.
  const back = runAndDie(`console.log(JSON.stringify(${SETTINGS}.getAutoApprove()));`, dir);
  let parsed = null;
  try {
    parsed = JSON.parse(back);
  } catch (_) {}
  check(
    'terbaca lagi setelah restart',
    parsed && parsed.enabled === true && parsed.peers.join(',') === 'CPH2579',
    back
  );

  // 3. Toggle OFF juga harus langsung mendarat.
  runAndDie(`${SETTINGS}.setAutoApprove({ enabled: false }); process.exit(0);`, dir);
  const off = readJson(settingsPath(dir));
  check(
    'toggle mati juga tersimpan',
    off && off.autoApprove.enabled === false && off.autoApprove.peers.join(',') === 'CPH2579'
  );

  // 4. Nilai kotor dibersihkan sebelum ditulis, bukan sesudah dibaca.
  runAndDie(
    `${SETTINGS}.setAutoApprove({ peers: ['  HP  ', '', '   ', 'Laptop'] }); process.exit(0);`,
    dir
  );
  const clean = readJson(settingsPath(dir));
  const peers = clean && clean.autoApprove ? clean.autoApprove.peers : null;
  check(
    'peer kosong/spasi dibuang, yang sah dipertahankan',
    peers && peers.length === 2 && peers[0] === 'HP' && peers[1] === 'Laptop',
    peers ? JSON.stringify(peers) : 'null'
  );

  // 5. Riwayat: di-debounce 300 ms (batch transfer bisa memicu banyak entri),
  // jadi jalur yang benar adalah flush saat proses berhenti rapi — persis yang
  // dilakukan shutdown() di server/index.js dan before-quit di main.js.
  runAndDie(
    `${HISTORY}.add({ fileName: 'foto.jpg', direction: 'receive', status: 'completed' }); ` +
      `${HISTORY}.flushNow(); process.exit(0);`,
    dir
  );
  const hist = readJson(historyPath(dir));
  check(
    'riwayat tertulis saat proses berhenti rapi (shutdown)',
    Array.isArray(hist) && hist.length === 1 && hist[0].fileName === 'foto.jpg',
    Array.isArray(hist) ? `${hist.length} entri` : 'history.json belum ditulis'
  );

  // 6. Penjaga regresi: flush itu harus benar-benar dipanggil di jalur keluar.
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf-8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
  check(
    'shutdown() memanggil history.flushNow()',
    /history\.flushNow\(\)/.test(indexSrc)
  );
  check(
    "Electron 'before-quit' memanggil history.flushNow()",
    /before-quit[\s\S]{0,200}flushNow\(\)/.test(mainSrc)
  );
  check(
    'setting auto-approve ditulis segera, bukan lewat timer',
    !/flushTimer/.test(fs.readFileSync(path.join(ROOT, 'server', 'settings.js'), 'utf-8'))
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `\n${results.length}/${results.length} pemeriksaan lolos.`
    : `\n${results.length - failed}/${results.length} lolos, ${failed} GAGAL.`
);
process.exitCode = failed === 0 ? 0 : 1;
