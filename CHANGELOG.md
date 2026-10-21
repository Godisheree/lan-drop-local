# Changelog

Semua perubahan penting pada LAN DROP didokumentasikan di file ini.

Format berdasarkan [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/lang/id/).

## [Belum Rilis]

### Added — Fase 4 (shortcut keyboard, thumbnail, PWA, hardening mobile)

#### Fixed

- **Tombol "Foto/Video", "File Lain", dan "Teks" kirim ke port yang salah.**
  `device.port` adalah port HTTP server (3000), sedangkan transfer lewat TCP
  memakai `device.transferPort` (3001). Semua jalur kirim kini lewat
  `toTransferTarget()` sehingga port yang dipakai selalu port transfer.
  Dampulnya: kirim file lewat tombol file-picker dan kirim teks lewat UI
  sebelumnya bisa nyasar ke port HTTP dan menggantung. (Hanya drag-and-drop
  yang sebelumnya benar.)
- **Escape punya dua penangan.** Focus trap dan shortcut global sama-sama
  listened ke Escape; yang global tidak pernah terpakai karena focus trap
  memblokir propagasi. Sekarang satu sumber kebenaran: stack modal di
  `a11y.js`, `closeTopModal()` menutup modal teratas.
- **Escape & Ctrl+Enter mati di textarea.** `initShortcuts()` dulu mengabaikan
  semua shortcut saat fokus di input. Sekarang hanya kunci printable biasa yang
  diabaikan — Escape dan Ctrl+Enter tetap bekerja.
- **Mekanisme `onClose` di text.js rapuh.** Handler-nya di-pop saat dipanggil,
  jadi hanya berjalan sekali. Diganti `submitComposer()` yang eksplisit.

#### Added

- **Shortcut keyboard.** `Enter` menerima permintaan masuk, `Esc` menolak atau
  menutup jendela, `Ctrl+Enter` mengirim teks. Daftar shortcut tampil di panel
  Sambung, dan tombol terkait punya `aria-keyshortcuts`.
- **Pratinjau foto & video.** Thumbnail dibuat di server dari file yang sudah
  tersimpan memakai ffmpeg yang sudah ada (tanpa dependency baru), di-cache,
  lalu disajikan lewat `GET /thumbnail/:id`. Kalau ffmpeg tidak ada, gambar
  tetap tampil (file asli), video tanpa thumbnail.
- **Galeri media.** Grid foto/video terbaru yang diterima. Klik thumbnail
  untuk menyalin lokasi file.
- **Manifest + ikon aplikasi.** `manifest.webmanifest`, ikon 192/512/maskable,
  `apple-touch-icon` PNG, dan meta untuk iOS. Ikon dibuat oleh
  `scripts/generate-icons.js` — encoder PNG sendiri, nol dependency.
- **Panel "Aplikasi"** di Sambung: tombol pasang aplikasi, atau petunjuk
  manual per platform (Android/iOS/Desktop) plus catatan jujur soal batas
  HTTPS.
- **Hardening mobile.** Layar tidak mati saat transfer berjalan
  (`navigator.wakeLock`), peringatan sebelum menutup tab saat transfer aktif,
  dan pemeriksaan ruang disk sebelum menerima file besar (`GET /system/disk`).
- **Dokumentasi baru:** ADR-0004 (PWA di konteks HTTP LAN), ADR-0005
  (thumbnail server-side), panduan install-PWA.

#### Changed

- **Service worker hanya di secure context.** Di `http://192.168.x.x:3000`
  service worker tidak diregistrasi — browser mengabaikannya di sana. Manifest,
  ikon, dan tombol tambah-ke-layar-utama tetap berfungsi. Service worker
  aktif di `localhost` dan di deployment HTTPS. Service worker tidak pernah
  meng-cache response API (dicek oleh `verify-pwa.js`).

#### Verification

#### Fixed

- **20 import tak terpakai** dibersihkan setelah pemecahan modul — sisa
  refactor yang tak pernah dirapikan. Import mati menyembunyikan bug
  (kadang memanggil fungsi yang sudah berubah), jadi sekarang ada skrip
  `npm run check:unused` sebagai penjaga.

#### Verification

| Skrip | Hasil |
|---|---|
| `npm run check` | 38/38 file lolos |
| `npm run audit` | bersih |
| `npm run check:unused` | 0 import mati |
| `npm run smoke` | 3 viewport, 0 error console |
| `npm run verify:pwa` | 16/16 pemeriksaan lolos |
| `npm run verify:qr` | QR ter-decode OpenCV, cocok dengan URL |
| `npm run e2e` | 30/30 pemeriksaan lolos |

---

### Changed — UI/UX overhaul (Fase 0–3)

#### Fixed

- **Celah XSS lewat data jaringan.** `deviceName` dan `ip` dari UDP broadcast kini
  dirender lewat DOM API, bukan interpolasi string ke `innerHTML`. Atribut pun tidak
  lagi bisa "dib breakout" dengan tanda kutip. Lihat [ADR-0001](docs/adr/0001-frontend-modularization.md).
- **Panel Aktivitas menumpuk tanpa batas.** Transfer selesai kini otomatis melipat
  setelah 6 detik dan dikelompokkan per batch, bukan menumpuk selamanya.
