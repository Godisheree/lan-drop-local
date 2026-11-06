# Changelog

Semua perubahan penting pada LAN DROP didokumentasikan di file ini.

Format berdasarkan [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/lang/id/).

## [1.2.12] — 2026-11-06

### Added — ikon tray tanpa Electron

Sebelumnya mode "jalan di background + ikon tray" cuma ada kalau Electron
terpasang, dan `npm i -g lan-drop-local` sengaja tidak memasangnya (240 MB).
Akibatnya justru pengguna yang paling butuh — yang meng-install lewat npm —
tidak pernah melihat tray-nya. Sekarang `electron` tidak lagi dibutuhkan sama
sekali di jalur itu, dan pola yang dipakai mengikuti 9router:

| Platform | Ikon tray | Catatan |
|---|---|---|
| Windows | PowerShell `NotifyIcon` (`System.Windows.Forms`) | Nol dependency; AV tidak protes |
| Linux/macOS | `systray2` | Di-install sekali ke `<data dir>/runtime` (~3 MB) |
| Termux/Android | — | Tidak ada notification area; baris menunya disembunyikan |

- `server/tray.js` — `startTray()`/`stopTray()`, tidak pernah melempar: tray itu
  pelengkap, server tetap jalan kalau ikon gagal dibuat.
- `server/tray-win.ps1` — menu (buka dashboard, salin alamat, keluar), klik kiri
  = buka dashboard, dan keluar sendiri kalau induknya mati (tidak ada ikon hantu).
- `server/index.js` — `--tray` / `LANDROP_TRAY=1`: nyalakan tray setelah semua
  listener siap, jangan buka browser otomatis, matikan tray saat shutdown.
  Diabaikan kalau berjalan di dalam Electron (biar tidak muncul dua ikon).
- `tui.js` — `runTray()` sekarang `spawn(process.execPath, [server/index.js,
  '--tray'])`, bukan `require('electron')`. `trayAvailable()` tidak lagi mengecek
  Electron; di Windows hanya mengecek `public/icons/icon.ico` ada.
- `scripts/generate-icons.js` — encoder ICO (BMP DIB 32-bit, 16/32/48/64/256).
  Windows menolak PNG untuk `NotifyIcon`, jadi `.ico` harus ada di paket.
- `scripts/check-tray.js` — struktur `.ico`, ukuran tray kecil, dan penjaga
  supaya Electron tidak diam-diam kembali ke jalur ini.

### Fixed — sekali jalan, prosesnya jadi banyak

Ketahuan saat menguji tray: satu `lan-drop` bisa memunculkan **tiga ikon** dan
dua proses server sekaligus. Bukan salah tray — tray cuma memperlihatkan bug yang
sudah lama ada.

`server.listen(port, host, callback)` mendaftarkan `callback` sebagai
`once('listening')`, dan listener itu **tidak dilepas** ketika listen-nya gagal
(`EADDRINUSE`). Jadi kalau 3000–3006 terpakai, tujuh callback menumpuk di server
yang sama; begitu port kedelapan berhasil, ketujuhnya menyala bersamaan:
`onListening()` jalan 7×, masing-masing menyalakan discovery, TCP transfer server,
dan ikon tray sendiri. Yang tersisa di log cuma satu baris
`MaxListenersExceededWarning` yang mudah terlewat.

- `server/index.js` — `onListening` dipasang **sekali** lewat
  `server.once('listening', onListening)`, di luar retry loop; `listenHttp` juga
  melepas handler `error` sebelum mencoba port berikutnya.
- `server/transfer.js` — `listenTransfer` melepas handler `error` **dan**
  `listening` sebelum retry; `startTransferServer()` idempoten supaya
  pemanggilan kedua tidak meninggalkan `tcpServer` lama tanpa ditutup.
- `scripts/check-tray.js` — 4 pemeriksaan baru: `onListening` tidak boleh jadi
  callback `listen()`, kedua handler harus dilepas saat retry, dan
  `startTransferServer` harus idempoten.

### Fixed — file kecil hilang tanpa pesan

File yang seluruh isinya tiba dalam **satu paket TCP** bersama frame
`file-start` (teks pendek, thumbnail, file config) hilang tanpa jejak, kira-kira
1 dari 6 percobaan. Pengirim melihat "terkirim", penerima tidak punya file, dan
log server cuma bilang `Request … selesai tanpa transfer — entri dibuang`.

Rantainya: sisa payload di paket yang sama ditulis ke stream dan `written`
langsung mencapai `actualSize`, tetapi cek "sudah selesai?" hanya ada di dalam
handler data berikutnya — yang tidak akan pernah dipanggil lagi karena tidak ada
data tersisa. Stream tidak pernah di-`end()`, pengirim menutup socket, dan
handler `close` mengira itu pembatalan → `.landrop-part` dihapus.

- `server/transfer.js` — tutup stream di jalur "payload menempel"; `catch`
  kosong di jalur `file-start` diganti logging + `transfer-save-failed`, karena
  itulah yang selama ini menyembunyikan penyebabnya.
- `scripts/check-autoapprove.js` — skenario 6c: 8 percobaan menempelkan payload
  ke paket `file-start`. Terbukti menangkap bug (0/8 tanpa fix, 8/8 dengan).

### Fixed — jendela cmd berkedip di Windows

Sejak mode background dipakai, jendela command prompt muncul lalu hilang
berulang-ulang — terlihat seperti sesuatu yang mencurigakan sedang berjalan.
Tidak ada yang berbahaya: di Windows, setiap proses console yang di-spawn tanpa
`windowsHide: true` memunculkan jendela cmd sekejap.

Yang paling sering terlihat adalah `tailscale status --json`, dipanggil
`discovery.js` tiap ~10 detik lewat cache (announce tiap 3 detik). Terukur di
mesin uji: **7 jendela console per 30 detik tanpa fix, 2 dengan fix** (dua
sisanya server dan ikon tray itu sendiri).

- `server/tailscale.js` — `version` dan `status --json`
- `server/ffmpeg.js` — deteksi `-version` dan setiap pemanggilan transcode
- `server/transfer.js` — `ffprobe`, `termux-media-scan`, `am broadcast`
- `server/platform.js` — `openBrowser` (`cmd /c start`)
- `tui.js` — server foreground dan proses tray detached
- `scripts/check-tray.js` — pemeriksaan ke-16: setiap `spawn`/`execFile` wajib
  punya `windowsHide`, supaya kedipan ini tidak kembali diam-diam.

### Fixed — label umur waktu di dashboard meloncat

"Terakhir kirim" dan "sinyal terakhir" menghitung ulang tiap detik, tetapi
anganya meloncat tidak konsisten — nyentuh 10 lalu jatuh ke 4–6. Ada dua sebab:

1. `agoText()` memakai `Math.round`. Umur 9,5 dtk tampil "10 dtk lalu", lalu
   poll berikutnya mereset data ke umur ~0 → "baru saja". Sekarang `Math.floor`:
   umur hanya boleh naik sampai data baru tiba, tidak dibulatkan ke atas lalu
   direset oleh dirinya sendiri.
2. Poll `/discovery/status` tiap 5 dtk, sedangkan announce tiap 2 dtk, jadi
   umurnya bisa menua sampai 6–7 dtk sebelum di-reset. Sekarang 2 dtk.
3. "sinyal terakhir" memakai `agoText()` (string mati) sehingga tidak ikut
   disegarkan tiap detik — beku di angka poll terakhir. Sekarang `ago()` (elemen
   hidup), sama seperti kolom lain.

- `public/js/dashboard.js` — `agoText` (`floor`), `POLL_MS.discovery: 2000`,
  "Perangkat dikenal" memakai `ago()`
- `public/sw.js` — `CACHE_VERSION` v23 (shell berubah)
- `scripts/check-dashboard-ago.js` — 8 pemeriksaan dengan waktu dipatok: batas
  pembulatan, monoton, dan penjaga agar `round`/`agoText` tidak kembali

Catatan rilis: `README.md` di tarball 1.2.10 masih versi 1.2.9 — entri changelog
dan bagian tray yang sudah di-commit belum ikut terbit. Rilis ini membawanya.

## [1.2.10] — 2026-11-06

### Fixed — PIN dashboard balik ke bawaan sendiri

PIN yang sudah diganti bisa kembali ke `123456` tanpa user menyentuhnya.
`writeNow()` di `server/settings.js` menulis **seluruh** isi cache memori ke
`settings.json`, jadi begitu ada dua server yang jalan di satu data dir — kasus
nyata: instance lama masih hidup saat `lan-drop` dijalankan lagi, atau jendela
Electron + server terminal — instance yang cache-nya masih memuat PIN lama
menghapus PIN baru ketika ia menulis setting lain (mis. toggle terima otomatis).

Sekarang yang ditulis cuma kunci yang benar-benar diubah proses itu
(`changedKeys`), digabung dengan isi disk terbaru.

- `server/settings.js` — `readDisk()` + merge per kunci
- `scripts/check-settings.js` — pemeriksaan ke-10: dua instance berbagi data dir

Catatan: instance yang sudah terlanjur jalan tetap memakai PIN lamanya di
memori sampai di-restart — nilai di disk sudah benar.

## [1.2.9] — 2026-11-03

### Added — alamat IP disamarkan sampai dibuka

Alamat LAN adalah peta jaringan rumah, dan screenshot/rekaman layar adalah cara
paling umum kebocoran itu terjadi. Sekarang setiap IP (kartu perangkat, tabel
peer, tabel penemuan, IP Tailscale) tampil **blur sejak awal**; satu klik/ketuk —
atau Enter/Spasi kalau lewat keyboard — membukanya, klik lagi menyamarkan.
`aria-label` sengaja tidak memuat nilainya, dan opsi ini bukan pengaturan yang
bisa "lupa dinyalakan": blur adalah keadaan default.

- `public/js/core/dom.js` — `ipText()` (dipakai kartu perangkat + dashboard)
- `public/css/base.css` — `.ip-blur` (di base, bukan components: dashboard tidak
  memuat components.css)
- `scripts/check-dashboard.js` — 7 pemeriksaan statis untuk penyamaran ini

### Fixed — header HP: tombol kosong, logo & nama perangkat terpotong

