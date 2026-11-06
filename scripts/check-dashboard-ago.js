#!/usr/bin/env node
/**
 * Uji `agoText()` di dashboard — label umur waktu ("9 dtk lalu").
 *
 * Kenapa waktunya dipatok: bug aslinya cuma muncul di batas pembulatan
 * (9,5 dtk tampil "10", lalu poll berikutnya mereset ke "baru saja"). Tanpa
 * memaku waktu, tesnya sendiri jadi flaky dan mengulang penyakit yang mau
 * dicegah.
 *
 * Usage: node scripts/check-dashboard-ago.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`OK   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name} — ${err && err.message ? err.message : err}`);
  }
}

/** Ambil satu fungsi dari file tanpa meng-import-nya (file itu ESM untuk browser). */
function extractFunction(source, name, stopAfter) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start !== -1, `fungsi ${name} tidak ditemukan`);
  const end = source.indexOf('\n}', source.indexOf(stopAfter, start)) + 2;
  return source.slice(start, end);
}

const dashSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'dashboard.js'), 'utf8');
const fmtSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'core', 'format.js'), 'utf8');

const formatDuration = new Function(
  fmtSrc
    .slice(
      fmtSrc.indexOf('export function formatDuration'),
      fmtSrc.indexOf('\n}\n', fmtSrc.indexOf('return `${days} hari')) + 2
    )
    .replace('export ', '') + '\nreturn formatDuration;'
)();

const agoText = new Function(
  'formatDuration',
  extractFunction(dashSrc, 'agoText', 'return `${formatDuration') + '\nreturn agoText;'
)(formatDuration);

/** Jalankan agoText dengan "sekarang" yang dipatok. */
function ageAt(elapsedMs) {
  const now = 1_700_000_000_000;
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
  try {
    return agoText(now - elapsedMs);
  } finally {
    global.Date = RealDate;
  }
}

// ── Batas pembulatan: inti bug yang dilaporkan ─────────────────────────────

check('9,5 dtk tampil "9 dtk lalu", bukan "10 dtk lalu"', () => {
  assert.strictEqual(ageAt(9500), '9 dtk lalu');
});

check('10,5 dtk tampil "10 dtk lalu", bukan "11 dtk lalu"', () => {
  assert.strictEqual(ageAt(10500), '10 dtk lalu');
});

check('tepat 10 dtk tampil "10 dtk lalu"', () => {
  assert.strictEqual(ageAt(10000), '10 dtk lalu');
});

check('di bawah 5 dtk = "baru saja"', () => {
  assert.strictEqual(ageAt(0), 'baru saja');
  assert.strictEqual(ageAt(4999), 'baru saja');
  assert.strictEqual(ageAt(5000), '5 dtk lalu');
});

// ── Monoton: umur tidak boleh mundur saat waktu berjalan ───────────────────

check('umur tidak pernah mundur (0..12 dtk)', () => {
  let prev = 0;
  for (let ms = 0; ms <= 12000; ms += 50) {
    const text = ageAt(ms);
    if (text === 'baru saja') continue;
    const value = Number(String(text).split(' ')[0]);
    assert.ok(Number.isFinite(value), `tidak bisa membaca umur dari "${text}"`);
    assert.ok(value >= prev, `umur mundur di ${ms}ms: ${prev} → ${value}`);
    prev = value;
  }
});

check('agoText memakai Math.floor, bukan Math.round', () => {
  const body = extractFunction(dashSrc, 'agoText', 'return `${formatDuration');
  assert.ok(/Math\.floor/.test(body), 'agoText harus memotong, bukan membulatkan');
  assert.ok(!/Math\.round/.test(body), 'agoText masih membulatkan — umur meloncat ke atas lalu reset');
});

// ── "sinyal terakhir" harus hidup, bukan string mati ───────────────────────

check('sinyal terakhir memakai ago() (elemen hidup), bukan agoText()', () => {
  const idx = dashSrc.indexOf("'Perangkat dikenal'");
  assert.ok(idx !== -1, 'baris "Perangkat dikenal" tidak ditemukan');
  const slice = dashSrc.slice(idx, idx + 500);
  assert.ok(/ago\(peers\.lastAnnounceAt\)/.test(slice), 'pakai ago() supaya ikut tickAges() tiap detik');
  assert.ok(!/agoText\(peers\.lastAnnounceAt\)/.test(slice), 'agoText() = string mati, beku sampai poll berikutnya');
});

// ── Polling discovery disesuaikan dengan interval broadcast ────────────────

check('polling discovery <= interval broadcast (2 dtk)', () => {
  const m = dashSrc.match(/discovery:\s*(\d+)/);
  assert.ok(m, 'POLL_MS.discovery tidak ditemukan');
  const ms = Number(m[1]);
  assert.ok(ms <= 2000, `discovery ${ms}ms > 2000ms — "Terakhir kirim" menua sampai 6-7 dtk sebelum di-reset`);
});

// ── hasil ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} lulus`);
if (failed.length) process.exit(1);
