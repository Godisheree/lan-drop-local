# Changelog

Semua perubahan penting pada LAN DROP didokumentasikan di file ini.

Format berdasarkan [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/lang/id/).

## [Belum Rilis]

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
  data dir (pola sama dengan `history.json`: cache memori + tulis atomic yang
  di-debounce).

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
- `CACHE_VERSION` naik ke `landrop-shell-v4`; `/js/features/autoapprove.js`
  masuk daftar precache.

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
