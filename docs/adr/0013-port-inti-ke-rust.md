# ADR-0013 — Inti server diport ke Rust, frontend tetap tanpa build step

- **Status:** Diterima
- **Tanggal:** 2026-11-18
- **Memengaruhi:** `rust/`, `scripts/check-parity.js`, `scripts/check-rust-core.js`,
  `package.json`, `docs/prd-port-rust.md`

## Konteks

`server/` adalah 5.790 baris Node/Express yang menangani tiga hal sekaligus:
HTTP untuk frontend, discovery UDP, dan protokol transfer TCP. Ketiganya sudah
teruji (21 pemeriksa, ~449 cek) dan sudah melewati hardening keamanan.

Masalahnya bukan bug, tapi bentuk distribusi:

- Proses Node yang menganggur memakai ~70 MB RSS. Di paket Electron angka itu
  ikut terbawa ke setiap instalasi.
- Binary Electron ~150 MB sebelum kode aplikasi. Menyalin aplikasi ini ke HP
  atau laptop teman jadi urusan "unduh 150 MB" untuk memindahkan file di Wi-Fi
  yang sama.
- Protokol TCP-nya sederhana (frame 4 byte + JSON, lalu byte mentah). Itu
  bentuk yang justru lebih mudah dan lebih cepat ditulis langsung di atas
  `tokio` daripada di atas event loop satu thread.

## Keputusan

1. **Inti diport ke Rust secara total**, bukan dicangkok sebagian: `axum` untuk
   HTTP, `tokio` untuk TCP/UDP, satu binary tanpa runtime tambahan.
2. **Kontrak kabel tidak berubah satu byte pun.** Frame TCP, paket announce
   UDP, kunci resume SHA-1, cookie `landrop_key`, header `X-Landrop-Key`,
   `?k=` → 302, format JSON semua endpoint, nama field, dan pesan error yang
   dibaca pemeriksa tetap sama. Instance Rust dan Node harus bisa saling
   mengirim file — itu diuji, bukan diasumsikan.
3. **Frontend tidak disentuh.** `public/` disajikan apa adanya oleh binary
   Rust, tetap ES modules tanpa build step. Frontend adalah aset yang sudah
   stabil dan mengubahnya bukan bagian dari keputusan ini.
4. **Node tetap jadi oracle selama migrasi.** `scripts/check-parity.js`
   menyalakan keduanya berdampingan dan membandingkan respons per endpoint.
   Pemeriksa lama tetap dipakai; yang berubah hanya binary yang dijalankan.
5. **Kedua implementasi membaca data dir yang sama** (`settings.json`,
   `.git`): kunci akses tidak dibuat ulang, versi dan commit dibaca dari
   sumber yang sama. Ini yang membuat dua-duanya bisa hidup berdampingan di
   satu folder saat migrasi.
6. **Shell desktop pindah ke Tauri** (fase terpisah, lihat PRD). Keputusan ini
   tidak menahan port inti: server Rust sudah berguna sendiri tanpa shell.

## Konsekuensi

Positif:

- Binary 3,8 MB, RSS ~4–6 MB saat menganggur, tanpa runtime eksternal.
- Satu proses, satu port, tanpa `node_modules` untuk jalur distribusi.
- Batas frame, timeout, dan pembatalan bisa ditulis sebagai alur linear per
  koneksi (satu task per socket), bukan sebagai state machine callback.
- Pemeriksa regresi jadi lebih bermakna: `check-rust-core.js` menguji sistem
  (dua instance saling kirim, resume setelah putus), bukan bentuk kode.

- Dashboard tetap berfungsi tanpa perubahan frontend: `/status` mengisi field
  `node` dengan penanda runtime Rust, `/logs` berisi aktivitas transfer nyata
  (bukan array kosong), dan `/thumbnail` memakai gerbang kunci/PIN yang sama
  ketatnya dengan Node.

Biaya:

- Dua bahasa di satu repo sampai fase 7 selesai. Setiap perubahan protokol
  harus dikerjakan dua kali; `check-parity` + `check-rust-core` yang menjaga
  keduanya tidak lepas.
- ffmpeg tetap jadi ketergantungan eksternal (bukan di-bundle): video dikonversi
  ke mp4/mp3 sebelum dikirim dan thumbnail video diambil dari frame, persis
  seperti Node. Tanpa ffmpeg di mesin itu, keduanya jatuh ke jalur asli —
  berkas dikirim apa adanya, UI memakai ikon. Perilaku ini sengaja dibuat
  sama supaya satu mesin uji tidak "lebih pintar" dari mesin lain.
- Penanganan jalur Windows (`WINDOWS_SAVE_DIR`, kategori folder) ditulis ulang
  dan hanya bisa diverifikasi di mesin Windows.
- Tim yang merawat harus bisa membaca Rust. Kalau tidak, repo ini jadi satu
  bahasa yang tidak ada yang berani sentuh.

## Alternatif yang ditolak

- **Tetap Node, optimasi memori.** RSS bisa turun sedikit, ukuran distribusi
  tidak.
- **Go.** Kemampuan sama, tapi FFI ke frontend/Tauri dan ekosistem async-nya
  tidak lebih cocok, dan penulisnya sedang memilih Rust.
- **Tulis ulang frontend juga.** Risiko besar tanpa manfaat: tidak ada masalah
  performa di frontend, dan tanpa build step adalah keunggulan yang harus
  dipertahankan.
