// Ikon tray untuk versi npm — tanpa Electron.
//
// Kenapa tidak Electron: `npm i -g lan-drop-local` harus ringan. Electron
// menarik ~240 MB binary dan, di Linux, sekumpulan library GTK yang belum
// tentu ada — untuk sesuatu yang cuma butuh satu ikon di notification area.
// Pola yang dipakai di sini sama dengan 9router:
//
//   Windows  PowerShell NotifyIcon (System.Windows.Forms, sudah ada di OS)
//   Linux    systray2 (binary Go prebuilt), di-install santai ke data dir
//   macOS    systray2 (sama)
//   Termux   tidak ada tray — server tetap jalan, kontrol lewat terminal
//
// Modul ini TIDAK menyentuh server: pemanggil memberi `url` dan `onQuit`.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isWindows, isTermux, getDataDir, openBrowser } = require('./platform');

const ICON_ICO = path.join(__dirname, '..', 'public', 'icons', 'icon.ico');
const ICON_PNG = path.join(__dirname, '..', 'public', 'icons', 'icon-192.png');
const TRAY_WIN_PS1 = path.join(__dirname, 'tray-win.ps1');

// Versi dipatok, bukan `latest`: modul ini di-install di mesin user saat
// runtime, jadi update tak terduga bisa mematikan tray tanpa ada yang mengubah
// kode kita.
const SYSTRAY_VERSION = '2.1.4';

let winChild = null;
let unixTray = null;
let stopping = false;

/** @returns {string} */
function runtimeDir() {
  return path.join(getDataDir(), 'runtime');
}

// ===================== Windows =====================

/**
 * @param {{url: string, onQuit: () => void}} options
 * @returns {boolean}
 */
function startWindowsTray({ url, onQuit }) {
  if (!fs.existsSync(ICON_ICO)) {
    console.warn(`[Tray] ${ICON_ICO} is missing — run "npm run icons". Tray not started.`);
    return false;
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', TRAY_WIN_PS1,
    '-IconPath', ICON_ICO,
    '-Url', url,
    '-ParentPid', String(process.pid),
  ];

  try {
    winChild = spawn('powershell.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    console.warn(`[Tray] PowerShell could not be started: ${err.message}`);
    return false;
  }

  // Stderr PowerShell dipakai untuk dua hal: pesan kita sendiri dan pesan
  // berhenti yang tidak penting. Jangan dibuang mentah — user butuh tahu kalau
  // ternyata tray-nya mati karena kebijakan eksekusi.
  winChild.stderr.setEncoding('utf8');
  winChild.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn(`[Tray] ${text.split('\n')[0]}`);
  });

  let buffer = '';
  winChild.stdout.setEncoding('utf8');
  winChild.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let evt;
      try {
        evt = JSON.parse(line);
      } catch (_) {
        continue; // baris asing dari PowerShell, bukan kontrak kita
      }
      if (evt.type === 'quit' && !stopping) onQuit();
    }
  });

  winChild.on('error', (err) => {
    console.warn(`[Tray] Failed to start: ${err.message}`);
    winChild = null;
  });

  winChild.on('exit', () => {
    winChild = null;
    if (!stopping) console.log('[Tray] Ikon tray berhenti.');
  });

  return true;
}

// ===================== Linux / macOS =====================

/**
 * systray2 belum tentu terpasang. Dipasang sekali ke data dir saat pertama
 * dibutuhkan; kegagalan install TIDAK mematikan server (sama seperti 9router).
 * @returns {Promise<string|null>} path modul, atau null kalau gagal
 */
function ensureSystray() {
  const dir = runtimeDir();
  const modPath = path.join(dir, 'node_modules', 'systray2');
  if (fs.existsSync(path.join(modPath, 'package.json'))) return Promise.resolve(modPath);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) {
      fs.writeFileSync(pkg, JSON.stringify({ name: 'lan-drop-runtime', private: true }, null, 2));
    }
  } catch (err) {
    console.warn(`[Tray] Runtime folder could not be created (${dir}): ${err.message}`);
    return Promise.resolve(null);
  }

  console.log('[Tray] Preparing the tray module (one time, needs internet)…');

  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['install', `systray2@${SYSTRAY_VERSION}`, '--no-audit', '--no-fund', '--prefix', dir], {
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
      timeout: 180000,
    });

    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      resolve(code === 0 && fs.existsSync(path.join(modPath, 'package.json')) ? modPath : null);
    });
  });
}

/**
 * @param {{url: string, onQuit: () => void}} options
 * @returns {Promise<boolean>}
 */
async function startUnixTray({ url, onQuit }) {
  const modPath = await ensureSystray();
  if (!modPath) {
    console.warn('[Tray] Tray module unavailable — the server keeps running, control it from the terminal.');
    return false;
  }

  let SysTray;
  try {
    // systray2 itu ESM. `require()` modul ESM baru jalan di Node >= 22, jadi
    // `import()` adalah satu-satunya jalur yang aman untuk engines >=18.
    const mod = await import(require('url').pathToFileURL(modPath).href);
    SysTray = mod.default || mod;
  } catch (err) {
    console.warn(`[Tray] Modul tray rusak: ${err.message}`);
    return false;
  }

  let icon;
  try {
    icon = 'data:image/png;base64,' + fs.readFileSync(ICON_PNG).toString('base64');
  } catch (_) {
    console.warn('[Tray] Ikon PNG is missing — run "npm run icons". Tray not started.');
    return false;
  }

  try {
    unixTray = new SysTray({
      menu: {
        // title & tooltip dipakai systray2 sebagai identitas item di klik.
        title: 'LAN DROP',
        tooltip: url,
        icon,
        items: [
          { title: 'Buka dashboard di browser', tooltip: url, checked: false, enabled: true },
          { title: 'Keluar', tooltip: '', checked: false, enabled: true },
        ],
      },
      debug: false,
      copyDir: true,
    });
  } catch (err) {
    // Paling sering: libappindicator tidak terpasang di distro user.
    console.warn(`[Tray] Could not create the tray icon: ${err.message}`);
    console.warn('[Tray] Linux needs libayatana-appindicator (or libappindicator3). The server keeps running.');
    return false;
  }

  unixTray.onClick((action) => {
    const title = action && action.item && action.item.title;
    if (title === 'Keluar' && !stopping) onQuit();
    else if (title === 'Buka dashboard di browser') openBrowser(url);
  });

  try {
    await unixTray.ready();
  } catch (err) {
    console.warn(`[Tray] Tray icon failed to become ready: ${err.message}`);
    unixTray = null;
    return false;
  }

  return true;
}

// ===================== Publik =====================

/**
 * Nyalakan ikon tray. Tidak pernah melempar: tray itu pelengkap, bukan syarat
 * server hidup.
 *
 * @param {{url: string, onQuit: () => void}} options
 * @returns {Promise<boolean>} true kalau ikon benar-benar tampil
 */
async function startTray({ url, onQuit }) {
  if (isTermux()) return false; // Android tidak punya notification area

  stopping = false;
  if (isWindows()) return startWindowsTray({ url, onQuit });
  return startUnixTray({ url, onQuit });
}

/** Matikan ikon tray. Dipanggil saat server shutdown supaya tidak ada ikon hantu. */
function stopTray() {
  stopping = true;

  if (winChild) {
    try {
      winChild.kill();
    } catch (_) {}
    winChild = null;
  }

  if (unixTray) {
    try {
      unixTray.kill(false);
    } catch (_) {}
    unixTray = null;
  }
}

module.exports = { startTray, stopTray, ICON_ICO, ICON_PNG, runtimeDir };
