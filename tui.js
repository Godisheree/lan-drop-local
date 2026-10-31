#!/usr/bin/env node
/**
 * Launcher LAN DROP -- menu terminal pakai tombol panah.
 *
 * Kenapa ada: `npm start` dulu langsung menumpahkan banner server ke terminal.
 * Sekarang ada dua cara jalan yang sama-sama sah (nempel di terminal ini, atau
 * lepas dari terminal dan hidup di ikon tray), dan pilihan itu harus bisa
 * dibaca sebelum ada yang jalan -- bukan lewat flag yang harus dihafal.
 *
 * Tanpa dependency: mode mentah stdin (`setRawMode`) + escape sequence ANSI.
 * Kalau stdin bukan TTY (dipipe, dijalankan skrip, atau HP/Termux tanpa tty),
 * menu dilewati dan server jalan di foreground seperti dulu.
 *
 * Usage:
 *   npm start          -- menu ini
 *   npm run server     -- langsung server, tanpa menu (Termux/HP)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { listLANIPv4 } = require('./server/platform');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ===================== Menu =====================

const MENU = [
  {
    id: 'terminal',
    label: 'Jalankan di terminal ini',
    hint: 'server + alamat dashboard, Ctrl+C buat stop',
  },
  {
    id: 'tray',
    label: 'Jalan di background + ikon tray',
    hint: 'lepas dari terminal, matiin dari menu ikon',
  },
  { id: 'quit', label: 'Keluar', hint: '' },
];

/**
 * Ikon tray butuh Electron. Di HP/Termux (atau kalau node_modules belum diisi)
 * pilihannya disembunyikan, bukan ditampilkan lalu gagal saat dipilih.
 *
 * Sengaja TIDAK pakai `require('electron')`: index.js paket itu menjalankan
 * unduhan binary ~240 MB kalau `dist/` belum ada. Cek file-nya langsung.
 * @returns {boolean}
 */
function trayAvailable() {
  const exe =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
        : 'electron';
  return fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist', exe));
}

/** @returns {Array<{id:string,label:string,hint:string}>} */
function buildMenu() {
  return MENU.filter((item) => item.id !== 'tray' || trayAvailable());
}

// ===================== Logika murni (diuji scripts/check-tui.js) =====================

/**
 * Peta escape sequence -> nama tombol.
 * `\x1b[A`/`\x1bOA` = panah atas, `\x1b[B`/`\x1bOB` = panah bawah.
 */
const KEYS = {
  '\x1b[A': 'up',
  '\x1bOA': 'up',
  '\x1b[B': 'down',
  '\x1bOB': 'down',
};

/**
 * Terjemahkan potongan byte stdin jadi nama tombol.
 * Escape sequence bisa tiba terpotong antar chunk, jadi sisa yang belum lengkap
 * dikembalikan di `rest` untuk disambung ke chunk berikutnya -- kecuali `flush`
 * (tidak ada byte lagi yang akan datang, jadi `\x1b` sendirian = tombol Esc).
 *
 * @param {string} buf
 * @param {boolean} [flush]
 * @returns {{keys: string[], rest: string}}
 */
function parseKeys(buf, flush) {
  const keys = [];
  let i = 0;

  while (i < buf.length) {
    const ch = buf[i];

    if (ch === '\x1b') {
      const seq = buf.slice(i, i + 3);
      if (seq === '\x1b') {
        if (flush) {
          keys.push('cancel');
          i += 1;
          continue;
        }
        return { keys, rest: buf.slice(i) }; // tunggu byte lanjutan
      }
      if (seq.length < 3) return { keys, rest: buf.slice(i) };
      if (KEYS[seq]) {
        keys.push(KEYS[seq]);
      }
      // sequence tak dikenal (Home/End/F-keys) diabaikan
      i += 3;
      continue;
    }

    if (ch === '\r' || ch === '\n') keys.push('enter');
    else if (ch === '\x03') keys.push('cancel'); // Ctrl+C (raw mode: sinyal tidak dikirim)
    else if (ch === 'j') keys.push('down');
    else if (ch === 'k') keys.push('up');
    else if (ch === 'q' || ch === 'Q') keys.push('cancel');
    else if (/^[1-9]$/.test(ch)) keys.push(ch);
    // karakter lain (ketikan asal) diabaikan diam-diam
    i += 1;
  }

  return { keys, rest: '' };
}

/**
 * Satu tombol -> state menu berikutnya. Murni, supaya bisa diuji tanpa tty.
 *
 * @param {{index:number, action:(string|null)}} state
 * @param {string} key
 * @param {Array<{id:string,label:string,hint:string}>} [menu]
 * @returns {{index:number, action:(string|null)}}
 */
function reduceKey(state, key, menu = MENU) {
  const n = menu.length;

  switch (key) {
    case 'up':
      return { ...state, index: (state.index + n - 1) % n };
    case 'down':
      return { ...state, index: (state.index + 1) % n };
    case 'enter':
      return { ...state, action: menu[state.index].id };
    case 'cancel':
      return { ...state, action: 'quit' };
    default:
      if (/^[1-9]$/.test(key) && Number(key) <= n) {
        const index = Number(key) - 1;
        return { ...state, index, action: menu[index].id };
      }
      return state;
  }
}

