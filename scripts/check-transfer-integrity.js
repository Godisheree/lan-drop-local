#!/usr/bin/env node
/**
 * Regression check integritas transfer.
 *
 * Semua bug di bawah pernah terjadi dan sempat terbukti lewat uji langsung:
 *
 *   1. Resume dua file BERBEDA yang namanya sama → file campuran A/B yang
 *      dilaporkan "berhasil". Kunci resume lama hanya nama+ukuran.
 *   2. Pengirim menutup socket (FIN) → `.landrop-part` dihapus, resume hilang
 *      untuk kegagalan yang paling sering terjadi.
 *   3. Prefix frame 4 GB diterima → memori penerima naik tanpa batas.
 *   4. Teks dianggap terkirim begitu socket ditutup, tanpa konfirmasi.
 *   5. Entri progres tidak pernah dibuang saat sukses.
 *   6. Nama file "(n)" dipilih dengan existsSync lalu ditulis belakangan
 *      (TOCTOU) → dua pengirim bisa saling menimpa.
 *
 * Usage: node scripts/check-transfer-integrity.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.LANDROP_DEBUG = '1';

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const source = read('server/transfer.js');

const transfer = require(path.join(ROOT, 'server/transfer'));

let failures = 0;
let passes = 0;

function check(label, fn) {
  try {
    fn();
    passes++;
    console.log(`  OK   ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label}`);
    if (err && err.message) console.log(`       ${err.message}`);
  }
}

// ── 1. Kunci resume adalah identitas file, bukan tebakan ──────────────────
check('resumeId berbeda → kunci berbeda (nama & ukuran sama)', () => {
  const a = transfer.makeTransferKey('sender1', 'resume-A', 'laporan.bin', 1000);
  const b = transfer.makeTransferKey('sender1', 'resume-B', 'laporan.bin', 1000);
  assert.notStrictEqual(a, b, 'dua file berbeda akan disambung jadi satu');
});

check('pengirim berbeda → kunci berbeda', () => {
  const a = transfer.makeTransferKey('sender1', 'r', 'a.txt', 10);
  const b = transfer.makeTransferKey('sender2', 'r', 'a.txt', 10);
  assert.notStrictEqual(a, b);
});

check('identitas sama (kirim ulang) → kunci sama, resume jalan', () => {
  const a = transfer.makeTransferKey('sender1', 'r', 'a.txt', 10);
  const b = transfer.makeTransferKey('sender1', 'r', 'a.txt', 10);
  assert.strictEqual(a, b);
});

check('kunci resume panjangnya tetap (aman buat nama file meta)', () => {
  const key = transfer.makeTransferKey('s', 'r', 'x'.repeat(300), 1);
  assert.match(key, /^[0-9a-f]{16}$/);
});

// ── 2. Klaim nama file atomik ─────────────────────────────────────────────
check('nama yang sudah ada dilewati, bukan ditimpa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-claim-'));
  try {
    fs.writeFileSync(path.join(dir, 'foto.jpg'), 'lama');
    const claimed = transfer.claimPartPath(dir, 'foto.jpg');
    assert.ok(claimed, 'tidak dapat nama sama sekali');
    assert.strictEqual(path.basename(claimed.finalPath), 'foto (1).jpg');
    assert.strictEqual(path.basename(claimed.partPath), 'foto (1).jpg.landrop-part');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('klaim kedua tidak mendapat nama yang sama (O_EXCL)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-claim-'));
  try {
    const first = transfer.claimPartPath(dir, 'video.mp4');
    const second = transfer.claimPartPath(dir, 'video.mp4');
    assert.notStrictEqual(first.partPath, second.partPath, 'dua pengirim dapat nama yang sama');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. Batas frame & teks ─────────────────────────────────────────────────
check('MAX_TEXT_BYTES terdefinisi dan wajar', () => {
  assert.strictEqual(typeof transfer.MAX_TEXT_BYTES, 'number');
  assert.ok(transfer.MAX_TEXT_BYTES > 0 && transfer.MAX_TEXT_BYTES <= 8 * 1024 * 1024,
    `batas teks: ${transfer.MAX_TEXT_BYTES}`);
});

check('pembaca frame file-start memakai batas frame', () => {
  const start = source.indexOf('function startRawReceive');
  assert.ok(start > -1, 'startRawReceive hilang');
  const body = source.slice(start, start + 6000);
  assert.ok(/MAX_FRAME_BYTES/.test(body), 'pembaca frame file-start tanpa batas → OOM');
});

check('panjang teks divalidasi sebagai integer, bukan `|| Infinity`', () => {
  assert.ok(/Number\.isInteger\(textLength\)/.test(source), 'validasi panjang teks hilang');
  assert.ok(/MAX_TEXT_BYTES/.test(source));
});

check('penerima mengirim ACK text-saved', () => {
  assert.ok(source.includes("'text-saved'"), 'tanpa ACK, teks "terkirim" cuma asumsi');
});

// ── 4. FIN bukan pembatalan ───────────────────────────────────────────────
check('penutupan socket pengirim tidak menghapus partial', () => {
  const closeHandler = source.slice(
    source.indexOf("socket.on('close', () => {"),
    source.indexOf("socket.on('close', () => {") + 1400
  );
  assert.ok(!/peerEnded/.test(closeHandler), 'FIN masih diperlakukan sebagai batal');
  assert.ok(/req\.cancelledByUser/.test(closeHandler), 'pembatalan eksplisit harus tetap membuang partial');
  assert.ok(/persistPart\(true\)/.test(closeHandler), 'partial tidak disimpan saat putus');
});

// ── 5. State & koneksi tidak tumbuh selamanya ─────────────────────────────
check('entri transfer lama dibuang oleh sweeper', () => {
  assert.strictEqual(typeof transfer.sweepFinishedTransfers, 'function');
});

check('koneksi masuk dibatasi + ada idle timeout', () => {
  assert.ok(/maxConnections\s*=/.test(source), 'tanpa batas koneksi, fd bisa habis');
  assert.ok(/setTimeout\(CONNECTION_IDLE_TIMEOUT\)/.test(source), 'socket diam menahan slot selamanya');
});

check('pembersihan upload berjalan berkala, bukan cuma saat start', () => {
  assert.ok(/setInterval\(cleanupStale, STALE_CLEANUP_INTERVAL\)/.test(source));
});

// ── 6. Auto-approve tidak bisa dipalsukan dengan nama saja ────────────────
check('auto-approve mencocokkan alamat, bukan cuma nama pengirim', () => {
  const fn = source.slice(source.indexOf('function decideAutoAccept'), source.indexOf('function decideAutoAccept') + 900);
  assert.ok(/senderIp/.test(fn), 'nama pengirim bisa disamarkan');
  assert.ok(/isAutoApprovePeer\(\s*msg\.senderName,\s*senderIp/.test(fn), 'alamat tidak ikut dicocokkan');
});

// ── Ringkasan ─────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? `\n✅ ${passes} pemeriksaan integritas transfer lolos.`
    : `\n❌ ${failures} pemeriksaan integritas transfer gagal.`
);
process.exitCode = failures > 0 ? 1 : 0;