#!/usr/bin/env node
/**
 * Deteksi import yang tidak dipakai.
 *
 * Repo ini melarang dead code. Import yang tak terpakai adalah noise di
 * setiap review, dan kadang menyembunyikan bug (mis. lupa menghapus
 * pemanggilan fungsi yang sudah diubah).
 *
 * Usage: node scripts/check-unused-imports.js
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['public/js', 'server', 'scripts'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'vendor']);

function collect(dir, acc) {
  const full = path.resolve(dir);
  if (!fs.existsSync(full)) return acc;

  const stat = fs.statSync(full);
  if (stat.isFile()) {
    if (full.endsWith('.js')) acc.push(full);
    return acc;
  }

  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    collect(path.join(dir, entry.name), acc);
  }
  return acc;
}

const files = ROOTS.flatMap((root) => collect(root, []));

let total = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');

  // Ambil nama yang di-bind dari import statement.
  const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"][^'"]+['"]/g;
  const names = [];

  let match;
  while ((match = importRe.exec(source)) !== null) {
    if (match[1]) names.push(match[1].trim());
    if (match[2]) {
      for (const part of match[2].split(',')) {
        const cleaned = part.trim();
        if (!cleaned) continue;
        const asMatch = cleaned.match(/\s+as\s+(\w+)$/);
        names.push(asMatch ? asMatch[1] : cleaned);
      }
    }
  }

  // Buang blok import dari sumber sebelum menghitung pemakaian.
  const body = source.replace(importRe, '');

  const unused = names.filter((name) => {
    const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
    return !re.test(body);
  });

  if (unused.length > 0) {
    const rel = path.relative(process.cwd(), file);
    console.log(`${rel}`);
    for (const name of unused) console.log(`  - ${name}`);
    total += unused.length;
  }
}

console.log(`\n${total} import tak terpakai di ${files.length} file.`);
process.exitCode = total > 0 ? 1 : 0;
