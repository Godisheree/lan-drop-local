# PRD — Port LAN DROP ke Rust

Status: draf untuk disepakati
Tanggal: 2026-11-17
Pemilik: Godisheree (maintainer), hanxthvy
ADR terkait: ADR-0013 (port bertahap), ADR-0012 (kunci akses per perangkat)

---

## 1. Ringkasan

LAN DROP sekarang satu paket Node: server Express 5, frontend vanilla tanpa
build step, dan shell Electron yang membungkusnya jadi aplikasi desktop.
Rencananya memindahkan **inti** (HTTP, transfer TCP, discovery UDP) ke Rust,
menyajikan frontend yang sama tanpa perubahan, lalu mengganti shell Electron
dengan Tauri.

Yang membuat ini masuk akal bukan "Rust lebih bagus", tapi tiga hal terukur:

| | Node (sekarang) | Rust (spike, sudah jalan) |
|---|---|---|
| RAM saat melayani dashboard | ~70 MB | 3,6 MB |
| Yang harus dipasang user | Node + node_modules, atau Electron ~150 MB | satu binary |
| Ukuran artefak inti | `node_modules` + seluruh runtime Node | 2,0 MB |

Angka di atas bukan perkiraan: binary `rust/target/release/lan-drop-core`
sudah dibangun di mesin uji dan diukur dengan `/status` + `ps`.

Yang **tidak** ikut berubah: frontend (8.821 baris JS, tanpa build step), format
protokol di jaringan, dan janji produk "nol setup, buka URL, kirim".

---

## 2. Tujuan

1. Inti server berjalan di Rust dengan perilaku setara Node, dibuktikan oleh
   pemeriksa yang sudah ada di repo — bukan oleh klaim.
2. Frontend tidak ditulis ulang. `public/` disajikan apa adanya, tanpa bundler.
3. Satu artefak yang bisa dijalankan tanpa runtime lain di Linux dan Windows.
4. Penggunaan memori turun ke tingkat yang membuat alat ini pantas jalan terus
   di laptop kentang atau mini PC.
5. Shell desktop pindah ke Tauri, dengan fitur setara: tray, autostart,
   single-instance, dialog folder simpan, updater.

## 3. Non-tujuan

1. Bukan kesempatan menambah fitur baru. Selama port, perilaku harus sama.
2. Bukan menulis ulang frontend ke framework. `public/js` tetap vanilla ES
   modules.
3. Bukan memindahkan `tui.js` di fase awal. TUI tetap Node sampai inti stabil,
   lalu diputuskan: port ke `ratatui` atau dibuang.
4. Bukan mengganti format protokol. Peer versi lama harus tetap bisa bertukar
   file.
5. Bukan menghapus jalur Node sebelum seluruh pemeriksa hijau di Rust.

---

## 4. Inventaris sekarang (angka nyata dari repo)

### 4.1 Server (`server/`, 5.790 baris)

| Berkas | Baris | Isi | Kesulitan port |
|---|---|---|---|
| `transfer.js` | 1.956 | TCP frame, resume, partial, auto-approve, teks, sweep | tinggi |
| `index.js` | 796 | 25 rute HTTP, upload multipart, wiring | sedang |
| `discovery.js` | 661 | UDP broadcast + Tailscale, tabel peer, anti-hijack | sedang |
| `security.js` | 361 | header keamanan, host/origin guard, rate limit, validasi IP | rendah |
| `platform.js` | 357 | direktori per OS, deteksi IP LAN, buka browser, folder dialog | sedang |
| `settings.js` | 261 | settings.json, kunci pairing, deviceId, auto-approve | rendah |
| `thumbnail.js` | 261 | thumbnail gambar/video lewat ffmpeg | rendah |
| `access.js` | 260 | middleware pairing | rendah |
| `tray.js` | 259 | tray Electron | dibuang (Tauri) |
| `tailscale.js` | 176 | deteksi alamat CGNAT | rendah |
| `pin.js` | 134 | sesi PIN dashboard, cookie | rendah |
| `ffmpeg.js` | 105 | transcode, whitelist protokol | rendah |
| `logbus.js` | 103 | ring buffer log + `/logs` | rendah |
| `history.js` | 86 | riwayat transfer, tulis debounce | rendah |
| `ports.js` | 14 | pemilihan port | rendah |