1. **Tombol "Sambungkan" kosong di HP.** Aturan `max-width: 640px` menyembunyikan
   labelnya dengan asumsi ada ikon pengganti — tidak ada. Sekarang labelnya tetap
   tampil (diperkecil); header tetap muat tanpa overflow di 390 px dan 360 px.
2. **Huruf terakhir "LAN DROP" terpotong 1–2 px** karena logo ikut menyusut demi
   memberi ruang ke chip nama perangkat. Logo sekarang tidak menyusut, dan chip
   nama perangkat disembunyikan di layar sempit (namanya tetap ada di dashboard).
3. **Tombol "Dashboard" selebar 44 px padahal teksnya 60 px**, jadi menabrak chip
   nama perangkat: `.icon-btn-text` kalah urutan dari `.icon-btn`. Sekarang
   `.icon-btn.icon-btn-text`.
4. **Dashboard mencetak `[object HTMLSpanElement]`** di "Perangkat dikenal" —
   `ago()` mengembalikan elemen, lalu diinterpolasi ke template string. Pakai
   `agoText()`.
5. **Kolom terakhir tabel dashboard terpotong** tepi kartu (mis. "Err" di kartu
   Penemuan perangkat). `table-layout: fixed` + sel boleh membungkus.

Catatan: petunjuk "Seret file ke sini, atau tekan Ctrl+V" memang **tidak** muncul
di HP — `.drop-hint` sudah disembunyikan CSS di perangkat sentuh, jadi tidak perlu
teks alternatif.

### Docs — README dengan banner, badge, dan screenshot

- `docs/screenshots/` — banner, UI desktop, UI HP, dan dashboard. Diambil dari dua
  instance LAN DROP yang benar-benar jalan (bukan mock), dengan riwayat dari
  transfer 2 GB sungguhan. Alamat IP di dalamnya tersamar karena fitur di atas.
- `README.md` — header bergambar + badge npm/CI/lisensi/Node, bagian Screenshots,
  ringkasan fitur, dan bagian Security. Badge CI menunjuk workflow yang baru ada.

### Changed — minta izin dulu, upload belakangan

`sendBatch()` dulu meng-upload seluruh file ke server sendiri **sebelum**
`/transfer/request` dikirim. Akibatnya dialog "Terima?" di perangkat tujuan baru
muncul setelah upload selesai (video 2 GB bisa menit-an), dan kalau ditolak semua
byte sudah kepindah percuma.

Sekarang urutannya: `/transfer/request` (nama + ukuran saja, beberapa ratus byte)
→ penerima setuju → upload dengan progres → `/transfer/send-file` → streaming.
Penolakan berhenti sebelum satu byte bergerak, dan dialog muncul seketika.

Konsekuensi protokol yang ikut dijaga: jeda antara "Terima" dan frame `file-start`
kini bisa menit-an untuk file besar, jadi `startRawReceive` tidak boleh memasang
timeout socket (memang tidak ada) — dikunci `scripts/check-send-flow.js`, dan
perilakunya diuji dengan jeda 1,5 detik di `check-autoapprove.js`.

- `public/js/features/send.js` — `uploadThenStart()`: upload per file setelah ACC,
  lalu streaming. Batal saat upload ikut menutup permintaan di server, jadi
  penerima tidak menggantung menunggu byte yang tak akan datang.
- `public/js/features/transfers.js`, `public/js/main.js` — "Kirim ulang" sekarang
  menunggu ACC lalu upload + streaming. Dulu callback-nya cuma memperbarui badge,
  jadi item hasil kirim-ulang berhenti di status "menunggu" selamanya.
- `scripts/check-send-flow.js` (+ `npm run check:send-flow`, masuk `npm test`) —
  menjaga urutan izin-dulu dan melarang timeout di `startRawReceive`.

Terima otomatis tidak berubah perilakunya: keputusannya tetap dari metadata
(nama, ukuran, ruang disk) dan tetap diuji `check-autoapprove.js` — 15 → 18
pemeriksaan, termasuk jalur berjeda. `npm test` 323 → 335 pemeriksaan;
`npm run e2e` 48/48 di Chrome nyata (termasuk batal & kirim batch).

## [1.2.5] — 2026-11-03

### Fixed — `LANDROP_SAVE_DIR` dihormati di Linux/Termux

Variabel yang dijanjikan README itu cuma dibaca lewat `getWindowsSaveDir()`,
jadi di luar Windows isinya diabaikan: folder tujuan tetap `<data dir>/downloads`
walaupun user sudah menyetel folder sendiri. Sekarang override dibaca paling
atas `resolveSaveDir()`, berlaku untuk semua platform.

Ketahuan dari CI GitHub Actions yang baru dipasang: `npm test` di ubuntu-latest
merah di pemeriksaan "file mendarat di folder simpan" (Node 18, 20, dan 22),
sementara di Windows lolos karena kebetulan lewat jalur Windows. Rilis 1.2.4
di npm terlanjur membawa bug ini.

## [1.2.4] — 2026-11-03

### Fixed — buffer upload pindah ke data dir + file ditolak langsung dihapus

Folder buffer upload dulu `path.join(__dirname, '..', 'uploads-temp')`: di
instalasi global (`npm i -g lan-drop-local`) itu berarti
`node_modules/lan-drop-local/uploads-temp`, jadi (1) `npm update`/install ulang
menghapus transfer yang sedang menunggu resume, dan (2) `fs.mkdirSync` yang
tidak dijaga melempar error di prefix read-only — server mati sebelum sempat
start. Sekarang satu sumber kebenaran `platform.getUploadDir()`:
`$LANDROP_UPLOAD_DIR` (Electron, tetap) atau `<data dir>/uploads`; gagal bikin
folder cuma jadi peringatan, server tetap jalan.

Kebocoran yang menyertainya: `startFileSend` menghapus file upload saat
`completed`/`cancelled`, tapi **tidak** saat `rejected` — padahal request yang
ditolak tidak akan pernah dimulai, jadi "dipertahankan untuk resume" hanya
menumpuk file seukuran aslinya selama 7 hari (bukti: 4 file 40 MB + 4 file
256 KB = 162 MB sisa uji coba di `uploads-temp/`). `rejected` sekarang ikut
dihapus. Sampah 162 MB itu sudah dibersihkan.

- `.github/workflows/ci.yml` — 322 pemeriksaan `npm test` jalan di Node 18/20/22
  tiap push ke `main` dan tiap PR. Sebelumnya semuanya cuma jalan kalau diingat.
- `scripts/check-security.js` — 2 cek baru: folder upload wajib di luar folder
  paket (114 → 116 pemeriksaan).
- File nyasar dibuang dari repo: `test-send.txt` (payload uji) dan
  `tailscale-discovery.patch` (patch yang sudah lama masuk `server/tailscale.js`,
  keputusan ADR-0006). `fitur-cancel-transfer.md` pindah ke `docs/product/`.
- `README.md` — bagian Changelog dirapikan: 1.2.4 memuat perbaikan keamanan
  (frame/`Host`), pindahnya buffer upload, dan aksen oranye dalam satu rilis.

### Added — batas panjang frame TCP + host guard (anti DNS rebinding)

`FrameParser` dulu membaca prefix panjang 4-byte (uint32) apa adanya: empat byte
dari siapa pun yang bisa menjangkau port transfer sudah cukup untuk menyuruh
parser menahan dan menumbuhkan buffer sebesar ~4 GB, sebelum isinya pernah
diverifikasi. Sekarang frame dibatasi `MAX_FRAME_BYTES` = 64 KB — jauh di atas
kebutuhan frame JSON header (`transfer-request` dengan nama file maksimum 200
karakter). Frame yang melebihi batas langsung ditolak: parser berhenti permanen,
buffer dibuang, dan socket ditutup (di sisi penerima, dan di sisi pengirim saat
menerima ack yang tidak masuk akal).

Header `Host` juga mulai diperiksa (`hostGuard`, dipasang sebelum
`sameOriginGuard`). `sameOriginGuard` menolak POST lintas-origin dengan
membandingkan `Origin` dan `Host` — dan DNS rebinding menyerang tepat di titik
itu: halaman di domain penyerang yang menunjuk ke `127.0.0.1` terbaca sebagai
satu origin, jadi guard-nya lolos. Sekarang yang diterima hanya `localhost`, IP
literal LAN/Tailscale/loopback, dan nama mesin ini sendiri. Nama tambahan (mis.
MagicDNS Tailscale) didaftarkan lewat `LANDROP_ALLOWED_HOSTS`;
`LANDROP_ALLOW_ANY_HOST=1` melewatkan cek ini untuk server di belakang reverse
proxy.

Keputusan lengkapnya di [ADR-0011](docs/adr/0011-batas-frame-tcp-dan-host-guard.md).
Regresi baru: `npm run check:security` naik dari 89 → 114 pemeriksaan (25 cek
baru, semuanya berbasis perilaku — frame normal/terpecah/tepat-di-batas, dan
host IP LAN/loopback/nama mesin vs domain asing/IP publik/Host kosong).

### Changed — warna aksen oren + mark logo baru

