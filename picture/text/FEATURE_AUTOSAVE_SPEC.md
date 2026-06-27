# Spek Tambahan — Auto-Save ke Folder Default per Platform (LAN Drop)

## Konteks
Hari 1-5 + fitur file picker sudah selesai dan terbukti jalan end-to-end (laptop Windows ↔ HP via Termux). Sekarang masalah yang ditemukan: file yang diterima selalu disimpan ke folder internal project (`<project>/downloads/`), bukan ke lokasi yang familiar untuk user (Downloads Windows, atau Galeri/Album HP). User harus cari manual lewat File Explorer/Termux tiap kali, ini bukan UX yang baik untuk app yang ditujukan dipakai orang awam.

## Tujuan
1. **Di Desktop (Windows):** file otomatis tersimpan ke `D:\Downloads\Download - Lan Drop\` (folder dibuat otomatis kalau belum ada).
2. **Di HP (Termux):** file otomatis dipindah ke folder Android publik yang sesuai TIPE filenya:
   - Foto (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.heic`) → masuk ke folder Pictures (`~/storage/pictures/`)
   - Video (`.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`, `.3gp`) → masuk ke folder Movies (`~/storage/movies/`)
   - Tipe lain (dokumen, zip, dll) → masuk ke folder Downloads Android (`~/storage/downloads/`)
   - Setelah file dipindah ke lokasi itu, trigger `termux-media-scan` otomatis (khusus untuk foto/video) supaya muncul di Galeri tanpa perlu intervensi manual.
3. Logic ini harus otomatis MENDETEKSI environment (Windows vs Termux) saat runtime, karena kode `server/transfer.js` yang sama dijalankan di kedua platform. Command/path yang valid di satu platform akan error/tidak ada di platform lain — JANGAN hardcode asumsi satu platform saja.

## File yang Diedit
- `server/transfer.js` — bagian yang menentukan `savePath` saat menulis file hasil terima (dari hari 4), serta logic post-processing setelah file selesai ditulis.

## Spesifikasi Teknis

### 1. Deteksi Platform/Environment
Buat helper function, taruh di bagian atas `transfer.js` atau file util baru `server/platform.js`:

```js
function isTermux() {
  // Termux selalu set environment variable PREFIX yang mengarah ke path khusus,
  // contoh: /data/data/com.termux/files/usr
  // Ini lebih reliable daripada os.platform() karena os.platform() di Termux Android
  // bisa mengembalikan 'android' atau 'linux' tergantung versi Node yang dipakai,
  // sedangkan PREFIX konsisten selalu ada di environment Termux.
  return !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux'));
}

function isWindows() {
  return process.platform === 'win32';
}
```

### 2. Penentuan Folder Tujuan Berdasarkan Platform

**Kasus Windows:**
```js
const WINDOWS_SAVE_DIR = 'D:\\Downloads\\Download - Lan Drop';
```
- Buat folder ini otomatis kalau belum ada, pakai `fs.mkdirSync(WINDOWS_SAVE_DIR, { recursive: true })` — jalankan pengecekan/pembuatan ini SEKALI saat server start (di `index.js`, bukan tiap kali ada transfer, supaya tidak redundant check tiap transfer masuk), atau aman juga dipanggil tiap transfer asal pakai `recursive: true` karena tidak error kalau folder sudah ada.
- **PENTING — Edge case yang harus ditangani:** drive `D:` belum pasti ada di semua laptop (sebagian laptop hanya punya drive `C:`). Sebelum mencoba membuat folder di `D:\`, cek dulu apakah drive `D:` ada/accessible. Kalau `D:` tidak ada, fallback ke folder `Downloads` di home directory user yang pasti selalu ada di Windows: `path.join(os.homedir(), 'Downloads', 'Download - Lan Drop')` — dan log peringatan ke console bahwa fallback ini terjadi, supaya user tahu kalau hasilnya tidak sesuai harapan awal (`D:\Downloads\...`) dan bisa cek manual kalau perlu.
  ```js
  function getWindowsSaveDir() {
    const preferredDir = 'D:\\Downloads\\Download - Lan Drop';
    try {
      // Cek apakah drive D: bisa diakses
      fs.accessSync('D:\\');
      return preferredDir;
    } catch (err) {
      const fallbackDir = path.join(os.homedir(), 'Downloads', 'Download - Lan Drop');
      console.warn(`[Transfer] Drive D: tidak ditemukan, fallback simpan ke: ${fallbackDir}`);
      return fallbackDir;
    }
  }
  ```

**Kasus Termux (HP):**
- Karena symlink `~/storage/...` hanya berfungsi SETELAH user pernah menjalankan `termux-setup-storage` (sudah dilakukan di sesi sebelumnya, tapi kode harus tetap defensif untuk kasus belum pernah dijalankan), kode harus cek dulu apakah folder `~/storage/pictures`, `~/storage/movies`, `~/storage/downloads` ada dan bisa diakses SEBELUM mencoba pindah file ke sana.
  ```js
  function getTermuxStorageDir(category) {
    // category: 'pictures' | 'movies' | 'downloads'
    const dir = path.join(os.homedir(), 'storage', category);
    if (fs.existsSync(dir)) {
      return dir;
    }
    console.warn(`[Transfer] ~/storage/${category} tidak ditemukan (mungkin termux-setup-storage belum dijalankan). File akan disimpan di folder internal project sebagai fallback.`);
    return null; // null = sinyal untuk fallback ke folder downloads internal project yang sudah ada sejak hari 4
  }
  ```
- Kalau hasilnya `null` (storage belum disetup), JANGAN crash atau gagal total — tetap simpan file ke folder `downloads/` internal project seperti behavior hari 4 sebelumnya, supaya transfer tidak gagal hanya karena fitur baru ini belum sepenuhnya bisa jalan di device tersebut.

### 3. Klasifikasi Tipe File Berdasarkan Ekstensi
```js
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.3gp'];

function classifyFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (PHOTO_EXTENSIONS.includes(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  return 'other';
}
```
Catatan: klasifikasi ini HANYA dipakai untuk kasus Termux (menentukan masuk ke `pictures`, `movies`, atau `downloads`). Untuk Windows, semua tipe file tetap masuk ke satu folder yang sama (`D:\Downloads\Download - Lan Drop\`), tidak perlu dipisah per tipe — sesuai requirement yang diminta.

### 4. Alur Lengkap Saat Penerimaan File Selesai

Modifikasi bagian di `transfer.js` yang menangani penyelesaian penulisan file (event `finish` pada `writeStream`, dari implementasi hari 4):

```
SETELAH writeStream selesai menulis file (event 'finish'):

1. Tentukan platform:
   - Jika isWindows() → tujuan akhir = getWindowsSaveDir()
   - Jika isTermux() → 
       a. Klasifikasikan tipe file (photo/video/other)
       b. Tentukan folder storage sesuai kategori via getTermuxStorageDir()
       c. Jika hasil null (storage belum setup) → tujuan akhir = folder downloads/ internal (tidak pindah)
   - Platform lain (Linux desktop dll, di luar 2 kasus utama) → tetap simpan di folder downloads/ internal project sebagai default aman, tidak perlu fitur khusus untuk kasus ini.

2. Jika tujuan akhir BUKAN folder downloads/ internal (artinya ada lokasi spesial yang dituju):
   a. Pastikan folder tujuan ada (mkdirSync recursive jika perlu)
   b. Pindahkan/copy file dari lokasi sementara (downloads/ internal, hasil tulis writeStream) ke folder tujuan akhir
      - Gunakan fs.copyFile() lalu fs.unlink() pada file asal (setara "move"), ATAU fs.rename() jika source dan tujuan masih dalam filesystem yang sama (lebih efisien, tapi fs.rename() bisa gagal kalau lintas filesystem/drive berbeda di Windows — karena itu attempt fs.rename() dulu, kalau error EXDEV baru fallback ke copyFile+unlink)
   c. JIKA platform Termux DAN tipe file adalah 'photo' atau 'video':
      Jalankan termux-media-scan via child_process untuk trigger refresh galeri:
      ```js
      const { exec } = require('child_process');
      exec(`termux-media-scan "${finalPath}"`, (err) => {
        if (err) {
          console.warn(`[Transfer] termux-media-scan gagal (mungkin termux-api belum terinstall): ${err.message}`);
          // JANGAN throw/crash, ini bukan kegagalan fatal, transfer tetap dianggap sukses
        }
      });
      ```
   d. Update path final yang ditampilkan/disimpan di status request (lihat poin 5) ke lokasi BARU (bukan path internal lagi)

3. Jika TERJADI ERROR di proses pindah file (poin 2) — misal permission denied, disk penuh di lokasi tujuan, dll:
   - JANGAN biarkan ini menggagalkan status transfer yang sudah `completed` (file fisik tetap valid, hanya gagal dipindah ke lokasi "cantik").
   - File TETAP ada di folder downloads/ internal sebagai fallback aman (karena proses pindah pakai copy dulu baru unlink asal, jika copy gagal maka unlink tidak akan dijalankan, file asli di folder internal tetap aman/tidak hilang).
   - Log error ke console dengan jelas, dan jika ada cara untuk merefleksikan ini ke status request (misal field tambahan `finalPath` tetap mengarah ke folder internal sebagai fallback), lakukan itu.
```

### 5. Update Endpoint Progress (Opsional, untuk Transparansi ke User)
Jika field response di endpoint `GET /transfer/progress/:requestId` (dari hari 4) memungkinkan tanpa merombak struktur besar, tambahkan field baru:
```js
{
  ...field yang sudah ada (requestId, fileName, fileSize, bytesTransferred, percent, status),
  savedTo: finalPath  // path lengkap dimana file akhirnya tersimpan, setelah proses pindah selesai
}
```
Field ini nantinya bisa dipakai di sisi UI (pengembangan lanjutan, di luar scope spek ini) untuk menampilkan "File disimpan di: ..." ke user. Untuk sekarang, cukup pastikan backend MENYEDIAKAN informasi ini, tidak perlu ubah UI di tahap ini.

## Test "Selesai" (WAJIB dijalankan manual di KEDUA platform, jangan asumsi)

### Di Desktop (Windows, sebagai penerima)
1. Kirim file dari HP ke laptop (Windows sebagai penerima).
2. Setelah selesai, buka File Explorer, cek `D:\Downloads\Download - Lan Drop\` — file harus ada di sana dengan nama asli, BUKAN di folder `downloads/` internal project lagi.
3. Buka filenya, pastikan utuh/tidak korup (terutama untuk gambar/video, buka dan lihat preview-nya benar).
4. **Test edge case drive D: tidak ada** (jika laptop kebetulan tidak punya drive D: — kalau punya, lewati test ini dan catat sebagai "tidak bisa dites di environment ini, tapi logic fallback sudah diimplementasi"): pastikan file tetap tersimpan di fallback `<home>\Downloads\Download - Lan Drop\` tanpa error/crash server.

### Di HP (Termux, sebagai penerima)
1. Kirim FOTO (misal `.jpg`) dari laptop ke HP.
2. Setelah selesai, buka app Galeri HP langsung (TANPA menjalankan `termux-media-scan` manual seperti kemarin) — foto harus SUDAH muncul otomatis karena proses media-scan sekarang dijalankan otomatis oleh kode.
3. Kirim VIDEO (misal `.mp4`) dari laptop ke HP.
4. Cek di Galeri/app Video HP, pastikan masuk ke album/kategori video (folder `Movies`), terpisah dari foto.
5. Kirim file TIPE LAIN (misal `.pdf` atau `.zip`) dari laptop ke HP.
6. Cek lewat Termux (`ls ~/storage/downloads/`) — file ini harus masuk ke folder downloads Android biasa, BUKAN folder pictures/movies (karena bukan foto/video).
7. **Test edge case:** jika storage belum pernah disetup (kasus ini sudah lewat untuk HP yang dipakai sekarang, tapi minta AI agent menjelaskan secara teori bagaimana kode menangani ini, atau jika ada device Termux lain yang belum pernah `termux-setup-storage`, coba di situ) — pastikan transfer tetap sukses dan file tersimpan di folder `downloads/` internal sebagai fallback, tidak crash.

## Potensi Masalah
- **`fs.rename()` lintas filesystem di Windows** — kalau folder internal project ada di drive `C:` tapi tujuan akhir di drive `D:`, `fs.rename()` akan gagal dengan error `EXDEV`. Kode HARUS punya fallback ke `copyFile()` + `unlink()` untuk kasus ini, jangan asumsi `rename()` selalu berhasil.
- **Race condition kalau ada banyak transfer bersamaan dengan nama file yang sama** — jika dua file dengan nama sama diterima berturut-turut, file kedua bisa menimpa file pertama di folder tujuan akhir. Ini SUDAH menjadi keterbatasan sejak hari 4 (di luar scope untuk diperbaiki sekarang), tapi sebutkan sebagai known limitation, jangan dianggap bug baru dari fitur ini.
- **Termux tidak punya `termux-api` package terinstall** — `termux-media-scan` butuh app `Termux:API` terinstall terpisah dari Play Store DAN package `termux-api` di CLI. Jika belum ada, command akan gagal — kode HARUS menangani ini sebagai warning saja (sudah tercakup di poin 4.2.c di atas), bukan error fatal.
- **Permission denied saat menulis ke `D:\Downloads\...`** — jika karena alasan tertentu folder itu read-only atau ada masalah permission OS, tangani sebagai error yang di-log, file tetap aman di folder internal sebagai fallback (poin 4.3).

## Yang BUKAN Scope Ini
- UI untuk menampilkan "File tersimpan di: ..." ke user secara visual → field backend (`savedTo`) sudah disiapkan, tapi implementasi tampilan di frontend adalah pengembangan lanjutan terpisah.
- Membiarkan user mengubah/kustomisasi folder tujuan dari UI (misal browse folder sendiri) → di luar scope, path sudah di-hardcode sesuai requirement.
- Penanganan nama file duplikat (auto-rename jadi `file (1).jpg` dst) → bukan bug baru dari fitur ini, di luar scope untuk diperbaiki sekarang.
