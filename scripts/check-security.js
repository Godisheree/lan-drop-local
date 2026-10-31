#!/usr/bin/env node
/**
 * Regression check keamanan LAN DROP.
 *
 * Semua ini bukan "scan" — ini cek yang gagal kalau ada yang balik lagi
 * ke kondisi tidak aman. Sebagian besar cek bersifat PERILAKU (memanggil
 * fungsi aslinya), sebagian statis (urutan argumen, larangan shell).
 *
 *   1. Path allowlist upload (anti-bocor file privat dari /transfer/send-file)
 *   2. Target IP hanya LAN/Tailscale (anti-SSRF, termasuk lewat hostname)
 *   3. Perilaku middleware: security header, origin guard, rate limit
 *   4. Tidak ada shell interpolation di server/ (exec/execSync/shell:true)
 *   5. ffmpeg/ffprobe dibatasi ke protokol file: (anti-SSRF lewat media)
 *
 * Usage: node scripts/check-security.js
 */
const fs = require('fs');
const path = require('path');

// check ini me-require modul server (transfer.js, security.js) — dan transfer.js
// me-require logbus.js, yang membajak console.log dan mendiamkannya kecuali
// LANDROP_DEBUG. Akibatnya seluruh hasil cek di bawah tidak pernah kelihatan
// (cuma exit code-nya yang jalan). Nyalakan sebelum require pertama.
process.env.LANDROP_DEBUG = '1';

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const transferSource = read('server/transfer.js');
const indexSource = read('server/index.js');
const securitySource = read('server/security.js');
const thumbnailSource = read('server/thumbnail.js');
const platformSource = read('server/platform.js');
const discoverySource = read('server/discovery.js');

// Semua file server — untuk cek "tidak ada shell interpolation".
const serverFiles = fs
  .readdirSync(path.join(ROOT, 'server'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: `server/${f}`, source: read(`server/${f}`) }));

let failures = 0;

function ok(label) {
  console.log(`  OK   ${label}`);
}

function fail(label, detail) {
  failures++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(`       ${detail}`);
}

function expectTrue(condition, label, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}

function expectThrow(fn, label) {
  try {
    fn();
    fail(label, 'tidak melempar error');
  } catch (_) {
    ok(label);
  }
}