### 4.2 Di luar server

- `public/js` 8.821 baris, 21 `scripts/check-*.js`, `e2e.js`, `smoke.js`,
  `verify-pwa.js`, `verify-qr.js`, `tui.js`, `main.js` + `preload.js` (Electron).
- 32 skrip npm. `npm test` merangkai 21 pemeriksa.

**Artinya**: yang diport ± 4.900 baris JS (semua di atas kecuali `tray.js`),
dan 21 pemeriksa harus bisa dijalankan ke dua implementasi. Frontend, tes
browser, dan dokumentasi tidak disentuh.

---

## 5. Arsitektur target

Satu workspace Cargo, dipisah per tanggung jawab supaya tidak jadi satu berkas
raksasa seperti `transfer.js` sekarang:

```
rust/
  Cargo.toml            (workspace)
  crates/
    lan-drop-core/      binary: wiring, argv, shutdown
    ld-config/          env, port, direktori per OS, versi dari package.json
    ld-settings/        settings.json: baca, merge, tulis atomic
    ld-security/        header, host guard, origin guard, rate limit, validasi IP
    ld-access/          pairing: cookie, ?k=, header, loopback, layar 401
    ld-pin/             sesi PIN, cookie, revokeAll
    ld-store/           teks masuk, riwayat, ring buffer log
    ld-discovery/       UDP announce + listen, tabel peer, anti-hijack
    ld-transfer/        TCP frame, resume, partial, auto-approve, sweep
    ld-http/            rute axum, statis, multipart upload, thumbnail
    ld-desktop/         (fase 6) Tauri: tray, autostart, dialog, updater
```

Aturan yang dipegang:

1. **Tidak ada state global yang bisa ditulis dari mana saja.** Semua modul
   memegang `Arc<Inner>` miliknya; `core` yang menyambungkan.
2. **Error tidak boleh mematikan proses.** Node sekarang punya beberapa jalur
   "catch lalu biarkan hidup"; di Rust itu `Result` di batas modul, bukan
   `unwrap()`.
3. **Kunci yang sama dengan Node dibaca dari `settings.json` yang sama**, bukan
   digenerate ulang. Dua implementasi yang membuat kunci sendiri akan saling
   menolak perangkat.
4. **Versi dibaca dari `package.json`**, bukan diketik ulang.
5. Log memakai bentuk yang sama (`[Transfer] …`) karena `/logs` dan beberapa
   pemeriksa membaca polanya.

### 5.1 Dependensi yang direncanakan

| Kebutuhan | Crate | Catatan |
|---|---|---|
| runtime async | `tokio` | sudah dipakai di spike |
| HTTP | `axum` 0.8 | spike sudah jalan |
| JSON | `serde` + `serde_json` | |
| IP LAN per OS | `if-addrs` | pengganti `listLANIPv4()` |
| ruang disk | `libc` (`statvfs`) / `fs2` | `/system/disk` |
| ID acak | `getrandom` | accessKey, deviceId, requestId |
| SHA-1 kunci resume | `sha1` | harus identik dengan Node |
| gambar | `image` + ffmpeg child | thumbnail video tetap lewat ffmpeg |
| tray/desktop | `tauri` 2 | fase 6 |
| TUI (opsional) | `ratatui` | fase 7, kalau TUI dipertahankan |

Total tambahan binary: perkiraan 3-6 MB di atas spike 2 MB. Diukur ulang di
fase 2 dan dicatat di dokumen ini.

### 5.2 Kontrak yang harus identik

