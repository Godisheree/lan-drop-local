#!/usr/bin/env node
/**
 * Clippy sebagai gerbang, bukan saran.
 *
 * `cargo clippy` tidak selalu tersedia: paket Rust dari distro (Void, Alpine)
 * sering hanya memasang `clippy-driver` tanpa shim `cargo-clippy`. Kalau
 * skrip ini menyerah di situ, lint berhenti jadi penjaga dan peringatan
 * menumpuk sampai ada yang jadi bug. Jadi: coba `cargo clippy`, dan kalau
 * shim-nya tidak ada, pakai `clippy-driver` sebagai RUSTC_WORKSPACE_WRAPPER —
 * lint yang sama, jalan yang berbeda.
 *
 * Usage: node scripts/core-lint.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'rust', 'Cargo.toml');

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status,
    out: `${res.stdout || ''}${res.stderr || ''}`,
  };
}

if (process.platform === 'win32') {
  console.log('SKIP  clippy (jalur Windows: lint dijalankan di CI Linux)');
  process.exit(0);
}

const direct = run('cargo', ['clippy', '--release', '--all-targets', '--manifest-path', MANIFEST, '--', '-D', 'warnings']);
if (direct.status === 0) {
  console.log('clippy bersih (cargo clippy -- -D warnings).');
  process.exit(0);
}
if (!/cargo-clippy.*not installed|no such command: .clippy/i.test(direct.out)) {
  console.error(direct.out.trim().split('\n').slice(-40).join('\n'));
  process.exit(direct.status || 1);
}

// Shim tidak ada: jalankan lewat clippy-driver.
const driver = ['/usr/sbin/clippy-driver', '/usr/bin/clippy-driver', '/usr/local/bin/clippy-driver']
  .find((p) => {
    try {
      return require('fs').existsSync(p);
    } catch (_) {
      return false;
    }
  });
if (!driver) {
  console.log('SKIP  clippy: cargo-clippy tidak terpasang dan clippy-driver tidak ditemukan.');
  process.exit(0);
}

const fallback = run('cargo', ['check', '--release', '--all-targets', '--manifest-path', MANIFEST],
  { RUSTC_WORKSPACE_WRAPPER: driver });
const warnings = (fallback.out.match(/^warning: (?!.*generated)/gm) || []).length;
if (fallback.status !== 0 || warnings > 0) {
  console.error(fallback.out.trim().split('\n').filter((l) => /warning:|error/.test(l)).slice(0, 40).join('\n'));
  console.error(`\n${warnings} peringatan clippy — perbaiki sebelum lanjut.`);
  process.exit(1);
}
console.log('clippy bersih (lewat clippy-driver, shim cargo-clippy tidak terpasang).');
