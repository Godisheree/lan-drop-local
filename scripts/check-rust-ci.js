#!/usr/bin/env node
/**
 * Regresi: port Rust harus diuji di CI, bukan hanya di mesin pengembang.
 *
 * Seluruh `rust/` (~6k baris) tidak pernah dibangun oleh workflow mana pun
 * sebelum pemeriksaan ini ada. Akibatnya regresi Rust baru terlihat kalau
 * seseorang ingat menjalankan `npm run test:core` secara manual — dan itu
 * bukan gerbang, itu harapan.
 *
 * Usage: node scripts/check-rust-ci.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

function readWorkflows() {
  assert(fs.existsSync(WORKFLOWS), 'folder .github/workflows tidak ada');
  return fs.readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, text: fs.readFileSync(path.join(WORKFLOWS, name), 'utf-8') }));
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  OK   ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label} — ${err.message}`);
  }
}

const files = readWorkflows();
const combined = files.map((f) => f.text).join('\n');

check('ada workflow yang menyentuh Rust', () => {
  assert(/cargo\s+(test|build|clippy|fmt)/.test(combined), 'tidak ada perintah cargo di workflow mana pun');
});

check('workflow menjalankan cargo test', () => {
  assert(/cargo\s+test/.test(combined), 'cargo test tidak pernah dijalankan di CI');
});

check('workflow menjalankan clippy dengan -D warnings', () => {
  assert(/cargo\s+clippy[^\n]*--\s*-D\s+warnings/.test(combined),
    'clippy -- -D warnings tidak ada: peringatan compiler akan menumpuk tanpa penjaga');
});

check('workflow memeriksa format (cargo fmt --check)', () => {
  assert(/cargo\s+fmt[^\n]*--check/.test(combined), 'cargo fmt --check tidak ada');
});

check('toolchain CI memasang komponen clippy dan rustfmt', () => {
  assert(/component[s]?:[^\n]*(clippy|rustfmt)/.test(combined)
    || (/clippy/.test(combined) && /rustfmt/.test(combined)),
  'komponen clippy/rustfmt tidak dipasang, jadi langkah lint akan gagal di runner');
});

check('jalur rust ikut memicu workflow', () => {
  assert(/paths?:[\s\S]{0,400}rust\//.test(combined) || !/paths:/.test(combined),
    'workflow punya filter `paths` yang tidak menyertakan rust/, jadi perubahan Rust tidak memicu CI');
});

if (failures > 0) {
  console.error(`\n${failures} pemeriksaan CI Rust gagal.`);
  process.exit(1);
}
console.log('\nOk — CI menguji inti Rust (test, clippy, fmt).');