| Kontrak | Detail |
|---|---|
| Port | HTTP `PORT` (3000), TCP `TRANSFER_PORT` (3001), UDP discovery |
| Frame TCP | 4-byte big-endian panjang + JSON header, lalu payload mentah |
| `transfer-request` | `fileName`, `fileSize`, `senderName`, `senderId`, `resumeId`, `kind` |
| ACK | `transfer-response`, `text-saved`, `transfer-progress` |
| Kunci resume | SHA-1(`senderId|resumeId|fileName|fileSize`) → 16 hex |
| Announce UDP | `deviceId` dari settings, alamat peer dari alamat sumber |
| Pairing | cookie `landrop_key`, `?k=`, header `X-Landrop-Key`, 401 `{pairing:true}` |
| PIN dashboard | cookie sesi, 10 percobaan/menit |
| Judul & teks error | Inggris di server, terjemahan di frontend (`check-i18n`) |

---

## 6. Strategi migrasi (strangler, 7 fase)

Node **tidak dihapus** sampai fase 6 selesai. Selama itu dua implementasi
hidup berdampingan dan pemeriksa yang sama dijalankan ke keduanya.

### Fase 0 — Kerangka & harness (selesai)

- Spike `rust/`: HTTP, statis dari `public/`, `/status`, gerbang pairing,
  pembedaan loopback vs LAN. Terukur: 2,0 MB, RSS 3,6 MB, `index.html` identik
  11.299 byte, traversal ditolak.
- `scripts/check-parity.js`: menjalankan Node dan Rust berdampingan, lalu
  membandingkan perilaku endpoint satu per satu.
- Gate: `cargo build --release` bersih, `check-parity` melaporkan status per
  endpoint.

### Fase 1 — Config, settings, security, access, pin (selesai)

Port `platform.js`, `settings.js`, `security.js`, `access.js`, `pin.js`.
Gate: `check-access` (16 cek), `check-security`, `check-settings`,
`check-routing` hijau dengan `LANDROP_SERVER_BIN` menunjuk binary Rust.

### Fase 2 — HTTP lengkap (selesai)

25 rute, multipart upload 50 berkas, `/system/disk`, `/logs`, `/dashboard*`,
thumbnail, history, static dengan header khusus (`sw.js`, manifest).
Gate: `check-dashboard`, `check-dashboard-ago`, `check-ack`, `check-i18n`,
`check-identity`, `check-tailscale-ui` hijau; `check-parity` tanpa selisih.

### Fase 3 — Discovery UDP (selesai)

Announce + listen, tabel peer, anti-hijack dengan lease, `knownIpsForName`,
diagnostik `/discovery/status`, jalur Tailscale.
Gate: `check-discovery-rebind`, `check-identity`, `check-routes` (bagian
discovery) hijau.

### Fase 4 — Transfer TCP (selesai)

Frame, pending/respond, resume dengan identitas file, klaim nama `O_EXCL`,
FIN bukan batal, auto-approve nama+alamat, teks + `text-saved`, sweep retensi,
batas koneksi & idle timeout, progress.
Gate: `check-resume` (10 cek, termasuk putus di tengah), `check-transfer-integrity`
(15 cek), `check-autoapprove`, `check-send-flow`, `check-ack`, `check-transcode`
hijau **dan** transfer antar dua instance Rust + satu instance Node (uji
campuran, dua arah).

### Fase 5 — Cutover inti (setengah jalan: inti sudah bisa dipakai, `npm start` masih Node)

- `npm start` memakai binary Rust; Node hanya untuk pemeriksa lama.
  Setengah langkah yang sudah jalan: `npm run core` menjalankan inti Rust
  sendiri, dan `LANDROP_CORE=rust npm run electron-dev` menjalankan shell
  Electron dengan server Rust (tray/menu tetap di Node). Yang belum: menjadikan
  itu default untuk paket distribusi.
- Jalankan `npm test` penuh dengan `LANDROP_SERVER_BIN`; semua hijau.
- Ukur ulang: RSS, CPU saat transfer 1 GB, waktu start, ukuran binary.
- ADR-0013 naik status jadi "Diterima", dokumen ini diperbarui dengan angka.