/**
 * Ambil isi satu fungsi dari source (heuristik: dari `function nama(` sampai
 * baris penutup dengan indentasi yang sama).
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return '';
  const rest = source.slice(start);
  const end = rest.indexOf('\n}');
  return end === -1 ? rest : rest.slice(0, end + 2);
}

// ===================== 1. Path allowlist upload =====================
console.log('\n[1] Path allowlist upload');

const { assertInsideUploads } = require(path.join(ROOT, 'server', 'transfer.js'));
const uploadsRoot = path.resolve(
  process.env.LANDROP_UPLOAD_DIR || path.join(ROOT, 'uploads-temp')
);

expectTrue(typeof assertInsideUploads === 'function', 'assertInsideUploads tersedia');

expectTrue(
  assertInsideUploads(path.join(uploadsRoot, 'upload_abc123')) === path.join(uploadsRoot, 'upload_abc123'),
  'path di dalam folder upload diterima'
);

expectThrow(
  () => assertInsideUploads(path.join(uploadsRoot, '..', '..', 'Windows', 'System32', 'config', 'SAM')),
  'path keluar folder upload ditolak (traversal)'
);

expectThrow(
  () => assertInsideUploads('C:\\Users\\victim\\.ssh\\id_rsa'),
  'path absolut di luar folder upload ditolak'
);

expectThrow(
  () => assertInsideUploads('/etc/passwd'),
  'path linux di luar folder upload ditolak'
);

expectThrow(
  () => assertInsideUploads(uploadsRoot),
  'folder upload itu sendiri ditolak (bukan file)'
);

expectThrow(
  () => assertInsideUploads(''),
  'path kosong ditolak'
);

expectThrow(
  () => assertInsideUploads(uploadsRoot + '-evil\\file.txt'),
  'prefix mirip tapi bukan folder upload ditolak'
);

// Cek kanonik (symlink/junction) ikut ada.
expectTrue(
  transferSource.includes('fs.realpathSync'),
  'allowlist punya cek kanonik (realpath) untuk symlink/junction'
);

// Urutan: validasi HARUS sebelum existsSync, dan stream harus pakai path
// yang sudah divalidasi (bukan path mentah dari request).
const sendSrc = extractFunction(transferSource, 'startFileSend');
const idxGuard = sendSrc.indexOf('assertInsideUploads');
const idxExists = sendSrc.indexOf('fs.existsSync');
const idxStream = sendSrc.indexOf('fs.createReadStream');

expectTrue(idxGuard !== -1, 'startFileSend memanggil assertInsideUploads');
expectTrue(idxExists !== -1, 'startFileSend tetap mengecek keberadaan file');
expectTrue(idxGuard !== -1 && idxExists !== -1 && idxGuard < idxExists,
  'allowlist dijalankan SEBELUM existsSync');
expectTrue(
  idxStream !== -1 && idxStream > idxGuard,
  'read stream dibuat setelah allowlist'
);
expectTrue(
  !/fs\.createReadStream\(\s*filePath\s*\)/.test(sendSrc),
  'read stream tidak memakai path mentah dari request'
);

// ===================== 2. Target IP (anti-SSRF) =====================
console.log('\n[2] Target IP hanya LAN/Tailscale');

const { isAllowedTargetIp } = require(path.join(ROOT, 'server', 'security.js'));

expectTrue(isAllowedTargetIp('192.168.1.10'), 'IP LAN privat diterima');
expectTrue(isAllowedTargetIp('10.0.0.5'), 'IP 10.x diterima');
expectTrue(isAllowedTargetIp('172.16.3.4'), 'IP 172.16-31.x diterima');
expectTrue(isAllowedTargetIp('127.0.0.1'), 'loopback diterima');
expectTrue(isAllowedTargetIp('100.101.102.103'), 'IP Tailscale (CGNAT) diterima');
expectTrue(isAllowedTargetIp('::1'), 'IPv6 loopback diterima');
expectTrue(isAllowedTargetIp('fd7a:115c:a1e0::1'), 'IPv6 Tailscale (fd7a::) diterima');
expectTrue(isAllowedTargetIp('::ffff:192.168.1.5'), 'IPv4-mapped IPv6 diterima');

expectTrue(!isAllowedTargetIp('169.254.169.254'), 'metadata cloud ditolak');
expectTrue(!isAllowedTargetIp('169.254.1.1'), 'link-local 169.254/16 ditolak');
expectTrue(!isAllowedTargetIp('8.8.8.8'), 'IP publik ditolak');
expectTrue(!isAllowedTargetIp('172.32.0.1'), 'IP di luar 172.16-31 ditolak');
expectTrue(!isAllowedTargetIp(''), 'target kosong ditolak');
expectTrue(!isAllowedTargetIp('foo; rm -rf /'), 'target berisi karakter shell ditolak');

// Hostname dari jaringan harus ditolak — inilah bypass SSRF yang pernah ada.
expectTrue(!isAllowedTargetIp('metadata.google.internal'), 'hostname dari jaringan ditolak (bypass SSRF)');
expectTrue(!isAllowedTargetIp('evil.example'), 'hostname asing ditolak');
expectTrue(!isAllowedTargetIp('laptop-saya.local'), 'hostname mDNS dari jaringan ditolak');
expectTrue(!isAllowedTargetIp('2130706433'), 'IP desimal (2130706433) ditolak');
expectTrue(!isAllowedTargetIp('2852039166'), 'IP desimal metadata cloud ditolak');

// Tapi hostname yang DIDAFTARKAN operator lewat LANDROP_PEERS boleh.
process.env.LANDROP_PEERS = 'Laptop@192.168.1.5:3000@3001,Old@nas.lan:3000@3001';
expectTrue(isAllowedTargetIp('nas.lan'), 'hostname dari LANDROP_PEERS diterima');
expectTrue(!isAllowedTargetIp('lain.example'), 'hostname di luar LANDROP_PEERS tetap ditolak');
delete process.env.LANDROP_PEERS;

// ===== Target yang menunjuk ke diri sendiri =====
// Peer beralamat 'localhost' bikin kiriman mendarat di server pengirim —
// bug nyata yang membuat user mengira "kirimnya nyasar".
const { isSelfTarget } = require(path.join(ROOT, 'server', 'security.js'));
expectTrue(isSelfTarget('localhost'), 'target localhost ditolak sebagai self-target');
expectTrue(isSelfTarget('127.0.0.1'), 'target 127.0.0.1 ditolak sebagai self-target');
expectTrue(isSelfTarget('127.0.0.5'), 'target 127.x ditolak sebagai self-target');
expectTrue(!isSelfTarget('192.168.1.5'), 'peer LAN lain bukan self-target');
expectTrue(!isSelfTarget('100.100.131.65'), 'peer Tailscale bukan self-target');
process.env.LANDROP_ALLOW_SELF_TARGET = '1';
expectTrue(!isSelfTarget('127.0.0.1'), 'escape hatch LANDROP_ALLOW_SELF_TARGET bekerja');
delete process.env.LANDROP_ALLOW_SELF_TARGET;

// ===================== 3. Perilaku middleware =====================
console.log('\n[3] Middleware keamanan');

const { securityHeaders, sameOriginGuard, rateLimit } = require(path.join(ROOT, 'server', 'security.js'));

// --- security headers ---
const fakeRes = {
  headers: {},
  statusCode: null,
  body: null,
  set(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
};
securityHeaders({}, fakeRes, () => {});
for (const header of [
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Content-Security-Policy',
]) {
  expectTrue(!!fakeRes.headers[header], `header ${header} diset`);
}
expectTrue(
  (fakeRes.headers['Content-Security-Policy'] || '').includes("script-src 'self'"),
  'CSP memblokir script inline'
);

// --- origin guard ---
function runOriginGuard(headers, method = 'POST') {
  const res = { ...fakeRes, headers: {}, statusCode: null, body: null };
  const req = {
    method,
    get: (name) => headers[name.toLowerCase()],
  };
  let passed = false;
  sameOriginGuard(req, res, () => { passed = true; });
  return { passed, statusCode: res.statusCode };
}

expectTrue(
  runOriginGuard({ host: '192.168.1.7:3000', origin: 'http://192.168.1.7:3000' }).passed,
  'origin sama → diteruskan'
);
expectTrue(
  runOriginGuard({ host: '192.168.1.7:3000' }).passed,
  'tanpa header Origin (curl/native) → diteruskan'
);
expectTrue(
  runOriginGuard({ host: '192.168.1.7:3000', origin: 'http://evil.example' }).statusCode === 403,
  'origin berbeda → 403'
);
expectTrue(
  runOriginGuard({ host: '192.168.1.7:3000', origin: 'null' }).statusCode === 403,
  'origin "null" → 403'
);
expectTrue(
  runOriginGuard({ host: '192.168.1.7:3000', origin: 'http://192.168.1.7:4000' }).statusCode === 403,
  'origin host sama tapi port beda → 403'
);
expectTrue(
  runOriginGuard({ host: '192.168.1.7:3000', origin: 'http://192.168.1.7:3000' }, 'GET').passed,
  'GET tidak kena origin guard'
);

// --- rate limit ---
const limiter = rateLimit({ windowMs: 60000, max: 5 });
let limited = false;
for (let i = 0; i < 20; i++) {
  limiter({ ip: '10.0.0.9' }, { set() {}, status(code) { if (code === 429) limited = true; return this; }, json() { return this; } }, () => {});
}
expectTrue(limited, 'rate limiter membalas 429 setelah batas');

let passedCount = 0;
for (let i = 0; i < 3; i++) {
  limiter({ ip: '10.0.0.10' }, { set() {}, status() { return this; }, json() { return this; } }, () => { passedCount++; });
}
expectTrue(passedCount === 3, 'IP lain punya kuota sendiri');

// --- pemasangan di server ---
expectTrue(indexSource.includes('app.use(securityHeaders)'), 'securityHeaders terpasang sebagai middleware');
expectTrue(indexSource.includes('app.use(sameOriginGuard)'), 'sameOriginGuard terpasang sebagai middleware');
expectTrue(indexSource.includes('rateLimit('), 'rate limiter terpasang');
expectTrue(indexSource.includes('limits:'), 'multer punya limits');
expectTrue(indexSource.includes('isAllowedTargetIp(targetIp)'), 'validasi target IP ada di route transfer');

// Urutan: header + origin guard SEBELUM parser body (kalau tidak, JSON rusak
// dibalas HTML+bekas stack trace tanpa header keamanan).
const idxHeaders = indexSource.indexOf('app.use(securityHeaders)');
const idxOrigin = indexSource.indexOf('app.use(sameOriginGuard)');
const idxJson = indexSource.indexOf('app.use(express.json())');
expectTrue(idxHeaders !== -1 && idxJson !== -1 && idxHeaders < idxJson,
  'securityHeaders dipasang sebelum express.json()');
expectTrue(idxOrigin !== -1 && idxJson !== -1 && idxOrigin < idxJson,
  'sameOriginGuard dipasang sebelum express.json()');
expectTrue(indexSource.includes("error: 'Terjadi kesalahan di server'"),
  'ada global error handler yang tidak membocorkan stack trace');

// ===================== 4. Tidak ada shell interpolation =====================
console.log('\n[4] Tidak ada pemanggilan shell tanpa argumen');

// exec(...)/execSync(...) = string dieksekusi shell → bisa dieksploitasi
// lewat nama file dari peer. execFile(...args) aman.
for (const { name, source } of serverFiles) {
  // Buang komentar baris supaya kata "exec(" di penjelasan tidak dihitung.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Lookbehind: buang ".exec(" (RegExp.prototype.exec) — yang bahaya
  // cuma child_process.exec, 즉 "exec(" yang berdiri sendiri.
  const execCalls = (code.match(/(?<![\w.$])exec\s*\(/g) || []).length;
  const execSyncCalls = (code.match(/(?<![\w.$])execSync\s*\(/g) || []).length;
  const shellTrue = /\bshell\s*:\s*true/.test(code);
  expectTrue(
    execCalls === 0 && execSyncCalls === 0 && !shellTrue,
    `${name} bebas shell interpolation`,
    `exec:${execCalls} execSync:${execSyncCalls} shell:true:${shellTrue}`
  );
}
expectTrue(
  transferSource.includes('execFile('),
  'media scan pakai execFile (argumen terpisah, tanpa shell)'
);

// Nama device diambil tanpa shell juga (getprop).
expectTrue(
  platformSource.includes("execFileSync('getprop'") || platformSource.includes('execFileSync("getprop"'),
  'nama device Android diambil via execFileSync (tanpa shell)'
);

// Endpoint status discovery harus read-only (GET) dan tidak membocorkan path.
expectTrue(
  /app\.get\('\/discovery\/status'/.test(indexSource),
  '/discovery/status adalah endpoint GET read-only'
);
expectTrue(
  !/app\.post\('\/discovery\/status'/.test(indexSource),
  '/discovery/status tidak punya handler POST'
);

// Kegagalan broadcast tidak boleh didiamkan (dulu EHOSTUNREACH diemkan
// → user cuma lihat "device gak muncul" tanpa tahu kenapa).
expectTrue(
  discoverySource.includes('lastError') && discoverySource.includes('logBroadcastError'),
  'error broadcast dicatat (tidak diemkan)'
);

// ===================== 5. ffmpeg dibatasi protokol file =====================
console.log('\n[5] ffmpeg/ffprobe dibatasi ke protokol file:');

for (const fn of ['transcodeToMp4', 'remuxToM4a']) {
  const src = extractFunction(transferSource, fn);
  const idxWhite = src.indexOf("'-protocol_whitelist'");
  const idxInput = src.indexOf("'-i'");
  expectTrue(idxWhite !== -1, `${fn} punya -protocol_whitelist`);
  expectTrue(idxWhite !== -1 && idxInput !== -1 && idxWhite < idxInput,
    `${fn}: whitelist sebelum -i (opsi input)`);
  expectTrue(src.includes("'-nostdin'"), `${fn} punya -nostdin`);
}

const probeSrc = extractFunction(transferSource, 'getStreamInfo');
const idxProbeWhite = probeSrc.indexOf("'-protocol_whitelist'");
// Path input dicari SETELAH flag — nama parameter "filePath" di signature
// function ada di atas, jadi harusnya lompat ke kemunculan berikutnya.
const idxProbeInput = probeSrc.indexOf('filePath', idxProbeWhite + 1);
expectTrue(idxProbeWhite !== -1, 'getStreamInfo punya -protocol_whitelist');
expectTrue(
  idxProbeWhite !== -1 && idxProbeInput !== -1 && idxProbeWhite < idxProbeInput,
  'getStreamInfo: whitelist sebelum path input'
);

expectTrue(
  thumbnailSource.includes("'-protocol_whitelist', 'file'"),
  'thumbnail.js juga dibatasi protokol file'
);

// ===================== Ringkasan =====================
console.log(
  failures === 0
    ? '\n✅ Semua pemeriksaan keamanan lolos.'
    : `\n❌ ${failures} pemeriksaan keamanan gagal.`
);
process.exitCode = failures > 0 ? 1 : 0;
