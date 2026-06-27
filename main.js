const { app, BrowserWindow } = require('electron');
const path = require('path');

// ===================== State =====================
let mainWindow = null;
let serverStarted = false;

// ===================== Start Express Server =====================
function startServer() {
  if (serverStarted) return;
  serverStarted = true;

  // Set upload temp dir ke OS temp folder (bukan relative path di dalam ASAR)
  // karena folder instalasi (Program Files) read-only untuk user biasa.
  process.env.LANDROP_UPLOAD_DIR = path.join(app.getPath('temp'), 'landrop-uploads');

  // require langsung di main process — lifecycle otomatis ikut app
  require('./server/index.js');
}

// ===================== Create Window =====================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });

  // Beri jeda agar Express server siap sebelum load URL
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:3000');
  }, 800);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===================== App Lifecycle =====================
app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