### Fase 6 — Shell desktop (5-7 hari)

Tauri menggantikan Electron: tray, autostart, single-instance, dialog folder,
buka browser, updater. Dibangun dan diuji di Windows + Linux secara nyata.
Gate: daftar periksa manual per OS (di lampiran B), ditandatangani maintainer.

### Fase 7 — Bersih-bersih (2 hari)

`server/*.js` dihapus kecuali yang masih dipakai pemeriksa; `node_modules`
tinggal `electron` kalau fase 6 belum selesai; README, CLAUDE.md, dan daftar
`check:*` diperbarui.

**Total perkiraan: 28-36 hari kerja satu orang**, atau ~5 minggu kalau dua orang
jalan paralel dengan pembagian di §11.

---

## 7. Strategi verifikasi

Prinsip: **tes yang sudah ada adalah kebenaran**, bukan tes baru yang kutulis
sendiri supaya hijau.

1. Tambahkan satu pintu di 11 titik `spawn(process.execPath, ['server/index.js'])`
   pada `scripts/`: baca `LANDROP_SERVER_BIN`. Tanpa env itu, perilaku lama
   (Node) tidak berubah sama sekali.
2. `LANDROP_SERVER_BIN=rust/target/release/lan-drop-core npm test` harus hijau
   sebelum Node dihapus.
3. `scripts/check-parity.js` membandingkan respons Node vs Rust untuk daftar
   endpoint terpilih: status code, tipe konten, dan bentuk JSON (kunci wajib
   sama; nilai yang memang beda seperti `pid`/`node`/`uptime` dikecualikan).
4. Uji campuran: satu instance Node + satu instance Rust di mesin yang sama,
   kirim file dua arah. Ini menangkap kesalahan protokol lebih cepat daripada
   membaca kode.
5. Uji beban ringan: 1 GB satu berkas, 200 berkas kecil, putus-sambung 5 kali.
   Batas yang diukur: RSS < 60 MB, tidak ada kebocoran file descriptor.
6. Uji keamanan: `attack-lan.js` (14 endpoint tanpa kunci → 401, frame 4 GB
   ditolak, teks asing tidak masuk) dijalankan ke binary Rust dengan hasil sama.
7. `cargo clippy -- -D warnings` dan `cargo fmt --check` masuk `npm test` untuk
   bagian Rust.

Yang **tidak** bisa diverifikasi headless di mesin uji ini: tray, dialog folder,
installer Windows, updater. Itu masuk lampiran B dan harus dijalankan di mesin
nyata oleh maintainer.

---

## 8. Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Port `transfer.js` tidak setia (resume/partial) | file rusak dilaporkan sukses — bug yang baru saja diperbaiki | port per fungsi, `check-resume` + uji campuran Node↔Rust sebagai gate |
| Dua implementasi menulis `settings.json` bersamaan | kunci pairing tertimpa, perangkat ditolak | tulis atomic + hanya kunci yang berubah (pola `changedKeys` dipertahankan) |
| Frontend bergantung pada detail Express (redirect, header) | UI rusak di sudut tertentu | `check-parity` + `e2e.js` dengan Chromium headless |
| Tauri: WebView2 belum ada di Windows 10 lama | aplikasi tidak mau jalan | installer memasang WebView2 bootstrapper, atau fallback Electron satu rilis |
| WebKitGTK di Linux beda perilaku (dialog, clipboard) | fitur kecil mati di Linux | lampiran B per OS, uji di distro target sebelum rilis |
| ffmpeg tidak tersedia | thumbnail/transcode gagal | perilaku sama seperti sekarang: fitur turun, bukan crash |
| Waktu: rewrite 5 minggu | fitur baru tertahan | fase bisa berhenti kapan saja; Node tetap jalan sampai fase 5 |
| Kontributor lain bingung dua implementasi | salah edit sisi yang mati | README menandai `server/` = "referensi, dihapus di fase 7", `rust/` = aktif |

