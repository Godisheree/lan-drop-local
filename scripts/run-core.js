#!/usr/bin/env node
/**
 * Jalankan inti Rust tanpa Electron: `npm run core`.
 *
 * Kenapa lewat skrip dan bukan langsung binary: pemanggil harus tahu port yang
 * benar-benar dipakai (binary pindah port kalau 3000 terpakai), dan di Windows
 * path binary-nya berakhiran `.exe`. Skrip ini menyamakan keduanya.
 *
 * Usage:
 *   npm run core
 *   PORT=4400 npm run core
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const name = process.platform === 'win32' ? 'lan-drop-core.exe' : 'lan-drop-core';
const bin = process.env.LANDROP_CORE_BIN || path.join(ROOT, 'rust', 'target', 'release', name);

if (!fs.existsSync(bin)) {
  console.error(`Inti Rust belum dibangun: ${bin}`);
  console.error('Bangun dulu: npm run core:build');
  process.exit(1);
}

const child = spawn(bin, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
