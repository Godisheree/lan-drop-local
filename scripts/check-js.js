#!/usr/bin/env node
/**
 * Pemeriksaan sintaks untuk seluruh file JavaScript di repo.
 *
 * `node --check` memaksa mode CommonJS, jadi file ESM (pakai import/export)
 * akan selalu gagal. Script ini menyalin file ke .mjs sementara supaya
 * Node memeriksa dengan mode module yang benar.
 *
 * Usage: node scripts/check-js.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOTS = ['public/js', 'server', 'scripts', 'main.js', 'preload.js'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'public/js/vendor']);

function collect(target, acc) {
  const full = path.resolve(target);
  if (!fs.existsSync(full)) return acc;

  const stat = fs.statSync(full);
  if (stat.isFile()) {
    if (full.endsWith('.js') && !SKIP.has(path.relative(process.cwd(), full))) acc.push(full);
    return acc;
  }

  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name === 'node_modules') continue;
    collect(path.join(target, entry.name), acc);
  }
  return acc;
}

const files = ROOTS.flatMap((root) => collect(root, []));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landrop-check-'));

let failures = 0;

for (const file of files) {
  // Deteksi ESM: ada import/export di level teratas.
  const source = fs.readFileSync(file, 'utf8');
  const isModule = /^\s*(import\s|export\s|export\{|import\{)/m.test(source);

  const tmp = path.join(tmpDir, path.basename(file) + (isModule ? '.mjs' : '.cjs'));
  fs.writeFileSync(tmp, source);

  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log(`  OK   ${path.relative(process.cwd(), file)}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${path.relative(process.cwd(), file)}`);
    const output = (err.stderr ? err.stderr.toString() : '') + (err.stdout ? err.stdout.toString() : '');
    console.log(
      output
        .split('\n')
        .filter((line) => /Error|error|^\s+\^|Unexpected|not defined/i.test(line))
        .slice(0, 6)
        .map((line) => '       ' + line.trim())
        .join('\n')
    );
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${files.length - failures}/${files.length} file lolos pemeriksaan sintaks.`);
process.exitCode = failures > 0 ? 1 : 0;