---

## 9. Kriteria cutover

Node boleh dihapus hanya kalau **semua** ini benar:

1. 21 `check:*` + `e2e` hijau dengan `LANDROP_SERVER_BIN` menunjuk Rust, di
   Linux dan Windows.
2. Uji campuran Node↔Rust dua arah lolos untuk file 1 GB, 200 file kecil, dan
   5 kali putus-sambung.
3. `attack-lan.js` memberi hasil sama (semua 401, frame raksasa ditolak).
4. RSS < 60 MB saat transfer 1 GB; tidak ada fd bocor setelah 100 transfer.
5. Shell desktop (fase 6) sudah terbangun dan diuji manual di Windows + Linux.
6. Tidak ada endpoint yang hanya ada di satu implementasi (`check-parity` nol
   selisih).

## 10. Rollback

- Fase 1-4: tidak ada risiko, Node masih yang dipakai user.
- Fase 5: tag rilis terakhir yang berbasis Node tetap ada; rollback = ganti
  artefak rilis, bukan revert kode.
- Fase 6: installer Electron tetap dipertahankan satu rilis sebagai jalan
  mundur kalau Tauri bermasalah di lapangan.

---

## 11. Pembagian kerja (kalau dua orang)

| Bagian | Cocok untuk | Alasan |
|---|---|---|
| `ld-transfer` + `ld-discovery` | yang menulis `transfer.js` sekarang | bagian paling halus, butuh pengetahuan sejarah bug |
| `ld-http` + `ld-access` + `ld-pin` | kontributor kedua | permukaan luas tapi dangkal; mudah diverifikasi |
| `ld-desktop` (Tauri) | siapa pun yang punya mesin Windows | butuh uji manual di dua OS |
| harness & CI | kontributor kedua | tidak memblokir port inti |

Aturan koordinasi: satu PR per crate, `check-parity` wajib hijau di PR yang
menyentuh `rust/`, dan tidak ada PR yang mengubah `server/` **dan** `rust/`
sekaligus kecuali cutover (fase 5).

---

## 12. Definisi selesai (DoD)

- [ ] Semua rute HTTP punya padanan Rust dengan bentuk JSON identik.
- [ ] Protokol TCP identik: frame, resume, ACK, teks.
- [ ] Discovery identik: announce, lease, anti-hijack, diagnostik.
- [ ] `LANDROP_SERVER_BIN=… npm test` hijau di Linux dan Windows.
- [ ] `check-parity` nol selisih.
- [ ] Uji campuran Node↔Rust dua arah lolos.
- [ ] `attack-lan.js` sama hasilnya.
- [ ] Angka performa dicatat di dokumen ini (RSS, ukuran, waktu start, CPU).
- [ ] Shell Tauri setara Electron (lampiran B) di dua OS.
- [ ] ADR-0013 diterima, README/CLAUDE.md diperbarui, `server/` dihapus.

---

## 13. Pertanyaan yang harus dijawab maintainer

1. **Target OS rilis**: tetap Windows + Linux, atau ada rencana macOS?
   (menentukan apakah fase 6 perlu mesin macOS)
2. **TUI dipertahankan?** Kalau ya, port ke `ratatui` (fase 7), kalau tidak,
   `tui.js` dihapus bersamaan.
3. **Updater**: Tauri punya mekanisme sendiri (butuh hosting manifest). Mau
   dipakai, atau tetap unduh manual dari GitHub Releases?
4. **Versi**: rilis Rust mulai di `2.0.0` (breaking buat yang memakai API
   internal) atau lanjut `1.3.0`?
5. **Tailscale** tetap fitur inti atau dipindah ke fase 7 (opsional)?
6. Apakah `LAN DROP` tetap nama produknya (menentukan `appId`, path data,
   nama instalasi)?

---

## 14. Lampiran A — Status hari ini (bukti, bukan rencana)

