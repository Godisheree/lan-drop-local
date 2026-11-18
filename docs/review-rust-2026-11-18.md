# Review inti Rust lan-drop-local — 18 Nov 2026

Dibaca dari `feat/port-rust` @ fcbb8d2 (bukan hasil build lokal). Urut dari yang
paling layak dikerjakan dulu. Tiap butir ada bukti barisnya.

## P1 — nyata, murah, dan bisa dipicu peer

1. `rust/src/thumbnail.rs:190` — `Command::status()` tanpa timeout.
   Node (`server/thumbnail.js:156`) memakai `timeout: 20000`. Di Rust tidak ada
   batas sama sekali: file yang bikin ffmpeg menggantung akan menahan satu thread
   pool `spawn_blocking` selamanya. Peer cukup mengirim beberapa file aneh lalu
   menembak `/thumbnail/{id}` berulang, dan setelah ~512 thread habis seluruh
   jalur thumbnail mati.
   Perbaikan: jangan `Command::status` di sini. Pakai `ffmpeg::run_ffmpeg(&args,
   Duration::from_secs(20))` yang sudah ada (dia menangani spawn + timeout), atau
   bungkus dengan `tokio::time::timeout` + `start_kill`.

2. `rust/src/ffmpeg.rs:88-99` — proses ffmpeg bocor kalau future-nya di-drop.
   Timeout sudah membunuh lewat `Command::new("kill")`, tapi (a) `kill` tidak ada
   di Windows (port ini menarget Windows juga, lihat `platform.rs`), dan (b) kalau
   request HTTP dibatalkan klien sebelum timeout, future-nya di-drop dan ffmpeg
   tetap jalan memakan CPU sampai selesai.
   Perbaikan: `let mut child = ...; child.kill_on_drop(true);` (tokio process
   mendukung ini) lalu cabang timeout cukup `child.start_kill()`. Hapus
   ketergantungan pada binary `kill`.

3. `rust/src/discovery.rs` — `peers: HashMap` tanpa batas atas.
   `upsert_peer` (baris ~322) menyisipkan setiap `deviceId` baru tanpa cek jumlah.
   Satu host di LAN bisa mengirim announce UDP dengan `deviceId` acak ribuan per
   detik; entri bertahan `DEVICE_TIMEOUT_MS = 10s`, jadi puncaknya puluhan ribu
   entri, `/devices` ikut membengkakkan respons dashboard. Node punya masalah sama
   (`knownDevices` juga tanpa cap), tapi ini murah ditutup.
   Perbaikan: tolak sisipan kalau `peers.len() >= 256` dan deviceId belum dikenal,
   atau pakai LRU. Tambah juga cap per alamat sumber.

4. `.github/workflows/ci.yml` — tidak ada job Rust sama sekali (`grep -c cargo` = 0).
   Seluruh port `feat/port-rust` (6 commit, ~6.2k baris) tidak pernah diuji di CI;
   yang jalan hanya matriks Node 18/20/22. Ini akar dari "minim bug" yang tidak
   kelihatan: regresi Rust baru ketahuan kalau kamu jalankan `npm run test:core`
   manual.
   Perbaikan: job kedua `rust` — `cargo test --release`, `cargo clippy --all-targets
   -- -D warnings`, `cargo fmt --check`. Clippy belum terpasang di mesin lokal
   (`cargo-clippy is not installed`), jadi tambahkan `rustup component add clippy`
   juga supaya lokal dan CI sama.

## P2 — keamanan dan integritas

5. `rust/src/settings.rs` — `settings.json` menyimpan `accessKey` dan
   `dashboardPin` tapi ditulis dengan umask default (biasanya 0644). Tidak ada
   `set_permissions` di seluruh crate (`grep -rn set_permissions rust/src` kosong).
   `write_now` sudah atomik (tmp + rename), tinggal tambah
   `std::fs::set_permissions(&tmp, Permissions::from_mode(0o600))` sebelum rename,
   dan 0o700 untuk `data_dir()`.

6. `rust/src/httpapi.rs:916` `transfer_upload` — tidak ada cek ruang disk.
   Batas 2048 MB per berkas x 50 berkas per batch = 100 GB per request, dan
   penulisan berhenti bukan karena ditolak tapi karena disk penuh (`ENOSPC`
   dilaporkan sebagai 500 generik, file setengah jadi ditinggal).
   Perbaikan: sebelum menulis, hitung `platform::free_space(&state.upload_dir)`;
   kalau `size + TETAPAN < free` tolak dengan 507 dan pesan jelas. Ini juga
   memperbaiki kasus "transfer gagal di tengah tanpa alasan".

7. `rust/src/pin.rs:57` `create_session` — `sessions` tidak pernah dibersihkan saat
   membuat sesi baru; entri kedaluwarsa hanya dibuang kalau token itu dipakai lagi
   (`valid_token`). Dengan limit 10 login/menit, map tumbuh terus tanpa batas
   sampai restart.
   Perbaikan: di `create_session`, `sessions.retain(|_, exp| *exp > now)` sebelum
   insert. Satu baris.