Aksen pindah dari biru (`#5B8DEF`) ke oren. Netral hitam→abu tetap, hijau/merah
tetap dipakai untuk status transfer — dua warna itu tidak boleh jadi aksen karena
sudah berarti "berhasil" dan "gagal" (prinsip UI/UX #2). Karena itu `--warning`
ikut digeser ke kuning-amber (`#F2B705`): oranye lama cuma beda 1,30:1 dari
aksen baru, jadi "peringatan" terbaca sebagai "aksi".

Kontras aksen naik: `--accent-strong` terang 4,63:1 → 5,18:1, mode gelap
`--accent` 6,55:1. Hover tombol primary sekarang menggelap
(`filter: brightness(0.92)`) alih-alih pindah ke `--accent` yang lebih terang —
teks di atas `--accent` cuma 2,85:1 dan gagal WCAG AA.

Logo: mark dibuat ulang jadi squircle gradien oren dengan panah turun bergaris
dasar ("drop"). Bentuk yang sama dipakai ikon PWA dan favicon dinamis.

- `public/css/tokens.css` — aksen oranye + `--warning` kuning-amber (terang & gelap)
- `public/css/dashboard.css` — hover tombol primary menggelap
- `public/js/main.js`, `public/js/features/notify.js` — hex lama dibuang, ikut token
- `scripts/generate-icons.js` — squircle + gradien + garis dasar, `npm run icons`
- `public/icons/*.png` — dirender ulang
- `public/manifest.webmanifest` — `theme_color` `#C2410C`
- `public/sw.js` — `CACHE_VERSION` naik ke `landrop-shell-v14`
- `docs/adr/0010-brand-color-dan-logo.md`, `docs/guides/qa-checklist.md` — kontras baru

## [1.2.2] — 2026-11-01

### Fixed — UI memulihkan sendiri saat shell service worker tertinggal

Kalau HTML dan JS yang jalan di browser berasal dari versi berbeda (cache
service worker tertinggal sesudah update), elemen wajib hilang dari DOM dan UI
mati dengan pesan teknis `Gagal memuat aplikasi: Elemen #... tidak ditemukan di
DOM`. Sekarang kondisi itu dikenali sebagai gejala cache: cache dibuang, service
worker dilepas, halaman dimuat ulang sekali, lalu jalan normal.

Dibatasi satu kali per sesi — kalau setelah dimuat ulang elemennya masih tidak
ada, berarti memang bug asli dan barulah pesannya ditampilkan, jadi halaman
tidak pernah masuk loop reload.

- `public/js/features/pwa.js` — `healStaleShell()` + `markShellHealthy()`
- `public/js/main.js` — init yang gagal karena elemen hilang memicu pemulihan itu
- `public/js/dashboard.js` — cek elemen sebelum module membacanya di scope atas
- `public/sw.js` — `CACHE_VERSION` naik ke `landrop-shell-v13`

## [1.2.1] — 2026-11-01

### Changed — README ditulis dalam bahasa Inggris

README adalah satu-satunya yang tampil di halaman npm (registry tidak punya tab
changelog), jadi teksnya pindah ke Inggris supaya kebaca oleh pemakai luar.
Isinya sama: pasang dari repo/global/GitHub, cara pakai + PIN, tabel environment,
catatan ikon tray, dan ringkasan perubahan versi terbaru yang menautkan ke file
ini. Dokumentasi lain (`docs/`, CHANGELOG) tetap bahasa Indonesia.

`CHANGELOG.md` ikut dimasukkan ke daftar `files` di `package.json`, jadi catatan
versi ini ikut terpasang bersama paketnya. Tidak ada perubahan kode.

## [1.2.0] — 2026-11-01

### Changed — bahasa UI: tanpa emoji, satu istilah untuk satu hal

Teks yang dilihat user terbaca seperti aplikasi chat, bukan seperti alat: emoji di 22
tempat (`📡 LAN DROP`, `📥 Permintaan Masuk`, `⚡ Terima otomatis aktif`, `❌ Tolak` /
`✅ Terima`), judul kartu campur Title Case dan sentence case (`Perangkat Online` di
halaman kirim vs `Perangkat online` di dashboard), satu hal dipanggil dengan tiga nama
(`Aktivitas Transfer` → `Transfer aktif` → `Riwayat transfer`), dan istilah teknis
nyelip ke layar user (`Kesehatan discovery`, `Buka UI kirim file`, `Interface`,
`Mengupload`, `WiFi`).

Sekarang `public/` tidak memuat emoji sama sekali. Ikon tema digambar CSS (separuh
lingkaran = tema terang, cakram penuh = tema gelap), ikon tipe berkas dan ikon hiasan
dihapus, status transfer ditulis sebagai kata (`Selesai`, `Gagal`, `Dibatalkan`, `Belum
dikonfirmasi`), dan baris riwayat jadi `Kirim ke <nama>` / `Terima dari <nama>`.
Istilah diseragamkan: `Transfer berjalan`, `Perangkat terhubung`, `Penemuan perangkat`,
`Penyimpanan`, `Galeri`, `Antarmuka`, `Wi-Fi`, `Mengunggah`. Aturannya dicatat di
`docs/guides/bahasa-ui.md` lengkap dengan pemeriksaan `grep` supaya teks baru tidak
menyimpang lagi. Salah ketik `perangkat mungkinmati` → `mungkin mati` ikut diperbaiki.
Karena shell PWA berubah, `CACHE_VERSION` di `public/sw.js` naik ke `landrop-shell-v12`.

### Added — halaman pantau (/dashboard) dikunci PIN, UI kirim file tetap bebas

Sebelum ini siapa pun yang bisa njangkau portnya bisa membuka `/dashboard`: riwayat
transfer, nama peer, dan seluruh isi log server. Di Wi-Fi rumah itu tidak apa-apa; di
kos, kantor, atau kafe — jaringan yang dipakai orang lain — halaman itu jadi jendela
yang memperlihatkan apa saja yang lewat. Sekarang `/dashboard` minta PIN, sementara
UI kirim file (`/`) tetap tanpa langkah tambahan: mengirim dari HP harus tetap sekali
buka, dan itu janji produknya (ADR-0007). Keputusannya dicatat di ADR-0009.

Cara kerjanya: PIN 4-8 angka, bawaannya `123456` dan **ditampilkan** (hint di halaman
login + notice di terminal) sampai user menggantinya — PIN yang tidak diketahui siapa
pun berakhir jadi "saya terkunci dari server saya sendiri". Sekali masuk, browser itu
diingat 24 jam lewat cookie `HttpOnly; SameSite=Lax` yang hidup di memori (restart
server = semua browser minta PIN lagi, jadi "keluar" benar-benar berarti). Percobaan
PIN dibatasi 10/menit per IP, PIN dibandingkan dengan `crypto.timingSafeEqual`, dan
mengganti PIN mencabut semua sesi — termasuk sesi yang barusan dipakai mengganti.
PIN disimpan di `settings.json` (`dashboardPin`); lupa PIN = hapus/edit nilai itu.

### Added — halaman PIN dan kartu "PIN dashboard"

Gerbang PIN untuk `/dashboard` (ADR-0009) sekarang punya tampilannya sendiri.
Sebelumnya halaman login cuma bentuk dasar supaya gerbangnya bisa diuji: satu
kartu di tengah dengan bahasa visual yang sama seperti UI lain (token dari
`tokens.css`, tanpa palet baru), kolom PIN besar berhuruf mono dengan spasi
lebar, tombol yang mengunci diri sambil menunggu balasan server, dan pesan yang
membedakan "PIN salah" dari "terlalu banyak percobaan" — dua hal yang butuh
tindakan berbeda dari user. Hint PIN bawaan cuma muncul selama server bilang
PIN-nya masih bawaan.

Di dashboard, kartu **PIN dashboard** menampilkan status PIN (masih bawaan /
sudah diganti), kolom PIN baru dengan validasi 4-8 angka di sisi klien, tombol
**Ganti PIN**, dan tombol **Keluar**. Sesudah PIN diganti, server mencabut
semua sesi — termasuk sesi yang barusan dipakai mengganti — jadi halaman
diberi jeda 1,5 detik menampilkan pesannya, lalu kembali ke `/dashboard` yang
otomatis jadi halaman login lagi.

`/js/login.js` masuk daftar `NEVER_CACHE` service worker, sama seperti
`/js/dashboard.js`: halaman gerbang tidak boleh menyajikan versi lama setelah
update.

### Diukur, bukan diperkirakan

Gerbangnya diuji lewat HTTP sungguhan (`scripts/check-dashboard.js`, 47 PASS / 0 FAIL)
dan sekaligus dari browser pada instance terpisah (Edge headless, 390×844): tanpa sesi
`/dashboard` mengirim halaman PIN dan `logPane` tidak ikut terkirim, PIN salah →
HTTP 401, PIN bawaan → cookie `HttpOnly` + dashboard, `POST /dashboard/pin`
`{"pin":"246810"}` → PIN lama ditolak / PIN baru diterima / `pin-info` berubah jadi
`{"default":false,"hint":null}`, logout → balik ke halaman PIN. `npm test` EXIT=0
(59/59 sintaks, 11/11 auto-approve, 9/9 settings, 9/9 routing, 24/24 TUI).

### Fixed — dua lubang gerbang yang ketemu saat audit

Audit gerbangnya sendiri (curl ke instance uji terpisah, bukan lewat browser) menemukan
dua jalan memutar yang membuat PIN-nya sia-sia:

- `GET /dashboard.html` → **HTTP 200, 9332 byte, berisi `logPane`.** Berkasnya ada di
  `public/`, jadi `express.static` menyajikannya di alamat lain tanpa lewat gerbang.
  Sekarang dialihkan (`302`) ke `/dashboard` sebelum middleware statis dipasang.
- `GET /logs?since=0` → **HTTP 200 tanpa cookie.** Isi log menyebut nama perangkat,
  alamat IP laptop, nama berkas, dan folder simpan — persis yang mau ditutup. Sekarang
  `401 {"error":"Perlu PIN dashboard"}` tanpa sesi, tetap `200` dengan sesi.
  `/history` sengaja **tidak** dikunci: panel riwayat di UI utama memakainya, dan itu
  bagian dari janji "UI kirim file tetap bebas" (ADR-0007).

Keduanya jadi pemeriksaan tetap di `scripts/check-dashboard.js`, jadi lubang ini tidak
bisa balik tanpa ada tes yang gagal. Bukti lengkap: `docs/adr/0009-pin-dashboard.md`
bagian "Audit setelah gerbang dipasang".

### Fixed — 15 temuan audit keamanan penuh (1 kritis, 3 high, 4 medium, 7 low/info)

Audit menyeluruh oleh agent di instance terpisah (`curl` + PoC TCP, `LANDROP_DATA_DIR`
di luar repo) menemukan 15 hal. Yang di bawah ini sudah **diukur ulang di sini** —
sebelum dan sesudah diperbaiki:

- **KRITIS — `POST /settings/auto-approve` jalan tanpa PIN.** Siapa pun di Wi-Fi yang
  sama cukup `curl -X POST /settings/auto-approve -d '{"enabled":true}'` → **HTTP 200**,
  lalu bisa menembakkan file ke perangkat itu **tanpa satu pun dialog**: berkas uji
  45.550 byte mendarat sendiri di folder simpan. Sekarang butuh sesi PIN (401 tanpa
  sesi), dan toggle-nya pindah dari UI kirim file ke dashboard. Halaman kirim file tetap
  menampilkan badge "terima otomatis" — tapi cuma status `enabled`, daftar peer
  allowlist tidak lagi ikut terkirim ke pemanggil tanpa sesi (nama peer di situ = daftar
  siapa yang boleh masuk tanpa dialog, peta buat penyamaran).
- **HIGH — isi foto bisa diunduh tanpa PIN.** `GET /history` balas **200** tanpa cookie
  dan menyertakan `savedTo` + `thumbnailId`; `GET /thumbnail/<id>` lalu balas **200
  `image/jpeg` 45.550 byte — byte identik dengan foto asli**, bukan thumbnail kecil
  (`ensureThumbnail` mengembalikan berkas asli saat ffmpeg tidak dipakai). Sekarang
  `/thumbnail/*` → `401` tanpa sesi, dan `/history` tanpa sesi kehilangan `savedTo` +
  `thumbnailId` — panel riwayat di UI utama tetap hidup (nama file, peer, arah, status),
  dan galeri di halaman itu hanya terisi untuk browser yang **sudah login PIN** (itemnya
  dibangun dari `thumbnailId`, jadi jendela anonim melihat riwayat saja). Versi lengkap —
  plus tombol hapus — ada di dashboard.
- **HIGH — `GET /dashboard/pin-info` membocorkan PIN-nya sendiri.** Balas
  `{"default":true,"hint":"123456"}` ke siapa pun di LAN → gerbang PIN nol nilai selama
  PIN belum diganti; tak perlu brute force, tinggal baca. Sekarang hint hanya untuk
  pemanggil **loopback** (browser di laptop yang menjalankan servernya); dari perangkat
  lain `hint: null`.
- **HIGH — cek ruang disk cuma berlaku di jalur terima-otomatis.** Transfer yang
  diterima manual lewat tombol "Terima" tidak pernah dicek terhadap ruang disk nyata,
  padahal ukuran sebenarnya baru ketahuan di frame `file-start` (pengirim bisa mengaku
  kecil lalu mengirim besar). Sekarang cek itu berlaku untuk **semua** transfer masuk;
  gagal mengukur = transfer dibatalkan, bukan ditebak.
- **MEDIUM — `POST /history/clear` tanpa PIN.** Penyerang bisa menghapus jejak file
  yang baru dia selundupkan supaya korban tidak sadar. Sekarang `401` tanpa sesi.
- **MEDIUM — teks masuk diterima tanpa tanda apa pun.** `senderName` sepenuhnya
  dikendalikan pengirim, jadi siapa pun bisa menyamar jadi "Router-Admin" dan meminta
  PIN. Perilaku kirim-cepat sengaja dipertahankan, tapi overlay-nya sekarang menampilkan
  peringatan + **alamat IP pengirim** (dari socket — satu-satunya identitas yang tidak
  bisa dipalsukan pengirim) dan menyatakan bahwa nama pengirim itu cuma klaim.
- **MEDIUM — cookie sesi berumur 30 hari lewat HTTP polos.** Sekarang cookie **session**
  (hilang begitu browser ditutup) dengan batas 24 jam di sisi server, jadi token yang
  kesadap tidak lagi berguna sebulan.

Sisa 7 temuan berlevel LOW/INFO sengaja tidak diubah — dua di antaranya karena memang
batas yang diambil ADR-0007: rate limit PIN dihitung per IP (bukan per PIN), dan
`/devices`, `/status`, `/history` (versi ringkas) tetap terbuka karena dipakai UI kirim
file. `sw.js` naik ke `landrop-shell-v11` supaya UI lama tidak nyangkut di cache.

### Diuji di jalur Wi-Fi nyata, bukan cuma loopback

`scripts/check-routes.js` menjalankan dua instance sungguhan di tiga interface mesin ini —
loopback (`127.0.0.1`), Wi-Fi (`192.168.1.6`, SSID ZAKA WIFI, WPA2), dan Tailscale
(`100.97.37.73`) — lalu menguji transfer file dua arah, transfer teks dua arah, dan
regresi "file jangan mendarat di pengirim": **8/8 PASS di jalur Wi-Fi, 7/7 di loopback,
7/7 di Tailscale**. Ditambah satu pemeriksaan baru: `/discovery/status` harus menunjukkan
broadcast benar-benar keluar dari adapter Wi-Fi (`192.168.1.6 → 192.168.1.255`,
`error=null`) — kalau broadcast mati, transfer manual masih jalan tapi HP tidak akan
menemukan laptop.

Bukti dari perangkat lain yang nyata: riwayat instance produksi mencatat penerimaan
**45.550 byte foto + satu pesan teks dari peer `CPH2579`** (HP Android) lewat Wi-Fi yang
sama, tersimpan utuh di `Downloads\LAN-DROP\Pictures`. Yang **tidak** bisa dibuktikan
dari satu mesin: kalau router kos memakai *client isolation*, dua perangkat memang tidak
bisa saling menghubungi — itu sifat jaringannya, bukan aplikasinya.

### Changed — dependency: 2 kerentanan high hilang

`npm audit` sebelumnya melaporkan **17 kerentanan (2 high)**. Dua yang high ada di jalur
produksi: `multer` 2.4.0 (DoS lewat `fileFilter` async yang menggantung setelah request
putus) dan `body-parser` 2.3.0 (bawaan Express). Setelah `multer` → 2.5.0, `express` →
5.3.0, dan `overrides.body-parser` → `^2.4.0`: **15 kerentanan (0 high)**, sisanya rantai
`electron-builder` yang cuma ada di `devDependencies` — tidak ikut terpasang di mesin
orang yang memasang paket ini (`npm i -g lan-drop-local`). `npm audit fix` tidak bisa
menyentuh rantai itu tanpa `--force` (breaking change), jadi sengaja dibiarkan.

Bonus temuan: `npm run check:security` **selalu mencetak satu baris saja** (judul bagian
pertama). Sebabnya, skrip itu me-require `server/transfer.js` → `server/logbus.js`, dan
logbus membajak `console.log` serta mendiamkannya kecuali `LANDROP_DEBUG`. Jadi 89
pemeriksaannya selama ini jalan tapi tidak pernah kelihatan — cuma exit code-nya. Satu
baris `process.env.LANDROP_DEBUG = '1'` di awal skrip mengembalikannya.

## [1.1.1] — 2026-11-01

### Fixed — port terpakai bikin server mati / jalur transfer bisu

Angka 3000 (HTTP) dan 3001 (transfer) dulu ditulis tetap di lima berkas. Kalau
salah satunya sudah dipakai aplikasi lain, dua hal terjadi: server HTTP mati
dengan stack trace `EADDRINUSE`, dan jalur transfer hanya mencetak satu baris
error lalu bisu — dashboard tetap terbuka, kirim file gagal dengan pesan
"port unreachable", sebab aslinya cuma ada di log.

Sekarang port jadi satu sumber di `server/ports.js`. Begitu bind gagal karena
`EADDRINUSE`, LAN DROP naik ke port kosong berikutnya (sampai 10 percobaan) dan
angka hasilnya dipakai di semua tempat: log, `/status`, announce discovery ke
peer, jendela Electron, dan menu ikon tray. Perpindahannya diberitahukan lewat
notice, jadi alamat dashboard yang benar tetap terlihat tanpa `--debug`.

Terukur: dengan 3000 & 3001 sudah dipakai proses lain, instance kedua otomatis
jalan dan `GET http://127.0.0.1:3002/status` melaporkan `port: 3002`,
`transferPort: 3003`, `/dashboard` membalas HTTP 200.

### Changed — port terpakai bukan lagi alasan batal di launcher TUI

Dulu mode tray menolak jalan kalau port dipakai ("matiin dulu LAN DROP lain").
Sekarang cuma catatan, karena server pindah port sendiri.

## [1.1.0] — 2026-11-01

### Added — LAN DROP bisa dipanggil dari folder mana saja (`lan-drop`)

Dulu launcher cuma bisa lewat `npm start`, jadi harus `cd` ke folder repo dulu —
merepotkan di PC, lebih merepotkan lagi di Termux. Sekarang paket punya entry
point `bin`, jadi:

```bash
npm i -g lan-drop-local
lan-drop          # dari folder mana pun
```

Belum ada di registry? Sumber yang sama bisa dipasang lewat URL tarball GitHub,
tanpa git dan tanpa login:

```bash
npm i -g https://github.com/Godisheree/lan-drop-local/archive/refs/heads/main.tar.gz
```

Tarball npm cuma membawa berkas runtime (`tui.js`, `main.js`, `preload.js`,
`server/`, `public/`) — `electron.zip` 144 MB dan berkas pengembangan tidak ikut.
Terukur setelah install global: `lan-drop` dari folder lain menyalakan server dan
`/dashboard` membalas HTTP 200.

### Added — dashboard dibuka otomatis di browser

Begitu server siap listen, dashboard-nya dibuka di browser default OS
(`cmd /c start` di Windows, `termux-open-url` di Termux, `open`/`xdg-open` di
macOS/Linux). Tiga pengecualian: di Electron (app sudah punya jendela sendiri),
kalau bukan TTY (service, cron, skrip), dan kalau `LANDROP_NO_BROWSER=1`.
Gagal buka browser bukan error — server tetap jalan.

### Changed — folder simpan Windows tidak lagi hardcode drive D:

Dulu semua file diterima mendarat di `D:\LAN-DROP\<kategori>`. Laptop yang tidak
punya drive D berarti `mkdir` gagal (`ENOENT`), dan kode jatuh ke
`%APPDATA%\lan-drop\downloads` — folder tersembunyi yang user awam tidak akan
menemukan, walau file-nya tidak hilang.

Sekarang default `%USERPROFILE%\Downloads\LAN-DROP` (selalu ada, tempat orang
cari duluan) dengan subfolder kategori yang sama: Pictures · Videos · Documents ·
Music. Mau lokasi sendiri, mis. tetap di drive D:

```bash
setx LANDROP_SAVE_DIR "D:\LAN-DROP"   # buka terminal baru setelah ini
```

### Fixed — jendela dari ikon tray terasa lambat dibuka

Klik ikon tray dulu menyisakan layar putih beberapa detik sebelum dashboard
muncul. Tiga sebabnya:

- **Jeda tetap 800 ms** (`setTimeout`) sebelum `loadURL` — dibayar setiap kali
  jendela dibuka, padahal di mode tray server sudah listen sejak app start.
  Sekarang menunggu port-nya benar-benar siap (`net.connect` ke `127.0.0.1`):
  terukur **7 ms**.
- **`loadURL` memakai `localhost`**, sedangkan server listen di `0.0.0.0` (IPv4
  saja) dan Windows mencoba `::1` lebih dulu. Terukur **207 ms** lewat
  `localhost` vs **9 ms** lewat `127.0.0.1`. Sekarang `127.0.0.1`.
- **Jendela tampil sebelum halamannya siap** — yang terlihat pertama adalah
  kerangka putih kosong. Sekarang `show: false` + tampil saat `ready-to-show`,
  dengan jaring pengaman 3 detik kalau event itu tidak datang.
- `LANDROP_TIMING=1` mencatat penanda waktu tiap fase ke
  `%TEMP%\landrop-timing.log`, supaya keluhan "kok lama" dijawab angka, bukan
  tafsiran.

Diukur dengan klik sungguhan ke ikon tray (build sesudah perbaikan): jendela
dibuat **847 ms**, terlihat **940 ms**, halaman selesai dimuat **2170 ms**.

### Added — launcher menu + ikon tray (jalan lepas dari terminal)

`npm start` dulu langsung menumpahkan server ke terminal. Sekarang ada dua cara
jalan yang sama-sama sah, dan pilihannya harus dibaca dulu: menu `↑/↓` di
terminal. Pilihan "Jalan di background + ikon tray" melepas proses dari
terminal — jendela boleh ditutup, LAN DROP tetap melayani perangkat lain, dan
matiinnya dari ikon di pojok kanan bawah.

- **`tui.js`** — menu panah tanpa dependency (`process.stdin.setRawMode` +
  escape sequence ANSI, alternate screen). Escape sequence yang tiba terpotong
  antar chunk disambung (`\x1b` dulu, `[B` belakangan) — kalau tidak, panah
  bawah terasa "kadang jalan kadang tidak".
- Pilihan tray **disembunyikan** kalau Electron belum ada (HP/Termux), bukan
  ditampilkan lalu gagal saat dipilih. Cek-nya `fs.existsSync` ke
  `node_modules/electron/dist/`, bukan `require('electron')` — index.js paket
  itu men-download binary ~240 MB kalau `dist/` kosong.
- **`npm run server` = `node server/index.js`** — yang diketik di Termux tidak
  berubah sama sekali. stdin yang bukan TTY (dipipe/skrip) juga melewati menu
  dan langsung jalankan server.
- Port yang sudah dipakai dicek dulu: LAN DROP yang sudah jalan tidak bikin
  ikon tray kedua yang diam-diam gagal.
- Ikon tray memakai `public/icons/icon-192.png` yang sudah ada — satu gambar
  untuk PWA dan tray, tidak ada aset kedua yang ikut dirawat.
- **`main.js` mode tray** (`--tray` / `LANDROP_TRAY=1`): proses hidup tanpa
  jendela; menu ikon = Buka LAN DROP, buka dashboard di browser, salin alamat
  dashboard, keluar. `window-all-closed` tidak lagi mematikan proses di mode
  ini, dan `PORT` tidak lagi hardcode di `loadURL`.
- `npm run check:tui` — uji `tui.js` tanpa terminal sungguhan (23 kasus).

#### Verification

| Uji | Hasil |
|---|---|
| `npm run check:tui` | 23/23 lolos — panah atas/bawah, Enter, Ctrl+C, escape terpotong, lingkar menu |
| `npm test` | lolos |
| Panah sungguhan di terminal (pty) | `↑/↓` menggeser sorotan baris; Enter di baris 2 → launcher keluar, proses lepas |
| Hidup tanpa terminal | launcher mati, proses Electron tetap hidup; `GET /dashboard` → 200 dan `/me` tetap menjawab |
| Ikon tray | probe `Tray.getBounds()` = `{x:1344,y:824,w:24,h:40}` — ikon benar-benar dapat tempat di notification area |

---

### Added — dashboard monitoring di `/dashboard`

Log server cuma lewat di stdout: begitu terminal ditutup (atau lampu mati),
jejak "kenapa peer-nya gak muncul" dan "transfer gagal karena apa" ikut hilang.
Pertanyaan itu tidak bisa dijawab lagi padahal jawabannya tadi ada di layar.

Dashboard ini layar pantau terpisah — sengaja beda dari UI utama yang tombolnya
gede buat satu tangan dari HP. Bedanya cuma kepadatan: tabel, banyak kolom,
desktop. Yang TIDAK berbeda: `tokens.css` (warna literal = dark mode rusak),
`core/dom.js` `el()` (nama file & nama peer itu input tak tepercaya, string
HTML dilarang), `core/api.js`, dan `core/format.js`.

9 kartu: status proses (versi, commit yang sedang jalan, uptime, port, folder
simpan/data), kesehatan discovery per interface (broadcast, terikat, error
terakhir, listener, peer tailnet), ruang disk, terima otomatis (toggle +
allowlist), perangkat online, transfer aktif (dengan tombol batal), riwayat
(dengan filter + hapus), galeri 12 thumbnail terakhir, dan log server live.

Log live butuh satu hal baru di server: `server/logbus.js` membajak
`console.log/warn/error` SEKALI di awal `server/index.js` jadi ring buffer 300
baris in-memory — `GET /logs?since=<id>` mengirim hanya baris baru (id naik
monoton; kalau server restart, id klien yang lebih besar dari id server
dikenali sebagai reset, bukan log yang hilang selamanya).

Karena log sekarang bisa dibaca di dashboard (dan disalin dari HP), terminal
tidak perlu lagi jadi tempatnya: stdout **nyaris diam** secara default, jadi
`node server/index.js` di Termux tidak lagi menumpahkan banner alamat setiap
start. Satu baris tetap dicetak — tanda servernya sudah siap sekaligus alamat
dashboard-nya, karena terminal yang benar-benar kosong membuat "sudah jalan"
dan "belum jalan" kelihatan sama:

```
✅ LAN DROP aktif — dashboard: http://localhost:3000/dashboard  •  dari perangkat lain: http://192.168.1.8:3000/dashboard
```

Baris itu dibuat lewat `logbus.notice()`, dan tetap ikut masuk log dashboard.
Yang tetap mengalir ke terminal tanpa diminta juga level `error` — kalau
servernya sendiri gagal jalan (port dipakai, folder tidak bisa ditulis),
dashboard-nya belum ada untuk dibaca. Mau ramai lagi seperti dulu:
`npm run start:debug` (= `node server/index.js --debug`) atau `LANDROP_DEBUG=1`.

Endpoint baru: `GET /status`, `GET /logs`, `GET /transfer/active`, route
`GET /dashboard`. Diverifikasi `scripts/check-dashboard.js` (masuk `npm test`):
40 pemeriksaan — bentuk tiap endpoint, penyaringan `since`, id log monoton,
paritas "setiap id yang dicari `dashboard.js` ada di `dashboard.html`" — uji
terakhir itu yang bikin kartu kosong tanpa satu pun error di console — plus
satu bagian khusus terminal: default harus diam, `--debug`/`LANDROP_DEBUG=1`
harus mencetak banner, dan error harus tetap kelihatan tanpa flag.

Kartu "transfer aktif" diuji dengan transfer sungguhan, bukan data karangan:
harness membuka soket ke port transfer dan mengirim frame `transfer-request`
(soketnya ditahan terbuka — server membuang entri pending begitu pengirim
terputus), lalu memastikan barisnya muncul sebagai arah TERIMA, namanya benar,
dan tombol Batal-nya (`POST /transfer/cancel` role `receive`) memang
mengosongkan kartu lagi. Ketemu satu celah di situ: pembatalan dulu tidak
meninggalkan
jejak sama sekali di log, jadi pertanyaan "transfer ini kenapa berhenti" tetap
tidak terjawab walau lognya sudah ada — sekarang `cancelIncomingTransfer()` dan
`cancelOutgoingTransfer()` masing-masing mencatat satu baris.

Ikut diperbaiki: service worker dulu menulis SETIAP navigasi ke entri shell
`'/'`, jadi membuka `/dashboard` sekali membuat shell offline user berisi
dashboard — buka app tanpa koneksi, yang muncul layar pantau, bukan UI kirim
file. Sekarang hanya URL root yang mengisi shell; `CACHE_VERSION` naik ke
`landrop-shell-v8` (index.html berubah: ada tautan kecil 📊 di header).

### Changed — dashboard: angka yang berdetak, bukan tangkapan layar

Keluhan pertama setelah dipakai: "uptime-nya gak jalan, harus refresh dulu".
Penyebabnya bukan bug tampilan — server memang cuma mengirim `uptimeSeconds`
saat polling (10 dtk), jadi angkanya melompat 10 dtk sekali dan diam di
antaranya. Sekarang browser yang menghitung sendiri: yang disimpan adalah
"uptime saat jawaban itu tiba" + kapan tiba, lalu detiknya ditambah tiap detik
lewat detak lokal 1 dtk. Detak yang sama menghidupkan jam (sampai detik) dan
SEMUA label umur waktu — "terakhir terlihat 8 dtk lalu" tidak lagi beku sampai
polling kartu berikutnya. Nol request tambahan: semuanya di memori browser.

Yang ikut dibuat hidup:

- **Kartu transfer** di-poll 1 dtk (dulu 2) dan sekarang menampilkan kecepatan
  + sisa waktu, dihitung dari selisih dua polling (`bytesTransferred`).
  "45%" yang diam dua menit tadinya tidak bisa dibedakan antara lambat atau
  macet; sekarang tertulis "507,4 KB/s • sisa 18 dtk". Snapshot per requestId
  dibuang saat transfernya hilang, jadi petanya tidak tumbuh sepanjang umur
  halaman.
- **Riwayat bisa diklik** — satu baris terbuka jadi rincian (waktu, arah,
  status + alasan, nama file, ukuran, peer, folder tujuan). Tabel 7 kolom tidak
  kebaca di HP; rincian ini juga yang membuat "Tersimpan di" bisa dibaca utuh,
  bukan terpotong. Baris yang sedang dibuka bertahan melewati refresh 5 dtk.
  Bisa juga lewat keyboard (Enter/Spasi), bukan cuma klik.
- **Pesan singkat (toast)** untuk aksi user: log disalin, setelan disimpan,
  transfer dibatalkan, riwayat dihapus. Sebelumnya umpan baliknya cuma berubah
  di dalam kartunya sendiri — di HP kelihatan seperti tidak terjadi apa-apa.
- **Error baru muncul sendiri**: toast + angka di judul tab, sekali per baris,
  lalu hilang begitu lognya disentuh. Ini yang paling dicari orang, tapi
  kartunya paling bawah — dan muat pertama tidak dihitung "error baru"
  (300 baris sejarah bukan notifikasi).
- **Pintasan keyboard** R (muat ulang), E (error saja), F (ikuti otomatis),
  C (salin log).

Diukur di browser sungguhan, bukan diklaim: uptime 17 mnt 36 dtk → 38 → 40
dalam dua detik tanpa satu pun reload; satu transfer lambat buatan (peer palsu
12 MB, dikirim 512 KB tiap 0,7 dtk) terbaca 25% → 96% dengan kecepatan
507 KB/s–1,0 MB/s dan sisa 18 dtk → 1 dtk, filenya mendarat utuh 12.582.912
byte.

### Fixed — "terkirim" sekarang berarti file benar-benar tersimpan

Keluhan: kirim lewat Tailscale, aplikasi bilang terkirim, tapi di Pictures
tidak ada file baru. Penyebabnya bukan setelan terima otomatis: pengirim
menandai `completed` begitu semua byte masuk buffer socket. Penerima yang mati
di tengah, gagal `rename` `.part` → nama akhir, atau gagal tulis tetap bikin
pengirim bilang "terkirim" — UI-nya berbohong dan file-nya hilang tanpa jejak.

Bug-nya direproduksi dulu, bukan ditebak. Uji dengan penerima palsu: (a) simpan
penuh, (b) baca semua byte lalu RST tanpa menulis apa pun. Kode lama: kasus (b)
→ status `completed`, folder penerima kosong. Setelah perbaikan → `unconfirmed`
plus alasan yang bisa dibaca user.

Yang berubah:

- **Penerima (`server/transfer.js`)** mengirim frame setelah rename `.part` →
  nama akhir sukses: `{type: 'transfer-saved', savedTo, fallback}`, atau
  `{type: 'transfer-save-failed', reason}` kalau gagal simpan (rename error /
  write error). `fallback: true` = penerima terpaksa menulis ke folder internal
  (`$LANDROP_DATA_DIR/downloads`), artinya file **tidak** akan muncul di Galeri
  HP — dulu user tidak punya cara tahu ini.
- **Pengirim** cuma menandai `completed` kalau frame ACK tiba. Byte habis tanpa
  frame = `unconfirmed`, frame gagal = `failed` + alasan penerima diteruskan apa
  adanya. `savedTo` dari penerima ikut dicatat di riwayat.
- **UI (`public/js/features/transfers.js`, `history.js`)** dapat status baru
  `unconfirmed` (ikon ⚠️, tombol "Coba Lagi" tersedia), alasan tampil di baris
  transfer dan di riwayat. Typo lama `❌ Gagal —iksa koneksi` ikut dibetulkan.
- **`scripts/check-ack.js`** (9 pemeriksaan, masuk rantai `npm test`) menjalankan
  penerima palsu 3 mode — simpan / mati tanpa ACK / gagal simpan — supaya
  pengirim tidak pernah lagi bilang sukses tanpa file di ujung sana.

- **`public/sw.js`**: CACHE_VERSION → `landrop-shell-v7` supaya PWA di HP
  benar-benar mengambil `transfers.js` dan `history.js` versi baru.

Catatan kompatibilitas: penerima versi lama (belum di-pull) tidak mengirim ACK,
jadi kiriman ke perangkat itu tampil `unconfirmed` — sengaja, lebih baik
"belum dikonfirmasi" daripada "terkirim" palsu. Perbarui kedua perangkat supaya
statusnya kembali hijau.

#### Verification

| Skrip | Hasil |
|---|---|
| `npm run check:ack` | 9/9 — pada kode lama kasus "penerima mati tanpa ACK" = `completed` walau folder penerima kosong |
| `npm test` | semua suite lolos, exit 0 |
| `npm run e2e` | 38/39 (1 gagal: cek `discovery listener` yang sudah gagal sebelum perubahan ini) |

### Fixed — setting terima otomatis bertahan setelah restart

Toggle "Terima otomatis" dulu bisa kembali mati sendiri setelah `Ctrl+C` atau
tutup jendela Electron. Penyebabnya bukan di frontend: `settings.json` ditulis
lewat timer debounce 300 ms, dan proses yang sudah mati tidak pernah
menjalankan timer yang belum jatuh tempo. Semua nilai yang diubah user dalam
300 ms terakhir kalah cepat dengan prosesnya.

Yang berubah:

- **`server/settings.js` menulis segera, tanpa timer.** Satu perubahan setting =
  satu klik user, jadi menundanya cuma menciptakan jendela di mana nilai sudah
  berubah di UI tapi belum ada di disk. Riwayat tetap di-debounce 300 ms karena
  batch transfer bisa memicu banyak entri sekaligus.
- **`server/history.js` dapat `flushNow()`**, dipanggil dari `shutdown()`
  (`SIGINT`/`SIGTERM`) di `server/index.js` dan dari `before-quit` di `main.js`.
  Sebelumnya transfer yang selesai beberapa ratus milidetik sebelum app ditutup
  juga hilang dari riwayat — kelas bug yang sama.
- **`npm run check:settings`** (9 pemeriksaan) menjalankan tiap kasus di proses
  anak yang **mati segera** setelah mengubah nilai, jadi hasilnya tidak
  tergantung kecepatan mesin: toggle nyala/mati langsung mendarat, allowlist
  peer ikut tersimpan, nilai terbaca lagi setelah restart, peer kosong dibuang,
  riwayat tertulis saat proses berhenti rapi, dan dua penjaga regresi yang
  memastikan `flushNow()` masih dipanggil di jalur keluar.

#### Verification

| Skrip | Hasil |
|---|---|
| `npm run check:settings` | 9/9 — sebelum perbaikan skrip yang sama melaporkan **0/6 GAGAL** (bug-nya direproduksi dulu, bukan ditebak) |

Uji langsung: nyalakan lewat `POST /settings/auto-approve`, bunuh proses tanpa
menunggu, jalankan lagi → `{"enabled":true}`.

---

### Added — salin nama file dari baris transfer

Habis kirim atau terima, nama file sering dibutuhkan lagi: ditempel ke chat,
dipakai untuk rename di tujuan, atau dicari di galeri. Nama panjang sudah
terpotong `truncate` di baris transfer dan tidak bisa diseleksi di layar HP,
jadi tiap baris transfer sekarang punya tombol **📋 Nama**.

#### Added

- **Tombol "📋 Nama" di setiap baris transfer** (panel Aktivitas) — untuk
  pengirim maupun penerima, sejak transfer mulai sampai selesai.
  `aria-label`-nya membawa nama file utuh, jadi screen reader dan tooltip tetap
  membacanya walau teks di layar terpotong.
- **Toast konfirmasi** "Nama file disalin" / "Gagal menyalin" — tanpa itu user
  menekan tombol tanpa tahu hasilnya.
- `copyPath()` di `public/js/features/transfers.js` digeneralisasi jadi
  `copyText(text, okMessage)`; tombol "Salin" di baris lokasi folder sekarang
  memakai fungsi yang sama.

#### Catatan implementasi

- **Jalur fallback clipboard itu yang benar-benar dipakai di HP.** LAN DROP
  dibuka lewat `http://192.168.x.x` — bukan secure context — jadi
  `navigator.clipboard` tidak ada dan `document.execCommand('copy')` yang
  jalan. Diuji langsung di origin LAN: `typeof navigator.clipboard` =
  `undefined`, klik nyata → toast "Nama file disalin", 0 `<textarea>` sisa.
- **Nama file dari peer = input tak tepercaya.** Tombolnya dibuat lewat `el()`
  dengan `text`/atribut, bukan HTML.
- `CACHE_VERSION` naik ke `landrop-shell-v6` (`transfers.js` dan
  `components.css` ada di daftar precache).

#### Verification

| Skrip | Hasil |
|---|---|
| `npm run smoke` | 3 viewport bersih; `Copy name : btn=true clipboard=true` di ketiganya — klik nyata lewat `Input.dispatchMouseEvent`, nama file terbaca kembali dari clipboard |
| Cek manual `http://192.168.1.4:3000` | `isSecureContext=false`, `navigator.clipboard` undefined, toast sukses — jalur fallback terbukti jalan |

Catatan uji: klik di smoke harus lewat protokol input CDP, bukan `btn.click()`
dari skrip — `navigator.clipboard.writeText()` menuntut aktivasi user, jadi
klik programatik membuat tombol tampak gagal padahal klik sungguhan berhasil.
Panel Sambung juga harus ditutup dulu: overlay-nya menutupi baris transfer.

---

### Added — terima otomatis (auto-approve)

Satu perangkat bisa dijadikan "drop box": nyalakan **Terima otomatis** di panel
Sambung, dan perangkat itu langsung menerima file dari perangkat lain tanpa
jendela terima/tolak. Gunanya untuk perangkat yang memang jadi tujuan (laptop
yang ditinggal menyala, HP yang dipakai sebagai penampung foto).

Saat aktif, muncul badge **⚡ Terima otomatis aktif** di bawah header — status
ini harus terlihat tanpa membuka panel, karena artinya perangkat berubah jadi
penampung terbuka.

#### Added

- **Toggle di panel Sambung**, di bagian "Terima otomatis", lengkap dengan
  penjelasan singkat apa yang terjadi kalau dinyalakan.
- **Allowlist peer opsional.** Saat toggle aktif, daftar perangkat yang terdeteksi
  muncul dengan checkbox. Tidak ada yang dicentang = semua perangkat boleh.
  Peer yang sudah dicentang tapi sedang offline tetap tampil supaya centangnya
  bisa dicopot.
- **Transfer otomatis muncul di panel Aktivitas** dengan label
  "⚡ Diterima otomatis" — bukan mendarat diam-diam di folder.
- **Pengirim melihat alasan penolakan otomatis.** Kalau ruang disk penerima
  tidak cukup, pengirim membaca "Ruang disk penerima tidak cukup untuk terima
  otomatis", bukan "Ditolak penerima" yang bikin salah paham.
- **`GET`/`POST /settings/auto-approve`**, tersimpan di `settings.json` dalam
  data dir (cache memori + tulis atomic; tulisannya **segera**, bukan
  di-debounce seperti `history.json` — lihat entri "setting bertahan" di atas).

#### Catatan implementasi

- **Keputusannya di SERVER, bukan di frontend.** Polling frontend berhenti saat
  tab disembunyikan (`visibilitychange`), jadi kalau logikanya di sana mode ini
  cuma jalan selama ada yang menatap layar. Pola ini sudah ada: frame
  `kind: 'text'` juga diterima otomatis di sisi server.
- **Ukuran dari `transfer-request` adalah klaim, bukan fakta.** Cek awal memakai
  angka itu, lalu dicek ulang di frame `file-start` — angka itulah yang
  benar-benar ditulis ke disk, dan bisa lebih besar (pengirim jahat, atau
  transcoding ffmpeg di sisi pengirim). Ukuran yang tidak masuk akal (`NaN`,
  `<= 0`) dan ukuran yang melebihi ruang bebas membatalkan transfer **sebelum**
  satu byte ditulis.
- **Fail-closed.** Kalau ruang disk tidak bisa diukur (`statfs` gagal, drive
  belum terpasang), permintaan **ditolak** — bukan diterima dengan harapan.
- **Resume dihitung dari sisa, bukan ukuran penuh.** Transfer 2 GB dengan
  partial 1,9 GB hanya butuh 100 MB ruang baru; memakai ukuran penuh bikin
  transfer itu ditolak selamanya.
- **`getSaveDirFreeSpace()` pindah ke `server/platform.js`**, menggantikan loop
  probe yang dulu ditulis inline di `/system/disk`. Sekarang dipakai dua tempat.
- **Entri `pendingRequests` dibuang saat socket tertutup**, apa pun statusnya —
  bukan cuma saat `pending`. Sebelumnya transfer yang diterima tapi gagal
  sebelum `file-start` meninggalkan entri hantu yang membuat frontend
  menampilkan baris progres yang tidak pernah selesai.
- `CACHE_VERSION` naik ke `landrop-shell-v5`; `/js/features/autoapprove.js`
  masuk daftar precache.

#### Fixed

- **Toggle "Terima otomatis" tidak terlihat.** Blok-nya dulu duduk di bawah
  "Status jaringan" dan daftar diagnostik — di jendela 1100x750 (ukuran default
  app Electron) posisinya ~1021 px dari atas panel yang cuma menampilkan 660 px,
  jadi user harus menggulir jauh ke bawah untuk menemukannya. Blok-nya
  dipindah ke **atas QR**: toggle terlihat tanpa menggulir, dan QR tetap utuh di
  dalam area terlihat (diukur: toggle 209–289 px, QR 297–571 px, panel 660 px).

#### Verification

| Skrip | Hasil |
|---|---|
| `npm run check:autoapprove` | 11/11 — toggle mati tidak menerima, ukuran tak diketahui ditolak, klaim 1e15 ditolak, file ukuran wajar mendarat utuh, klaim palsu di `file-start` tidak menulis apa pun, tidak ada entri pending tertinggal |

---

### Added — tempel dari clipboard (Ctrl+V)

Kirim tanpa menyeret dan tanpa memilih file: salin file, gambar, atau teks di
mana saja, lalu tekan **Ctrl+V** saat kursor ada di halaman LAN DROP. Tidak
perlu mengklik area mana pun lebih dulu.

Jenis isi dideteksi di browser, bukan di server — event `paste` sudah membawa
`clipboardData`, jadi tidak ada satu pun round-trip HTTP tambahan hanya untuk
menebak yang ditempel itu file atau teks:

| Isi clipboard | Jalur yang dipakai |
|---|---|
| File / gambar (termasuk "Copy image" dari browser) | Jalur kirim file yang sudah ada (`sendBatch`) |
| Teks biasa | Jalur kirim teks yang sudah ada (`sendText`) |

#### Added

- **Ctrl+V di badan halaman.** Target = perangkat teratas di daftar; kartu
  tersebut berkedip sebagai konfirmasi visual ke mana isinya pergi. Kalau
  belum ada peer, muncul toast peringatan — bukan diam.
- **`Ctrl+V` terdaftar di panel Sambung** beserta hint pada kartu perangkat
  ("Seret file ke sini, atau Ctrl+V untuk menempel").

#### Catatan implementasi

- **Gambar dari "Copy image" tetap tertangkap.** Sebagian browser hanya
  mengisi `clipboardData.items` (`kind: 'file'`) dan membiarkan
  `clipboardData.files` kosong — tanpa fallback `getAsFile()` gambar akan
  terkirim sebagai teks.
- **Paste di kolom isian tidak direbut.** Composer teks dan modal yang sedang
  terbuka menang atas handler global, supaya menempel ke textarea tetap
  berperilaku normal.
- **`preventDefault` juga dipanggil saat belum ada peer.** Kalau tidak,
  browser menjalankan paste native (mis. membuka file di tab baru) sambil
  app menampilkan peringatan — dua reaksi untuk satu aksi.
- `CACHE_VERSION` di `public/sw.js` naik ke `landrop-shell-v3` dan
  `/js/features/paste.js` masuk daftar precache.

#### Verification

| Skrip | Hasil |
|---|---|
| `npm test` | check + audit + check:unused + check:security + check:identity + check:routing lolos |
| `npm run e2e` | 39/39 — 2 instance: paste file tersimpan utuh (1 MB), paste teks tampil di penerima, paste di textarea tidak direbut |
| `npm run smoke` | 3 viewport: paste ditangani, kartu berkedip, peringatan tanpa peer, 0 error console |

---

### Fixed — alamat peer stabil per jalur (LAN / Tailscale)

Kirim lewat Tailscale bisa mendarat di `localhost:3000`. Akar masalahnya
tiga: alamat peer disimpan di satu field (yang terakhir datang menimpa
yang sebelumnya → IP "berganti-ganti"), `getLANIP()` mengembalikan string
`'localhost'` saat device tidak punya interface LAN (HP di data seluler), dan
pemilihan jalur yang sudah ada di API tidak pernah dipakai.

#### Fixed

- **Kiriman mendarat di server sendiri.** Peer yang tidak punya interface LAN
  (HP di data seluler + Tailscale) menyiarkan `ip: 'localhost'` — dan peer
  menganggap itu alamat yang bisa dihubungi, padahal itu berarti "mesin ini".
  Sekarang alamat palsu tidak pernah tersimpan (dipakai alamat sumber paket),
  `getLANIP()` mengembalikan `null` bukan `'localhost'`, dan target yang
  menunjuk ke diri sendiri ditolak dengan pesan jelas.
- **IP peer berganti-ganti.** Satu peer bisa punya alamat LAN **dan**
  Tailscale; sekarang keduanya disimpan terpisah per jalur dan frontend
  memilih jalurnya sesuai link yang sedang dibuka (Tailscale → Tailscale,
  WiFi → WiFi, localhost → Tailscale dulu). Kartu device, tombol kirim, dan
  log server semuanya konsisten.
- **Log tidak menyebut jalurnya.** Setiap permintaan keluar sekarang
  mencatat peer + alamat + jalurnya (`via tailscale`), dan timeout menjelaskan
  kemungkinan penyebabnya.
- **Nama device di HP Termux = "localhost".** Sekarang diambil dari model HP
  (`OPPO A38`), dan bisa dioverride dengan `DEVICE_NAME="nama kamu"`.
- **Kegagalan broadcast diemkan.** `EHOSTUNREACH`/`EACCES` dulu disembunyikan
  — sekarang dicatat per interface dengan penjelasan (mis. "VPN/Tailscale
  ambil alih default route"), di-dedupe per menit.

#### Added

- **`GET /discovery/status`** — status diagnostik read-only: broadcast per
  interface, listener UDP, jumlah peer, status Tailscale. Dibuat supaya
  "device tidak pernah muncul" punya jawaban, bukan cuma gejala kosong.
- **Blok "Status jaringan" di panel Sambung** + checklist 4 syarat supaya
  user tahu apa yang harus dicek (termasuk: kedua device harus menjalankan
  LAN DROP sendiri).
- **Panel Sambung menjelaskan identitas server.** "Halaman ini milik
  DESKTOP-GK51EBL" — sebelumnya HP yang membuka QR laptop menampilkan nama
  laptop dan dikira itu namanya sendiri.
- **Skrip regresi baru:** `npm run check:routing` (perilaku routing peer),
  `npm run check:identity` (nama device), `npm run check:routes` (2 instance
  sungguhan di 3 jalur nyata: loopback, WiFi, Tailscale — file & teks dua
  arah, isi file identik, dan file tidak boleh mendarat di server pengirim).

#### Verification

| Skrip | Hasil |
|---|---|
| `npm test` | check + audit + check:unused + check:security + check:identity + check:routing lolos |
| `npm run check:routes` | 21/21 lolos — loopback, WiFi, dan Tailscale, file & teks dua arah |
| `npm run e2e` | 32/32 pemeriksaan lolos |
| `npm run smoke` | 3 viewport, blok status ter-render, 0 error console |

---

### Security — hardening setelah audit keamanan

Audit dari scanner + review manual menemukan beberapa celah yang bisa dieksploitasi
dari device mana saja yang bisa njangkau port HTTP LAN DROP. Semuanya diperbaiki di
rilis ini; tidak ada perubahan API yang mengganggu user.

#### Fixed

- **Arbitrary file read lewat `/transfer/send-file`.** Endpoint ini menerima
  `filePath` apa adanya dari body request dan cuma dicek "ada atau tidak".
  Artinya siapa pun yang bisa njangkau port 3000 bisa bikin device lain
  mengirim file apa pun di disk (SSH key, cookie browser, file wallet) dengan
  menyamar sebagai peer yang terima transfer. Sekarang path-nya wajib berada di
  dalam folder upload (`assertInsideUploads()`), dan pesan error tidak lagi
  membocorkan path absolut.
- **Command injection di Termux.** Media scan memakai `exec()` dengan nama file
  dari peer yang dipakai mentah-mentah — nama file berisi `$(...)` atau
  backtick dieksekusi shell saat file diterima. Sekarang pakai `execFile()`
  (argumen terpisah, tanpa shell), dan path untuk `am broadcast` di-encode
  sebagai URI.
- **SSRF lewat ffmpeg/ffprobe.** ffmpeg mem-*probe* isi file, bukan ekstensi:
  file dari peer berformat `.ts` yang isinya playlist M3U8 bikin server ambil
  URL pilihan penyerang (mis. metadata cloud `169.254.169.254`). Jalur transcode
  dan remux sekarang pakai `-protocol_whitelist file` + `-nostdin`, sama seperti
  jalur thumbnail yang sudah aman.
- **Dependency produksi bermasalah.** `multer` 2.2.0 → 2.4.0 (4 advisory DoS),
  `proxy-addr` 2.0.7 → 2.0.8 (IP spoofing, severity critical),
  `qs` 6.15.3 → 6.16.1. `npm audit --omit=dev` sekarang **0 vulnerability**.
  Advisory di dev-dependency (`electron-builder`) cuma build-time, tidak ikut
  terkirim ke user.
- **Bypass SSRF lewat hostname.** Validasi target IP semula menerima hostname
  apa pun yang lolos charset — jadi `metadata.google.internal` bisa diselundupkan
  lewat paket announce UDP palsu, lalu server membuka koneksi ke sana. Sekarang
  **hanya IP literal** yang diterima (IPv4/IPv6, termasuk IPv4-mapped
  `::ffff:192.168.x.x`). Hostname hanya boleh kalau operator daftarkan sendiri
  lewat `LANDROP_PEERS`. Bentuk angka (`2130706433`) juga ditolak.
- **Allowlist upload masih leksikal.** Path dicek dengan `path.resolve` +
  `path.relative`, jadi symlink/junction di dalam folder upload yang mengarah
  ke luar bisa lolos. Sekarang ada cek kanonik `fs.realpathSync`.
- **Error server membocorkan stack trace.** JSON yang rusak dibalas HTML
  bawaan Express yang berisi stack trace + path absolut, dan tanpa header
  keamanan. Sekarang: header keamanan dipasang sebelum parser body, dan ada
  global error handler yang balas JSON bersih (`Format JSON tidak valid`,
  `Terjadi kesalahan di server`).

#### Added

- **`server/security.js`** — satu tempat untuk kontrol HTTP: security headers
  (CSP, `nosniff`, `X-Frame-Options`), origin guard (POST lintas-origin dari
  halaman web lain ditolak), rate limiter per IP, dan validasi target IP.
- **Target IP cuma LAN/Tailscale.** `/transfer/request` dan
  `/transfer/request-text` menolak alamat di luar jaringan privat/CGNAT
  (Tailscale). Ini menutup SSRF ke host publik. Peer di luar LAN bisa tetap
  dipakai dengan `LANDROP_ALLOW_PUBLIC_TARGETS=1`.
- **Batas upload.** Multer sekarang punya `limits`: ukuran per file
  (default 2 GB, `LANDROP_MAX_UPLOAD_MB`), jumlah file, jumlah field, jumlah
  part. Error limit dibalas 413 dengan pesan jelas, bukan 500 HTML.
- **Rate limit.** Endpoint yang mengubah state dibatasi 600 request/menit per
  IP (cukup untuk batch 50 file); `/history/clear` dibatasi 20/menit.
- **`npm run check:security`** — regression check buat semua kontrol di atas:
  path allowlist, target IP, header, rate limit, larangan `exec()`, dan
  whitelist protokol ffmpeg. Jalankan tiap kali menyentuh `server/`.

#### Known limitation (bukan bug, memang desain)

- **Belum ada autentikasi.** Semua endpoint terbuka untuk device di jaringan
  yang sama — itu inti produk "nol setup". Kontrol di atas menutup jalur abuse
  yang murah, tapi tidak menggantikan autentikasi. Kalau LAN-nya tidak
  sepenuhnya dipercaya, jalankan server di jaringan yang lebih sempit atau
  pakai Tailscale yang sudah ada.
- **HTTP tanpa TLS.** Designed untuk LAN; bukan untuk internet terbuka.

#### Verification

| Skrip | Hasil |
|---|---|
| `npm test` | check + audit + check:unused + check:security lolos |
| `npm run check:security` | 75/75 pemeriksaan lolos |
| `npm run e2e` | 30/30 pemeriksaan lolos (transfer nyata dua arah) |
| `npm audit --omit=dev` | 0 vulnerability |

---

### Fixed — Tailscale di HP/Termux (tanpa CLI)

Tailscale di HP biasanya **tidak punya CLI `tailscale`** — aplikasinya dari
Play Store cuma bikin interface VPN. Akibatnya log server di Termux tidak
pernah menampilkan alamat Tailscale, padahal device-nya sebenarnya sudah
terhubung ke tailnet.

#### Fixed

- **Alamat Tailscale cuma dicek saat server start.** Kalau Tailscale dinyalakan
  **setelah** Termux, log startup sudah lewat dan alamatnya tidak pernah
  muncul. Sekarang alamat dipantau tiap 3 detik dan langsung dicetak begitu
  muncul (atau hilang), jadi tidak masalah urutan nyalanya.
- **Tailscale dianggap "Wi-Fi" di Android.** Di Android, aplikasi Tailscale
  membuat interface VPN bernama `tun0` — bukan "Tailscale" — jadi tidak
  ke-filter dari daftar alamat LAN. Alamat CGNAT 100.x sempat muncul sebagai
  "Wi-Fi". Sekarang alamat Tailscale dikenali dari **rentang alamatnya**
  (100.64.0.0/10) dan ditampilkan terpisah, sesuai dokumen ADR-0006.
- **CLI Tailscale di Windows tidak selalu ada di PATH.** Binary-nya ada di
  `C:\Program Files\Tailscale\`, tapi tidak otomatis masuk PATH — server
  menganggap device "tidak punya CLI" padahal peer tailnet bisa ditemukan.
  Sekarang lokasinya dicari di PATH + lokasi install umum (Windows, macOS,
  Linux, Termux).

#### Fixed

- **Broadcast LAN gagal kalau Tailscale/VPN ambil alih default route.**
  Announce dikirim ke `255.255.255.255` yang lewat default route, jadi kalau
  Tailscale aktif, broadcast bisa gagal (`EHOSTUNREACH`) — peer di WiFi yang
  sama jadi tidak pernah ditemukan. Sekarang broadcast dikirim **per
  interface** ke alamat broadcast interface itu (192.168.1.255), dengan
  socket yang bind ke IP interface tersebut.
- **Alamat Wi-Fi bisa berubah (DHCP).** Kalau router memberi IP baru, URL
  dan QR di panel Sambung ikut berubah — perangkat kedua harus scan ulang.
  Log startup selalu menampilkan alamat yang sedang dipakai.

#### Notes

- **CLI cuma buat cari peer**, bukan buat tahu alamat sendiri. Alamat sendiri
  selalu dibaca dari network interface — itu yang bikin HP/Termux (tanpa CLI)
  tetap bisa jalan. Device tanpa CLI **tidak bisa mencari peer duluan**, tapi
  **tetep bisa ditemukan** peer lain lewat reply-back di `server/discovery.js`.
- Kalau alamat Tailscale belum muncul di log Termux, cek dulu: aplikasi
  Tailscale di HP sudah benar-benar "connected" (bukan sekadar terinstall)?
  Alamat CGNAT hanya diberikan setelah VPN-nya aktif.

---
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

#### Fixed

- **20 import tak terpakai** dibersihkan setelah pemecahan modul — sisa
  refactor yang tak pernah dirapikan. Import mati menyembunyikan bug
  (kadang memanggil fungsi yang sudah berubah), jadi sekarang ada skrip
  `npm run check:unused` sebagai penjaga.
- **Deteksi ffmpeg terduplikasi.** `server/transfer.js` masih punya salinan
  penuh `FFMPEG_CANDIDATES` + `checkFfmpeg()` padahal `server/ffmpeg.js`
  sudah dibuat untuk itu. Akibatnya **ffmpeg dipindai dua kali** (mahal,
  ~5 detik tiap kali) dan kedua salinan bisa menghasilkan path berbeda.
  Sekarang satu sumber kebenaran di `server/ffmpeg.js`, termasuk
  `getFfprobePath()` yang diturunkan dari path ffmpeg.

#### Added

- **Alamat Tailscale di panel Sambung.** Kalau Tailscale aktif, alamat
  tailnet (100.x.x.x) ikut tampil dan bisa dipilih untuk QR — sehingga file
  bisa dikirim ke perangkat yang **tidak** di WiFi yang sama. Default tetap
  alamat LAN (nol setup), dan petunjuk di panel menyesuaikan alamat yang
  dipilih. Lihat [ADR-0006](docs/adr/0006-tailscale-di-panel-sambung.md).

#### Verification

| Skrip | Hasil |
|---|---|
| `npm run check` | 39/39 file lolos |
| `npm run audit` | bersih |
| `npm run check:unused` | 0 import mati |
| `npm run smoke` | 3 viewport, 0 error console, selector QR terverifikasi |
| `npm run verify:pwa` | 16/16 pemeriksaan lolos |
| `npm run verify:qr` | QR ter-decode OpenCV, cocok dengan URL |
| `npm run e2e` | 30/30 pemeriksaan lolos |
| `node scripts/check-transcode.js` | PASS — .mkv jadi .mp4, ffprobe jalan |

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
