# ADR-0004 — PWA & Service Worker Hanya di Secure Context

- **Status:** Diterima
- **Tanggal:** 2025-10-21
- **Memengaruhi:** `public/manifest.webmanifest`, `public/sw.js`, `public/js/features/pwa.js`, `public/js/features/connect.js`, `public/index.html`, `server/index.js`

## Konteks

Fase 0–3 membuat LAN DROP terasa seperti aplikasi sungguhan. Pemecahan yang
natural berikutnya: jadikan ia ** Progressive Web App** — bisa dipasang ke
layar utama, punya ikon, dibuka tanpa chrome browser.

Tapi ada satu batasan teknis yang menentukan hampir seluruh keputusan ini:

> **Service worker dan `Notification` API hanya jalan di secure context**
> (HTTPS atau `localhost`). LAN DROP di HP diakses lewat
> `http://192.168.x.x:3000` — itu **bukan** secure context.

Sertifikat self-signed juga tidak menolong: origin dengan error sertifikat
*tetap* bukan secure context.

Artinya: bagian dari "impian PWA" yang paling sering dipromosikan sebenarnya
tidak ada di kasus utama LAN DROP. Sebelum menulis kode apa pun, kita harus
memutuskan apa yang bisa dijual dengan jujur.

## Keputusan

**Pisahkan dua hal yang sering disamakan: "bisa dipasang ke layar utama" dan
"jalan sebagai aplikasi offline".**

| Komponen |\Http LAN | localhost / HTTPS |
|---|---|---|
| `manifest.webmanifest` | ✅ jalan | ✅ |
| Ikon + `apple-touch-icon` | ✅ jalan | ✅ |
| "Tambahkan ke Layar Utama" (iOS) | ✅ jalan | ✅ |
| "Tambahkan ke layar utama" (Android) | ✅ jalan | ✅ |
| Service worker (offline shell) | ❌ **tidak** | ✅ |
| Install prompt penuh (Chrome) | ❌ **tidak** | ✅ |

Aturan implementasi:

1. **Service worker hanya diregistrasi bila** `'serviceWorker' in navigator`
   **dan** `window.isSecureContext` **dan** user agent bukan Electron.
   Kalau tidak, kode **tidak pernah memanggil** `register()` — konsol tetap
   bersih, tidak ada promise rejection yang membingungkan pengguna.
2. **Manifest, ikon, dan tombol install tetap selalu dikirim.** Ini yang
   memberi manfaat nyata di HP: ikon LAN DROP di layar utama, dibuka
   standalone, tanpa chrome browser.
3. **Service worker tidak pernah menyentuh response API.** `/devices`,
   `/me`, `/history`, `/transfer/*` selalu network-only. Cache API = perangkat
   hantu & transfer basi. Ini **bukan** opsi — didokumentasikan di
   `docs/guides/qa-checklist.md` dan dijaga oleh `scripts/verify-pwa.js`.
4. **UI jujur, bukan diam-diam gagal.** Kalau `beforeinstallprompt` tidak
   pernah datang (kasus HTTP-LAN), panel Sambung menampilkan petunjuk manual
   per platform (Android `⋮ → Tambahkan ke layar utama`, iOS
   `Bagikan → Tambah ke Layar Utama`) **plus** catatan bahwa install penuh
   butuh HTTPS.
5. **Service worker dimatikan di Electron.** App desktop memuat
   `http://localhost:3000` → `isSecureContext === true` → SW akan terdaftar dan
   bisa menyajikan JS basi setelah aplikasi di-update. Guard berdasarkan user
   agent, tanpa mengubah model security Electron.

## Konsekuensi

**Positif**
- Di HP (kasus utama) pengguna tetap bisa menambahkan LAN DROP ke layar utama
  dan menjalankannya standalone. Ini manfaat mobile nyata yang **tidak** butuh
  HTTPS.
- Tidak ada kode yang berbohong tentang kemampuannya: apa yang tidak
  tersedia di HTTP dijawab dengan petunjuk manual, bukan dengan Diam.
- Tidak ada dependency baru, tidak ada CDN, tidak ada request keluar jaringan.

**Negatif**
- **Tidak ada offline shell di HP.** Tanpa server yang hidup, halaman tidak
  bisa dibuka. Ini memang realistis untuk aplikasi P2P — tanpa server tidak
  ada siapa pun untuk jadi peer.
- **Install prompt Chrome tidak muncul di HTTP-LAN.** Pengguna harus lewat
  menu manual. Copy-nya sudah disiapkan untuk platform masing-masing.
- **Dua jalur perilaku** (secure vs tidak) harus dipelihara dan diuji dua
  kali. Mitigasi: `scripts/verify-pwa.js` menguji jalur secure; `smoke.js` dan
  `e2e.js` menguji jalur non-secure lewat parameter `?nosw=1`.
- **ButuhHTTPS untuk fitur lengkap** adalah beban operasional yang nyata.
  Jika suatu hari dibutuhkan, jalur yang benar adalah **sertifikat
  tepercaya** (Let's Encrypt untuk domain lokal via DNS-01, atau mkcert),
  **bukan** self-signed. Itu keputusan tersendiri, di luar ADR ini.

## Mitigasi risiko cache basi

Service worker adalah sumber bug klasik: user membuka aplikasi, mendapat UI
lama, dan menganggap "bugnya muncul lagi".

- Cache **versioned** (`landrop-shell-v<N>`); setiap perubahan shell wajib
  menaikkan versi. Aturan ini didokumentasikan di `CLAUDE.md`.
- Navigasi memakai **network-first** — jaringan selalu dicoba lebih dulu.
- `activate` menghapus cache versi lama dan melakukan `clients.claim()`.
- `sw.js` diberi `Cache-Control: no-cache` dari server, dan `manifest` juga,
  supaya pembaruan cepat diterima.
- Toast "Versi baru tersedia" muncul saat SW baru menunggu aktif.
- `scripts/verify-pwa.js` **gagal** jika ada path API masuk daftar precache.

## Catatan kenapa tidak langsung saja migrasi ke SSE

SSE secara teknis terarah untuk progres transfer (satu koneksi
menggantikan polling 800 ms per transfer, dan `EventSource` **tidak**
membutuhkan secure context — jadi tetap bernilai di HTTP-LAN). Tapi memindahkan
`devices`/`pending`/`texts`/`history` ke SSE berarti server harus mendorong
perubahan state dari `discovery.js` dan `transfer.js`, dengan risiko event
hilang yang jauh lebih sulit dideteksi daripada polling yang telat 2 detik.

Keputusan: **SSE untuk progres** dikerjakan terpisah dengan fallback polling
otomatis; **satu-satunya list endpoint** yang dipindah adalah progres.
Alasannya ditulis di ADR-0006.