- **Polling tanpa batas.** Menunggu jawaban peer yang sudah mati tidak lagi menggantung
  selamanya — muncul status "Penerima tidak merespons" beserta tombol Batal.
- **Progress 404 yang salah diperlakukan sebagai kegagalan.** Entri progres baru dibuat
  saat frame `file-start` tiba, jadi di sisi penerima ada jendela normal di mana progres
  belum ada. Sebelumnya transfer yang sehat ikut ditandai gagal.
- **Aksesori fiktif dihapus.** Kartu perangkat tidak lagi menampilkan kursor
  "klik-able" padahal klik tidak melakukan apa-apa; hint drag-drop disembunyikan di
  perangkat sentuh.
- **Handler teks didaftarkan dua kali.** `setupTextSend()` dipanggil dari dua tempat,
  sehingga tiap klik tombol kirim memicu alur dua kali.

#### Added

- **Panel "Sambung"** di header — menampilkan URL LAN + QR code untuk dipindai
  langsung dari HP. QR digenerate offline di browser, tanpa layanan eksternal.
- **Notifikasi masuk.** Judul tab dan favicon menampilkan badge saat ada permintaan
  atau teks masuk; bunyi singkat tanpa file audio (Web Audio API).
- **Indikator kecepatan & sisa waktu** pada kartu transfer, dengan smoothing EMA
  supaya angkanya tidak berosilasi.
- **Informasi folder tujuan** di sisi penerima, lengkap dengan tombol salin path.
- **Pengelompokan batch** — 10 file jadi satu kartu dengan daftar file, bukan 10 kartu.
- **Tombol Batal untuk penerima** — penerima sekarang bisa membatalkan transfer yang
  sedang berjalan.
- **Tab mobile** (Perangkat | Aktivitas) + sticky progress bar supaya progres transfer
  tidak pernah keluar dari layar.
- **Dark mode** mengikuti pengaturan sistem, plus tombol toggle manual.
- **Riwayat yang bisa dilipat**, dan panel aktivitas dengan scroll internal.
- **Aksesibilitas**: modal kini punya `role="dialog"`, focus trap, Escape untuk menutup,
  dan focus dikembalikan ke pemicunya. Status transfer diumumkan lewat live region.
- **Skrip QA**: `check-js.js`, `audit-charset.js`, `smoke.js`, `verify-qr.js`, `e2e.js`.
- **Dokumentasi**: peta produk, prinsip UX, 3 ADR, panduan arsitektur frontend, checklist QA.

#### Changed

- **Frontend dimodularkan.** `client.js` (1043 baris) dipecah jadi 15 ES module di
  `public/js/` — tanpa build step. Lihat [ADR-0001](docs/adr/0001-frontend-modularization.md).
- **`GET /me` mengembalikan URL LAN** (`urls[]`), dipakai panel Sambung.
- **Port discovery bisa diubah** lewat `DISCOVERY_PORT`, dan peer bisa didaftarkan
  manual lewat `LANDROP_PEERS` — untuk dua instance di satu host dan jaringan yang
  memblokir UDP broadcast.
- **Toast tidak lagi menimpa** — beberapa notifikasi bisa tampil bersamaan, dan
  varian `info` sekarang punya tampilan.
- **Kontras teks dinaikkan** ke WCAG 2.2 AA. Teks sekunder naik dari 3,47:1 ke 5,96:1;
  teks aksen dari 3,23:1 ke 5,43:1.
- **Nama file panjang** tidak lagi pecah di tengah karakter.
- **Header tidak lagi berdesakan di HP** — logo tidak pecah baris, chip nama perangkat
  tidak meluber, tombol Sambung jadi ikon saja.

#### Verification

| Skrip | Hasil |
|---|---|
| `npm run check` | 30/30 file lolos |
| `npm run audit` | bersih |
| `npm run smoke` | 3 viewport, 0 error console |
| `npm run verify:qr` | QR ter-decode OpenCV, cocok dengan URL |
| `npm run e2e` | 17/17 pemeriksaan lolos |

---

## [1.0.1] — 2025-09-14

### Added

- Resume transfer: file yang terputus dilanjutkan dari byte terakhir, bukan diulang
  dari nol.
- Panel riwayat transfer (`history.json`, maksimum 200 entri).
- Fallback folder simpan bila `D:\LAN-DROP` tidak tersedia.
- Tombol "Coba Lagi" pada transfer yang gagal — memakai `batchId` yang sama supaya
  penerima bisa melanjutkan dari partial.

### Fixed

- Pemilihan IP WiFi mendahulukan interface VPN/tunnel.
- Backpressure saat menerima file besar tidak lagi menumpuk byte di RAM.
- Teks masuk tidak lagi tertimpa saat composer sedang dibuka.

---

## [1.0.0] — 2025-08-xx

### Added

- Transfer file peer-to-peer lewat TCP dengan framing panjang-ter prefixed.
- Streaming langsung ke folder tujuan (tanpa file sementara terpisah).
- Auto-transcode ke H.264 untuk format yang tidak didukung Android.
- Pengiriman teks antar perangkat.
- Deteksi perangkat via UDP broadcast + Tailscale.
- Pembungkus Electron untuk Windows.
