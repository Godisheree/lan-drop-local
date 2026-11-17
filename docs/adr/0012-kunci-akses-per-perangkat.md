# ADR-0012 — Kunci akses per perangkat (pairing lewat QR yang sama)

- **Status:** Diterima — menggantikan sebagian ADR-0007
- **Tanggal:** 2026-11-17
- **Memengaruhi:** `server/access.js` (baru), `server/index.js`, `server/transfer.js`,
  `server/settings.js`, `server/discovery.js`, `public/js/core/api.js`,
  `public/js/features/pairing.js` (baru), `scripts/check-access.js` (baru),
  `scripts/check-resume.js` (baru), `scripts/check-transfer-integrity.js` (baru)

## Konteks

ADR-0007 memilih **tanpa autentikasi**: keamanan dijamin dengan allowlist path,
batas jaringan, dan host guard, supaya janji produk ("no setup, buka URL yang
sama") tetap utuh.

Audit ulang dengan uji langsung menunjukkan asumsi itu tidak bertahan. Endpoint
HTTP-nya memang tidak bisa dipakai untuk membaca file privat, tapi **siapa pun
di Wi-Fi yang sama** bisa, tanpa PIN dan tanpa klik siapa pun:

| Vektor | Bukti uji |
|---|---|
| Menerima kiriman atas nama pemilik | `GET /transfer/pending` → `POST /transfer/respond {accept:true}` → file mendarat di folder simpan |
| Membaca teks pribadi yang masuk | `GET /transfer/text` |
| Membatalkan transfer yang sedang jalan | `GET /transfer/active` → `POST /transfer/cancel/:id` |
| Menulis teks ke kotak masuk korban lewat TCP | konek langsung ke port transfer, frame `kind:'text'` — diterima otomatis |
| Mengambil alih identitas peer | announce UDP dengan `deviceId` peer lain |

Semua ini bukan "abuse jalur upload"; ini akses penuh ke fungsi produk oleh
perangkat yang tidak pernah dipasangkan. Menutupnya per-endpoint (PIN per
aksi) akan mengembalikan friksi yang ingin dihindari ADR-0007: pengguna harus
mengetik sesuatu setiap kali.

## Keputusan

**Satu kunci akses per perangkat, dibawa oleh QR yang sudah ada.**

1. Kunci 48 hex dibuat sekali, disimpan di `settings.json`
   (`accessKey`). Bukan PIN: 48 hex tidak bisa ditebak, jadi tidak perlu
   pembatas percobaan untuk ini.
2. Distribusi nol langkah:
   - Browser di mesin server sendiri → cookie dipasang otomatis (permintaan
     datang dari loopback).
   - Perangkat lain → memindai QR di panel "Sambung" → URL memuat `?k=<kunci>`
     → server memasang cookie `HttpOnly; SameSite=Lax` (30 hari) lalu
     mengalihkan ke alamat bersih. Kunci tidak tertinggal di address bar.
3. `requireAccess` menjaga **semua** endpoint data dan tulis: `/devices`,
   `/history`, `/status`, `/system/disk`, `/me`, `/transfer/*`,
   `/settings/auto-approve`. Halaman statis tetap terbuka — isinya kerangka
   aplikasi, bukan data.
4. Port transfer TCP tidak memakai kunci perangkat — peer di LAN tidak
   memegang kunci kita, dan memaksanya berarti transfer antar perangkat mati
   (itu terbukti saat dicoba: `check:routes` gagal di jalur Wi-Fi). Yang
   dipakai di sana **kesegaran discovery**: kiriman `kind:'text'` (satu-satunya
   yang dulu diterima tanpa persetujuan) hanya diterima otomatis kalau alamat
   sumbernya sedang terlihat sebagai peer; selain itu masuk antrean persetujuan.
   Auto-approve file juga tidak berlaku untuk sumber yang tidak dikenal.
5. `.part` resume dikunci ke identitas file (`senderId` + `resumeId` + nama +
   ukuran), bukan nama+ukuran saja.

### Yang sengaja TIDAK dilakukan

- **Kunci tidak menggantikan PIN dashboard.** PIN tetap menjaga halaman pantau
  (riwayat, log, thumbnail) — dashboard bisa dibuka dari perangkat lain, dan
  PIN adalah lapisan terpisah untuk itu. `/thumbnail` menerima kunci **atau**
  PIN, tapi tidak menerima loopback (isi gambar tetap dianggap isi dashboard).
- **Loopback dipercaya tanpa kunci.** Proses di mesin yang sama sudah bisa
  membaca `settings.json` (berisi kunci itu sendiri) dan folder simpan;
  menolaknya tidak menambah keamanan, tapi merusak TUI, `curl`, dan skrip
  e2e. Yang diperiksa ketat adalah alamat LAN.
- **Alamat LAN milik mesin ini bukan loopback.** Kalau ikut dianggap lokal,
  tamu Wi-Fi yang menghubungi IP LAN server akan lolos tanpa kunci.

## Konsekuensi

- Sisa risiko yang disadari: host di LAN yang menjalankan LAN DROP lalu
  announce bisa mengirim teks tanpa persetujuan, karena begitulah janji "drop
  box" produk ini. Yang ditutup adalah klien acak (curl, browser tetangga,
  skrip) yang tidak pernah menjadi bagian jaringan LAN DROP — sebelumnya itu
  cukup untuk menaruh teks di kotak masuk korban.
- Perubahan protokolnya kecil (tidak ada field wajib baru), jadi peer versi
  lama tetap bisa bertukar file; yang berubah hanya siapa yang boleh
  diterima tanpa persetujuan.
- Screenshot panel "Sambung" memuat kunci (di teks URL dan di QR). Itu sudah
  terjadi sejak QR membawa alamat yang bisa dipakai; menyembunyikan kunci di
  teks sementara QR di layar yang sama memuatnya hanya keamanan teater.
- `settings.json` menyimpan kunci plaintext. Kalau nanti ada sinkronisasi
  setting antar perangkat, ini harus jadi hash.
- Regresi dijaga oleh `check:access` (model kunci + tiap rute punya gerbang),
  `check-resume` (teks dari sumber asing masuk antrean, FIN tidak menghapus
  partial, resume tidak mencampur file), dan `check-transfer-integrity` (kunci resume, klaim
  nama atomik, batas frame/teks, sweeper).