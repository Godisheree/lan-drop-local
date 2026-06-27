// ===================== Platform Detection =====================
// Mendeteksi environment runtime: Windows vs Termux (Android)

function isTermux() {
  // Termux selalu set PREFIX ke /data/data/com.termux/files/usr
  return !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux'));
}

function isWindows() {
  return process.platform === 'win32';
}

module.exports = { isTermux, isWindows };
