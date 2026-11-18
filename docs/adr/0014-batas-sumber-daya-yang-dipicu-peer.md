# ADR-0014 — Batas sumber daya yang bisa dipicu peer, dan izin berkas rahasia

- **Status:** Diterima
- **Tanggal:** 2026-11-18
- **Memengaruhi:** `rust/src/thumbnail.rs`, `rust/src/ffmpeg.rs`,
  `rust/src/discovery.rs`, `rust/src/settings.rs`, `rust/src/pin.rs`,
  `rust/src/httpapi.rs`, `rust/src/security.rs`, `.github/workflows/ci.yml`

## Konteks

Tinjauan kode 18 Nov 2026 (`docs/review-rust-2026-11-18.md`) menemukan satu pola
yang berulang: jalur yang dipicu **peer**, bukan pengguna, tidak punya batas.
Bukan bug logika — tidak ada perhitungan yang salah — tapi sumber daya yang bisa
dihabiskan dari luar tanpa pernah menyentuh kode aplikasi:

- `render_with_ffmpeg` memanggil `Command::status()` tanpa timeout. Satu berkas
  yang membuat ffmpeg menggantung menahan satu thread `spawn_blocking`
  selamanya; beberapa berkas aneh plus `/thumbnail` berulang mematikan seluruh
  jalur thumbnail.
- `run_ffmpeg` membunuh lewat binary `kill` (tidak ada di Windows) dan tidak
  membunuh sama sekali kalau request HTTP dibatalkan klien.
- Daftar peer hasil announce UDP tanpa batas atas: satu host bisa menyuntik
  ribuan `deviceId` acak dan `/devices` ikut membengkak.
- `settings.json` menyimpan `accessKey` + PIN dengan izin umask default (0644).
- `/transfer/upload` tidak memeriksa ruang disk: penulisan berhenti karena
  ENOSPC, dilaporkan sebagai 500 generik, berkas separuh tertinggal.
- `/transfer/request` membatasi IP tujuan tapi tidak port-nya — bisa dipakai
  sebagai pemindai port ke seluruh LAN.
- Sesi PIN hanya dibersihkan kalau tokennya dipakai lagi, jadi map tumbuh satu
  entri per login sampai proses restart.

## Keputusan

1. **Setiap jalur yang dipicu peer punya batas waktu atau batas jumlah**, dan
   batas itu eksplisit di kode, bukan bergantung pada kebiasaan pemanggil.
   Thumbnail 20 detik (sama dengan Node), ffmpeg dibunuh lewat `kill_on_drop`
   sehingga timeout dan pembatalan klien sama-sama berakhir dengan proses mati,
   daftar peer dibatasi 256 entri total dan 32 per alamat sumber.
2. **Port tujuan harus ≥ 1024.** LAN DROP tidak pernah memakai port sistem, dan
   menolak port rendah menghapus nilai `/transfer/request` sebagai pemindai.
   Ini perbedaan perilaku yang disengaja dari `server/index.js`.
3. **Berkas rahasia ditulis 0600, folder data 0700, izin dipasang sebelum
   rename.** Kalau izin dipasang sesudah rename, ada jendela singkat ketika
   berkas sudah ada di namanya yang sebenarnya tapi masih bisa dibaca pengguna
   lain.
4. **Upload menolak lebih awal kalau ruang kurang** (507 + pesan jelas, sisa
   cadangan 32 MB) dan memeriksa ulang tiap 16 MB. Batas per berkas tetap
   seperti multer; yang diperiksa di sini ruang disk, bukan ukuran.
5. **Sesi kedaluwarsa dibuang saat sesi baru dibuat**, bukan hanya saat token
   itu dipakai.
6. **CI menguji Rust**: `cargo fmt --check`, `cargo clippy -- -D warnings`,
   `cargo test --release`. Toolchain dipin supaya `fmt` tidak merah gara-gara
   versi bergeser. Clippy yang tidak tersedia sebagai shim (paket distro hanya
   memasang `clippy-driver`) dijalankan lewat `RUSTC_WORKSPACE_WRAPPER`, jadi
   lokal dan CI memakai lint yang sama.

## Konsekuensi

- Perilaku lebih ketat dari Node pada dua titik: port tujuan < 1024 ditolak, dan
  upload ditolak lebih awal saat disk hampir penuh. Keduanya sudah dicatat di
  PRD sebagai beda yang disengaja; `check-parity.js` tidak membandingkan jalur
  tulis.
- Daftar peer bisa "menolak" announce sah kalau ada lebih dari 32 perangkat di
  satu alamat sumber — tidak terjadi di LAN rumah, dan lebih baik daripada
  daftar tak terbatas.
- Format kode Rust sekarang rustfmt-bersih; diff format besar sekali jalan dan
  tidak mengubah perilaku.
- Setiap butir di atas punya pemeriksa: tiga unit test Rust (izin berkas, sesi
  kedaluwarsa, ffmpeg dibunuh saat future di-drop) dan pemeriksaan di
  `scripts/check-rust-hardening.js` (port tujuan, banjir announce, thumbnail
  menggantung, upload tanpa ruang) plus `scripts/check-rust-ci.js`.
