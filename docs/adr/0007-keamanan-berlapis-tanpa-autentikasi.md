# ADR-0007 — Keamanan Berlapis Tanpa Autentikasi (Path Allowlist + Batas Jaringan)

- **Status:** Diterima
- **Tanggal:** 2025-10-21
- **Memengaruhi:** `server/security.js` (baru), `server/index.js`, `server/transfer.js`, `scripts/check-security.js` (baru), `.claude/settings.local.json`

## Konteks

Audit keamanan (scanner agent + review manual) menemukan tiga celah yang
bisa dieksploitasi **tanpa autentikasi**, dari device mana saja yang bisa
njangkau port HTTP:

1. `POST /transfer/send-file` menerima `filePath` apa adanya dari body
   request. anyone yang bisa njangkau port 3000 bisa menyamar sebagai peer
   yang "menerima transfer", lalu meminta server mengirim file privat apa pun
   (SSH key, cookie browser, file wallet) ke host miliknya.
2. Media scan di Termux memakai `exec()` dengan nama file dari peer yang
   dipakai mentah-mentah. Nama file berisi `$(...)` atau backtick dieksekusi
   shell saat file diterima — RCE di perangkat penerima.
3. ffmpeg mem-*probe* isi file, bukan ekstensi. File dari peer berformat
   `.ts` yang isinya playlist M3U8 membuat server mengambil URL pilihan
   penyerang (SSRF, termasuk ke metadata cloud).

Semua itu bisa ditutup dengan satu cara yang paling menyeluruh: **menambahkan
autentikasi** (token, pairing, kredensial). Tapi itu bertabrakan dengan janji
produk: **"no cloud, no setup — kedua device buka URL yang sama"**. Pairing
token berarti langkah tambahan, dan QR harus membawa token, perangkat kedua
harus mengotorisasi dulu, dan mode offline atau HP tanpa kamera jadi lebih
ribet.

Pertanyaan desainerannya: kalau autentikasi mahal untuk produk ini, **layer
apa yang murah tapi menutup jalur abuse yang paling berbahaya**, tanpa
mengubah alur user sama sekali?

## Keputusan

**Pertahankan "tanpa autentikasi" sebagai desain, dan tambah lapisan
pengaman yang invisible buat user.**

1. **Path allowlist upload** (`assertInsideUploads()` di `server/transfer.js`).
   File yang dikirim ke peer **hanya boleh** berasal dari folder upload
   (`$LANDROP_UPLOAD_DIR` atau `./uploads-temp`). Ini menutup celah #1 tanpa
   mengubah API: frontend memang selalu meng-upload dulu ke server sendiri
   lalu memakai path balikannya.

   Dua lapis: cek leksikal (`path.resolve` + `path.relative` — menolak
   traversal dan path absolut luar) plus cek kanonik (`fs.realpathSync` —
   menolak symlink/junction di dalam folder upload yang mengarah ke luar).

   Alternatif yang ditolak: server mengembalikan `uploadId` acak dan frontend
   mengirim `uploadId` alih-alih `filePath`. Lebih ketat, tapi mengubah
   kontrak API + frontend, dan path-nya sendiri sudah ada di tangan client —
   jadi additional randomness hanya menambah key, bukan menutup akar masalah.
   Allowlist path menutup akar masalah (file di luar folder upload tidak
   pernah boleh keluar).

2. **Target IP allowlist** (`isAllowedTargetIp()` di `server/security.js`).
   Server cuma boleh menghubungi peer di alamat LAN/Tailscale (private,
   loopback, CGNAT 100.64.0.0/10). Link-local `169.254.0.0/16` (metadata
   cloud) diblokir seluruhnya.

   **Hanya IP literal** yang diterima. Hostname dari jaringan (mis. yang
   diselundupkan lewat paket announce palsu) ditolak — kalau tidak,
   `metadata.google.internal` jadi jalur SSRF ke cloud metadata. Hostname
   hanya boleh kalau operator daftarkan sendiri lewat `LANDROP_PEERS`.
   IPv4-mapped IPv6 (`::ffff:192.168.x.x`) diperlakukan sebagai IPv4.
   Peer di luar LAN tetap bisa dipakai lewat opt-in
   `LANDROP_ALLOW_PUBLIC_TARGETS=1`.