/** @param {{index:number}} state @param {Array} menu @returns {string} */
function render(state, menu) {
  const lines = [
    '',
    '  \u{1F680} LAN DROP \u2014 mau jalan gimana?',
    '',
  ];

  menu.forEach((item, i) => {
    const selected = i === state.index;
    const label = `${i + 1}. ${item.label}`.padEnd(38);
    const row = `  ${selected ? '\u276F' : ' '} ${label}${item.hint || ''}`;
    lines.push(selected ? `\x1b[36m${row}\x1b[0m` : row);
  });

  lines.push('', '  \u2191/\u2193 pilih \u00b7 Enter lanjut \u00b7 q keluar', '');
  return lines.join('\n');
}

// ===================== Aksi =====================

/**
 * Benar-benar bisa masuk mode mentah? `isTTY` saja tidak cukup: ada
 * lingkungan (stdin diarahkan ke /dev/null tapi stdout ke pty) yang melaporkan
 * TTY lalu melempar "stdin is not a tty" saat setRawMode. Kalau tidak bisa,
 * menu dilewati — lebih baik server jalan daripada crash sebelum apa pun jalan.
 * @returns {boolean}
 */
function canUseRawMode() {
  try {
    process.stdin.setRawMode(true);
    process.stdin.setRawMode(false);
    return true;
  } catch (_) {
    return false;
  }
}

/** @param {number} port @returns {Promise<boolean>} */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
  });
}

/** Server di terminal ini juga -- sama persis dengan `npm run server`. */
function runForeground() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}

/** Server + ikon tray, lepas dari terminal ini (detached). */
function runTray() {
  const electronExe = require('electron');
  const child = spawn(electronExe, ['.', '--tray'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore', // tanpa tty sendiri: proses selamat walau terminal ditutup
  });
  child.unref();

  const ips = listLANIPv4();
  const other = ips[0] ? `http://${ips[0].address}:${PORT}/dashboard` : null;

  console.log('');
  console.log(`  \u2705 LAN DROP jalan di background (PID ${child.pid}) \u2014 terminal ini boleh ditutup`);
  console.log(`  \u{1F4CA} Dashboard: http://localhost:${PORT}/dashboard` + (other ? `  \u00b7  dari perangkat lain: ${other}` : ''));
  console.log('  \u274C Matiin: klik ikon LAN DROP di pojok kanan bawah \u2192 Keluar');
  console.log('');
}

/**
 * @param {string} action
 * @returns {Promise<'again'|void>} 'again' = balik ke menu (aksi dibatalkan sebelum jalan)
 */
async function run(action) {
  if (action === 'quit') return;

  if (action === 'terminal') {
    runForeground();
    return;
  }

  if (action === 'tray') {
    if (!(await portFree(PORT))) {
      console.log(`\n  \u26A0\uFE0F  Port ${PORT} sudah dipakai \u2014 LAN DROP lain sedang jalan.`);
      console.log('     Matiin dulu dari ikon tray, atau jalankan dengan PORT lain.\n');
      return 'again';
    }
    runTray();
  }
}

// ===================== Loop menu =====================

async function menuLoop() {
  const menu = buildMenu();
  let state = { index: 0, action: null };

  const stdin = process.stdin;
  const out = process.stdout;

  const paint = () => out.write(`\x1b[H\x1b[2J${render(state, menu)}`);
  const restore = () => {
    stdin.setRawMode(false);
    stdin.pause();
    stdin.removeListener('data', onData);
    out.write('\x1b[?25h\x1b[?1049l'); // kursor balik + keluar alternate screen
  };

  let pendingEsc = null;

  function onData(chunk) {
    const parsed = parseKeys(chunk.toString('utf8'), false);
    let done = false;

    for (const key of parsed.keys) {
      state = reduceKey(state, key, menu);
      if (state.action) {
        done = true;
        break;
      }
    }

    if (!done) {
      if (parsed.rest === '\x1b' && !pendingEsc) {
        // Esc sendirian vs awal escape sequence: tunggu sebentar dulu.
        pendingEsc = setTimeout(() => {
          pendingEsc = null;
          state = reduceKey(state, 'cancel', menu);
          finish();
        }, 40);
      }
      paint();
      return;
    }

    finish();
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    if (pendingEsc) clearTimeout(pendingEsc);
    restore();
    resolveAction();
  }

  let resolveAction = () => {};

  return new Promise((resolve) => {
    resolveAction = () => resolve(state.action);

    stdin.setRawMode(true);
    stdin.resume();
    out.write('\x1b[?1049h\x1b[?25l'); // alternate screen + kursor disembunyikan
    stdin.on('data', onData);
    paint();

    process.on('exit', () => {
      try {
        stdin.setRawMode(false);
      } catch (_) {}
    });
  });
}

// ===================== Main =====================

async function main() {
  // Tanpa tty tidak ada tombol yang bisa ditekan: langsung jalan seperti dulu.
  if (!process.stdin.isTTY || !process.stdout.isTTY || !canUseRawMode()) {
    console.log('[Launcher] Terminal bukan TTY \u2014 menu dilewati, server jalan di foreground.');
    runForeground();
    return;
  }

  for (;;) {
    const action = await menuLoop();

    // Menu ditutup tanpa aksi (mis. Ctrl+C) = keluar.
    if (action === null || action === undefined) return;

    const result = await run(action);
    if (result !== 'again') return;

    // Kembali ke menu; layar sudah bersih dari alternate screen.
    console.log('');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Launcher] Gagal:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { MENU, KEYS, parseKeys, reduceKey, render, buildMenu, trayAvailable, canUseRawMode, portFree };