8. `rust/src/httpapi.rs:568,625` — `is_allowed_target_ip` membatasi IP tujuan tapi
   **tidak membatasi port**. Pemegang access key bisa memakai `/transfer/request`
   sebagai port scanner ke seluruh LAN/Tailscale: bedakan "connection refused" vs
   "timed out" dan petakan port yang terbuka.
   Perbaikan: tolak `target_port < 1024`, atau lebih ketat: hanya izinkan port
   transfer yang benar-benar diiklankan peer di `/devices`.

## P3 — kerapian yang menumpuk jadi bug

9. `rust/src/transfer.rs:308` — `u32::from_be_bytes(buffered[..4].try_into().unwrap())`.
   Sudah dijaga `if buffered.len() >= 4`, jadi aman hari ini, tapi satu refactor
   yang menggeser guard itu jadi panic di jalur jaringan. Pakai
   `let Ok(head) = buffered[..4].try_into() else { ... }`.

10. `rust/src/transfer.rs:1294,1322` — nama keluaran transcode memakai `stem` dari
    nama asli tanpa `sanitize_file_name`, lalu `out_dir.join(...)`. Kalau `stem`
    mengandung `/` (nama asli bisa dari JSON peer: `fileName: "a/b.mp4"`), hasilnya
    menulis ke subdirektori di dalam uploads, atau gagal tanpa pesan.
    Perbaikan: `sanitize_file_name(&stem)` sebelum join, konsisten dengan
    `receive_file`.

11. `rust/src/transfer.rs:257 cleanup_stale` jalan di thread async dengan
    `std::fs` sinkron (bisa ribuan `read_to_string` + `remove_file`). Pada 6 jam
    sekali dampaknya kecil, tapi kalau TTL upload diturunkan ini jadi jeda
    event-loop. Bungkus dengan `tokio::task::spawn_blocking`.

12. `rust/src/history.rs:43` — `write_now` menulis seluruh array setiap kali ada
    entri baru (maks `MAX_ENTRIES`, tapi tetap O(n) tulis per transfer). Kalau
    batch 50 file, itu 50 tulis penuh. Kumpulkan dengan debounce 500ms.

## Yang sudah benar, jangan diutak-atik

- `sanitize_file_name` + `assert_inside_uploads` (canonicalize + starts_with) —
  jalur traversal tertutup dan ada test-nya.
- `host_guard` (anti DNS rebinding) dan `same_origin_guard` — sesuai ADR 0011.
- Batas frame 64 KiB / teks 1 MiB / 64 koneksi TCP, sama dengan Node.
- `constant_time_eq` untuk PIN.
- `-protocol_whitelist file` di thumbnail: file peer tidak bisa menarik URL jaringan.
- Sesi PIN di memori, bukan disk — keputusan yang benar.

## Cara memverifikasi setelah perbaikan

```
cd rust && cargo test --release            # 63 test saat ini
cargo clippy --all-targets -- -D warnings  # setelah component clippy dipasang
cd .. && npm run test:core                 # build + parity + hardening
```

Jangan klaim "hijau" sebelum `npm run test:core` benar-benar lolos di mesin ini;
`cargo test` saja tidak menyentuh paritas dengan Node.

## Status implementasi (P1 1–4, P2 5–8)

Semua delapan butir dikerjakan dengan test lebih dulu (merah), lalu perbaikan.
Keputusan dan alasannya di `docs/adr/0014-batas-sumber-daya-yang-dipicu-peer.md`.

| # | Perbaikan | Pemeriksa |
|---|-----------|-----------|
| 1 | `render_with_ffmpeg` memakai `spawn` + `try_wait` dengan batas 20 detik, `kill` saat lewat | `check-rust-hardening` § thumbnail menggantung (ffmpeg palsu `sleep 300`, harus menjawab < 30 s) |
| 2 | `kill_on_drop(true)` di `run_ffmpeg` dan `probe`; binary `kill` dihapus | unit test `ffmpeg::tests::ffmpeg_dibunuh_saat_future_dibatalkan` (cek `/proc/<pid>` hilang) |
| 3 | `MAX_PEERS = 256`, `MAX_PEERS_PER_SOURCE = 32` | `check-rust-hardening` § discovery (400 announce, harus ≤ 256) |
| 4 | Job `rust` di CI: fmt --check, clippy `-D warnings`, `cargo test`, toolchain dipin | `scripts/check-rust-ci.js` + `npm run core:lint` |
| 5 | `settings.json` 0600, folder data 0700, izin dipasang sebelum rename | unit test `settings::tests::settings_json_tidak_bisa_dibaca_pengguna_lain` |
| 6 | Upload menolak 507 kalau ruang < 32 MB (dan cek ulang tiap 16 MB) | `check-rust-hardening` § upload dan ruang disk (tmpfs 4 MB) |
| 7 | `create_session` menyapu sesi kedaluwarsa | unit test `pin::tests::sesi_kedaluwarsa_dibuang_saat_sesi_baru_dibuat` |
| 8 | Port tujuan < 1024 ditolak | `check-rust-hardening` § port tujuan (22/80/443/1023 → 400) |

P3 (9–12) belum dikerjakan.