Inti sudah lengkap dan diukur di mesin uji (Linux, 2 vCPU):

```
$ (cd rust && cargo build --release)
Finished `release` profile [optimized]
$ ls -l rust/target/release/lan-drop-core
3.782.360 byte                   # 3,8 MB, tanpa runtime tambahan
$ ./lan-drop-core &              # PORT=4400 TRANSFER_PORT=4401
$ ps -o rss= -p <pid>
4,7–6,4 MB                       # Node: ~70 MB
$ curl -s -o /dev/null -w '%{http_code}' http://192.168.1.13:4400/status
401                              # tanpa kunci, dari alamat LAN → benar
$ curl -s .../ | wc -c
11299                            # sama dengan public/index.html
```

Hasil pemeriksa:

```
$ node scripts/check-parity.js
SAMA 24 · BEDA 0 · BELUM 0       # 24 endpoint, semua berperilaku sama

$ node scripts/check-rust-core.js
47 lulus, 0 gagal                # dua instance Rust + satu Node: teks, file
                                 # 1 MB, resume setelah putus, batal, riwayat,
                                 # thumbnail, konversi video, interop dua arah,
                                 # log dashboard, penolakan target, rute data
```

Yang **sudah** ada di Rust: 25 rute HTTP + statis, gerbang akses (cookie,
header, `?k=`, sesi PIN, loopback), discovery UDP (broadcast per interface
dari prefix, anti-hijack, lease 10 s, `LANDROP_PEERS`), transfer TCP penuh
(frame, accept/reject, resume ber-identitas, partial saat putus, batal
eksplisit, teks + `text-saved`, batas frame/koneksi/idle, sweep), settings,
PIN dashboard, log ring buffer, riwayat, thumbnail foto+video lewat cache
JPEG, konversi video sebelum kirim (mp4 / mp3 untuk audio saja), `/system/disk`.

Yang **belum**:

- `npm start` masih menjalankan Node; binary Rust dijalankan terpisah. Node
  belum turun pangkat jadi oracle saja (fase 5).
- Shell desktop masih Electron; Tauri belum ditulis (fase 6).
- ffmpeg dipanggil sebagai proses luar, tidak di-bundle. Mesin tanpa ffmpeg
  mengirim video apa adanya dan hanya punya thumbnail gambar — sama dengan
  Node, tapi artinya "sudah jalan" di laptop pengembang tidak otomatis berarti
  "sudah jalan" di mesin pengguna. Perlu diuji di satu mesin tanpa ffmpeg.
- Jalur Windows (folder simpan per kategori, `WINDOWS_SAVE_DIR`) sudah ditulis
  tapi belum pernah dijalankan di Windows.
- Autostart, tray, single-instance: masih milik shell Electron.
- `check-access`, `check-security`, `check-settings`, `check-routing` adalah
  pemeriksa yang membaca **sumber Node** (regex atas `server/*.js`). Itu memang
  tidak bisa dijalankan ke Rust dan tidak dijadwalkan untuk itu; penggantinya
  untuk inti Rust adalah `check-rust-core.js` + `check-parity.js`.

## 15. Lampiran B — Daftar periksa manual shell desktop (fase 6)

Windows dan Linux, masing-masing:

- [ ] Ikon tray muncul, menu Buka Dashboard / Buka Folder Simpan / Keluar
- [ ] Tutup jendela = tetap jalan di tray (bukan keluar)
- [ ] Autostart saat login bisa dinyalakan/dimatikan dari UI
- [ ] Instance kedua tidak membuka server baru, hanya memfokuskan jendela lama
- [ ] Dialog "pilih folder simpan" mengembalikan path yang benar
- [ ] Port 3000 dipakai proses lain → pindah port otomatis dan tetap jalan
- [ ] Firewall prompt Windows muncul sekali, bukan tiap start
- [ ] Uninstall menghapus autostart, menyisakan folder simpan
- [ ] Update dari versi sebelumnya tidak menghapus `settings.json`
