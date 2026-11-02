#!/usr/bin/env node
/**
 * Penjaga urutan alur kirim: MINTA IZIN DULU, upload belakangan.
 *
 * Kenapa perlu dikunci: urutan ini gampang balik lagi tanpa sadar. Dulu
 * `sendBatch()` meng-upload seluruh file dulu, baru mengirim permintaan. Untuk
 * video 2 GB artinya penerima baru dapat dialog "Terima?" setelah semua byte
 * kepindah, dan penolakan membuang upload itu percuma. Perilakunya sendiri
 * diuji di `check-autoapprove.js` (jeda ACC → file-start), tapi urutan di sisi
 * klien hanya bisa dijaga di sini karena berjalan di browser.
 *
 * Usage: node scripts/check-send-flow.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEND_JS = path.join(ROOT, 'public', 'js', 'features', 'send.js');
const TRANSFER_JS = path.join(ROOT, 'server', 'transfer.js');

let failures = 0;

function check(name, passed, detail = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!passed) failures++;
}

/** Ambil badan satu fungsi dari sumber (cukup untuk pemeriksaan statis). */
function functionBody(source, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) return '';
  const start = source.indexOf('{', m.index + m[0].length - 1);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

const sendSrc = fs.readFileSync(SEND_JS, 'utf-8');
const transferSrc = fs.readFileSync(TRANSFER_JS, 'utf-8');

console.log('\n[1] Urutan di klien (public/js/features/send.js)');

const batch = functionBody(sendSrc, 'sendBatch');
check('sendBatch() ditemukan', batch.length > 0);

const idxRequest = batch.indexOf("'/transfer/request'");
const idxUpload = batch.indexOf('uploadFiles(');
check('sendBatch() mengirim permintaan lebih dulu daripada meng-upload',
  idxRequest !== -1 && (idxUpload === -1 || idxRequest < idxUpload),
  `request@${idxRequest} upload@${idxUpload === -1 ? 'tidak dipanggil di sini' : idxUpload}`);

const accept = functionBody(sendSrc, 'waitForAccept');
check('waitForAccept() memanggil uploadThenStart() setelah ACC',
  accept.indexOf('uploadThenStart(item') !== -1);

const thenStart = functionBody(sendSrc, 'uploadThenStart');
check('uploadThenStart() meng-upload file', thenStart.indexOf('uploadFiles(') !== -1);
check('uploadThenStart() memulai streaming lewat /transfer/send-file',
  thenStart.indexOf("'/transfer/send-file'") !== -1);

// Permintaan yang sudah di-ACC lalu ditinggal harus ditutup, bukan menggantung.
check('upload yang dibatalkan menutup permintaan di server',
  thenStart.indexOf('/transfer/cancel/') !== -1);

console.log('\n[2] Penerima harus sabar menunggu upload');

const rawReceive = functionBody(transferSrc, 'startRawReceive');
check('startRawReceive() tidak memasang timeout socket',
  rawReceive.length > 0 && !/socket\.setTimeout\s*\(/.test(rawReceive),
  'timeout di sini akan memutus kiriman besar yang upload-nya lama');

console.log(`\n${failures === 0 ? 'OK' : 'GAGAL'}  ${failures === 0 ? 'Alur kirim: izin dulu, upload kemudian.' : failures + ' pemeriksaan gagal.'}`);
process.exit(failures === 0 ? 0 : 1);
