const { app, BrowserWindow, Tray, Menu, clipboard, shell, nativeImage } = require('electron');
const path = require('path');

// ===================== State =====================
let mainWindow = null;
let tray = null;
let serverStarted = false;

// Mode tray: proses hidup tanpa jendela, cuma jadi ikon di pojok kanan bawah.
// Dipakai launcher `tui.js` (`electron . --tray`) supaya terminal boleh
// ditutup sementara LAN DROP tetap melayani perangkat lain.
const TRAY_MODE = process.argv.includes('--tray') || process.env.LANDROP_TRAY === '1';

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ===================== Ukur jeda (opsional) =====================
// LANDROP_TIMING=1 menulis penanda waktu ke %TEMP%\landrop-timing.log, supaya
// "kok lama" bisa dibuktikan dengan angka, bukan tebakan.
const T0 = Date.now();
function mark(name) {
  if (process.env.LANDROP_TIMING !== '1') return;
  try {
    require('fs').appendFileSync(
      path.join(app.getPath('temp'), 'landrop-timing.log'),
      `${Date.now() - T0} ms  ${name}\n`
    );
  } catch (_) {}
}

// ===================== Start Express Server =====================
function startServer() {
  if (serverStarted) return;
  serverStarted = true;

  // Set upload temp dir ke OS temp folder (bukan relative path di dalam ASAR)
  // karena folder instalasi (Program Files) read-only untuk user biasa.
  process.env.LANDROP_UPLOAD_DIR = path.join(app.getPath('temp'), 'landrop-uploads');

  // require langsung di main process — lifecycle otomatis ikut app
  require('./server/index.js');
  mark('server di-require');
}

// Tunggu port benar-benar listen. Sebelumnya ada jeda tetap 800 ms di depan
// loadURL — itu dibayar setiap kali jendela dibuka, padahal di mode tray server
// sudah listen sejak app start. Cek port biasanya selesai dalam <50 ms.
function waitForServer(port, timeoutMs = 5000) {
  const net = require('net');
  const mulai = Date.now();
  return new Promise((resolve) => {
    const cek = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(Date.now() - mulai); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - mulai > timeoutMs) resolve(-1);
        else setTimeout(cek, 50);
      });
    };
    cek();
  });
}

// ===================== Create Window =====================
function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mark('createWindow dipanggil');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    // Jangan tampilkan dulu: yang muncul pertama kali jadi halaman yang sudah
    // selesai digambar, bukan kerangka putih kosong yang bikin terasa lambat.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });
  mark('BrowserWindow dibuat');

  // 127.0.0.1, bukan localhost: server listen di 0.0.0.0 (IPv4 saja), sedangkan
  // localhost di Windows dicoba ke ::1 dulu. Terukur 207 ms vs 9 ms.
  waitForServer(PORT).then((ms) => {
    mark(`server siap (cek port ${ms} ms)`);
    if (!mainWindow) return;
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
    mark('loadURL dipanggil');
  });

  mainWindow.once('ready-to-show', () => {
    mark('ready-to-show -> show()');
    if (mainWindow) mainWindow.show();
  });
  mainWindow.webContents.on('did-finish-load', () => mark('halaman selesai dimuat'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => mark(`gagal muat ${code} ${desc}`));

  // Jaring pengaman: kalau ready-to-show tidak pernah datang, tetap tampilkan.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mark('jaring pengaman: show() paksa');
      mainWindow.show();
    }
  }, 3000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===================== Tray (mode background) =====================
function ownDashboardUrl() {
  try {
    const { listLANIPv4 } = require('./server/platform');
    const ips = listLANIPv4();
    if (ips.length) return `http://${ips[0].address}:${PORT}/dashboard`;
  } catch (_) {}
  return `http://localhost:${PORT}/dashboard`;
}

function createTray() {
  // Ikon yang sudah ada dipakai apa adanya (public/icons/icon-192.png): aset
  // PWA dan ikon tray berasal dari bentuk yang sama, jadi tidak ada gambar
  // kedua yang harus ikut dirawat.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'public', 'icons', 'icon-192.png'));

  tray = new Tray(icon);
  tray.setToolTip('LAN DROP — jalan di background');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Buka LAN DROP', click: () => createWindow() },
      {
        label: `Buka dashboard di browser (http://localhost:${PORT}/dashboard)`,
        click: () => shell.openExternal(`http://localhost:${PORT}/dashboard`),
      },
      { label: 'Salin alamat dashboard', click: () => clipboard.writeText(ownDashboardUrl()) },
      { type: 'separator' },
      { label: 'Keluar', click: () => app.quit() },
    ])
  );

  // Klik kiri ikon = buka jendela (kebiasaan app tray di Windows).
  tray.on('click', () => createWindow());
}

// ===================== App Lifecycle =====================
app.whenReady().then(() => {
  startServer();
  if (TRAY_MODE) createTray();
  else createWindow();
});

app.on('window-all-closed', () => {
  // Di mode tray jendela memang boleh tidak ada — proses harus tetap hidup.
  if (!TRAY_MODE) app.quit();
});

// Jendela ditutup = proses utama ikut mati, jadi timer debounce di
// server/history.js tidak pernah sempat jatuh tempo. Tulis sekarang.
app.on('before-quit', () => {
  try {
    require('./server/history.js').flushNow();
  } catch (_) {}
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