3. **Batas protokol untuk ffmpeg/ffprobe** — `-protocol_whitelist file` +
   `-nostdin`, sama seperti yang sudah dipakai jalur thumbnail. Menutup #3
   tanpa mengubah perilaku transcode untuk file normal.

4. **Tanpa shell untuk perintah eksternal** — `exec()` → `execFile()`.
   Nama file dari peer tidak pernah masuk shell. Menutup #2.

5. **Kontrol HTTP generik** (`server/security.js`): security headers (CSP,
   `nosniff`, `X-Frame-Options`), origin guard (POST lintas-origin ditolak),
   rate limit per IP, dan batas multer (ukuran/jumlah file/part).

6. **Error tidak pernah membocorkan internal.** Header keamanan dipasang
   sebelum parser body, dan ada global error handler (terakhir di stack
   Express) yang membalas JSON generik — bukan HTML stack trace bawaan
   Express yang berisi path absolut server.

6. **Semua kontrol punya regression check** — `npm run check:security`.
   Kontrol yang tidak diawasi akan hilang diam-diam di refactor berikutnya.
   Checks-nya berbasis **perilaku** (memanggil fungsi aslinya), bukan cuma
   pencocokan teks — supaya cek tetap jujur kalau kodenya ditulis ulang.

## Konsekuensi

**Positif**
- Tiga celah remote yang bisa dieksploitasi tertutup, **tanpa mengubah
  alur user sama sekali** (tidak ada pairing, tidak ada login, tidak ada
  perubahan UI).
- Kontrol keamanan terkumpul di satu file (`server/security.js`) — mudah
  diaudit dan mudah ditambah.
- Nol dependency baru: rate limiter + origin guard ditulis sendiri
  (kecil, tanpa state global).
- Nol agent config yang rapuh: `npm run check:security` gagal kalau ada
  yang balik lagi ke kondisi tidak aman.

**Negatif**
- **Tetap tanpa autentikasi.** Device lain di LAN yang sama tetap bisa
  membaca histori, mengunggah file, dan menjalankan transfer. Kontrol di atas
  menutup abuse yang mahal (bocor file privat, RCE, SSRF), bukan semua
  abuse. Kalau LAN-nya tidak dipercaya, produk ini bukan tool yang tepat —
  ini batas yang perlu disebut terbuka di dokumentasi.
- **Allowlist path bergantung pada satu sumber kebenaran** (folder upload).
  Kalau suatu saat ada alur kirim file yang bukan hasil upload (mis. pilih
  file langsung dari filesystem server), alur itu harus punya izin khusus.
- **Rate limit in-memory** tidak berlaku lintas instance — cukup untuk satu
  device, tidak untuk klaster.
- **Validasi target IP bisa terlalu ketat** untuk setup tidak biasa (port
  forward, VPN custom). Karena itu ada opt-in env var.

## Verifikasi

- `npm run check:security` — 75 pemeriksaan: path allowlist (termasuk
  traversal & path absolut luar), target IP (termasuk bypass hostname),
  perilaku middleware (403 cross-origin, 429 rate limit), larangan shell di
  seluruh `server/`, urutan flag whitelist protokol ffmpeg/ffprobe.
- `npm run e2e` — 30/30 lolos; alur upload → request → send tetap jalan
  setelah allowlist dipasang (path yang dipakai frontend memang selalu
  dari folder upload).
- `npm audit --omit=dev` — 0 vulnerability (multer 2.4.0, proxy-addr 2.0.8,
  qs 6.16.1).
