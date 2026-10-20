#!/usr/bin/env node
/**
 * Audit karakter non-Latin yang tidak disengaja di file teks.
 *
 * Menangkap artefak generasi (Cyrillic/CJK混入) yang lolos ke dokumen atau
 * komentar kode. Emoji dan simbol umum diizinkan.
 *
 * Usage: node scripts/audit-charset.js [path ...]
 */
const fs = require('fs');
const path = require('path');

// Rentang yang boleh: Latin-1 supplement, Latin Extended, currency/punctuation,
// arrows, math, box drawing, geometric, emoji, CJK punctuation/ideograph,
// Hiragana/Katakana/Hangul, Arabic, Hebrew, Devanagari.
const ALLOWED = [
  [0x00a0, 0x024f], // Latin-1 supplement + Latin Extended A/B
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // general punctuation
  [0x20a0, 0x20bf], // currency
  [0x2100, 0x214f], // letterlike
  [0x2150, 0x218f], // number forms
  [0x2190, 0x21ff], // arrows
  [0x2200, 0x22ff], // math operators
  [0x2460, 0x24ff], // enclosed alphanumerics
  [0x2500, 0x257f], // box drawing
  [0x2580, 0x259f], // block elements
  [0x25a0, 0x25ff], // geometric shapes
  [0x2600, 0x26ff], // misc symbols
  [0x2700, 0x27bf], // dingbats
  [0x2900, 0x297f], // supplemental arrows
  [0x2b00, 0x2bff], // misc symbols and arrows
  [0x2300, 0x23ff], // misc technical (⏰ ⏳ ⌛)
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3100, 0x312f], // Bopomofo
  [0x3130, 0x318f], // Hangul compatibility Jamo
  [0x3190, 0x319f], // Kanbun
  [0x31f0, 0x31ff], // Katakana phonetic extensions
  [0xac00, 0xd7af], // Hangul syllables
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xff00, 0xffef], // halfwidth and fullwidth forms
  [0x1f000, 0x1ffff], // emoji
];

function isAllowed(code) {
  return ALLOWED.some(([lo, hi]) => code >= lo && code <= hi);
}

function scanFile(file) {
  const raw = fs.readFileSync(file);
  const text = raw.toString('utf8');
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const ch of line) {
      const code = ch.codePointAt(0);
      if (code < 0x80 || isAllowed(code)) continue;
      findings.push({
        line: i + 1,
        char: ch,
        code: 'U+' + code.toString(16).toUpperCase().padStart(4, '0'),
        preview: line.trim().slice(0, 90),
      });
    }
  });
  return findings;
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(md|js|css|html|json|txt)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

const targets = process.argv.slice(2);
const files = targets.length
  ? targets.flatMap((t) => (fs.statSync(t).isDirectory() ? walk(t, []) : [t]))
  : walk('docs', []).concat(walk('public', [])).concat(walk('server', [])).concat(['CHANGELOG.md', 'CLAUDE.md']);

let total = 0;
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const findings = scanFile(file);
  if (!findings.length) continue;
  console.log('\n' + file);
  for (const f of findings) {
    console.log(`  ${f.code} ${f.line}: ${f.preview}`);
  }
  total += findings.length;
}

if (total === 0) {
  console.log('OK — tidak ada karakter asing yang tidak disengaja.');
} else {
  console.log(`\n${total} karakter asing ditemukan.`);
  process.exitCode = 1;
}
