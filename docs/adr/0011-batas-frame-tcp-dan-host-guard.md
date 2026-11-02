# ADR-0011 — Batas Panjang Frame TCP + Host Guard (Anti DNS Rebinding)

- **Status:** Diterima
- **Tanggal:** 2026-11-02
- **Memengaruhi:** `server/transfer.js` (`FrameParser`, `MAX_FRAME_BYTES`), `server/security.js` (`hostGuard`), `server/index.js` (urutan middleware), `scripts/check-security.js`, `README.md`
- **Terkait:** [ADR-0007](0007-keamanan-berlapis-tanpa-autentikasi.md) (melanjutkan lapisan yang sama, tidak digantikan)

## Konteks

ADR-0007 menutup jalur abuse yang mahal (bocor file privat, RCE lewat shell
Termux, SSRF lewat ffmpeg) tanpa menambah autentikasi. Dua celah yang saat itu
belum tersentuh:

1. **Prefix panjang frame tidak dibatasi.** Protokol TCP LAN DROP memakai
   header 4-byte big-endian (uint32) sebelum tiap payload JSON. Parser
   membacanya apa adanya: `this.expectedLen = this.buffer.readUInt32BE(0)`,
   lalu menunggu sampai sebanyak itu terkumpul. Nilai maksimum uint32 ~4 GB —
   jadi empat byte dari siapa pun yang bisa menjangkau port 3001 sudah cukup
   untuk menyuruh parser menahan dan menumbuhkan buffer sampai ukuran yang
   tidak pernah dipakai frame sungguhan. Tidak ada autentikasi di jalur ini
   (desain zero setup), jadi tidak ada yang menyaring sebelum parser.

2. **Header `Host` tidak diperiksa.** `sameOriginGuard` (ADR-0007) menolak POST
   yang `Origin`-nya berbeda dari `Host`. Guard itu memang benar untuk CSRF,
   tapi **DNS rebinding menyerang tepat di perbandingan itu**: halaman jahat di
   `http://evil.example` bikin domainnya resolve ke `127.0.0.1`, browser
   menganggapnya satu origin dengan server lokal, `Origin == Host` terpenuhi,
   dan halaman itu bebas memanggil API LAN DROP. Cookie dashboard tidak ikut
   (cookie terikat nama host — `evil.example` bukan tempat cookie LAN DROP
   tersimpan), tapi endpoint yang memang terbuka tetap bisa dipakai: kirim
   file, daftar upload, info sistem.

## Keputusan

**Tambah dua lapis yang tidak mengubah alur user sama sekali.**

1. **`MAX_FRAME_BYTES = 64 KB`** di `FrameParser` (`server/transfer.js`).
   Frame yang mengklaim lebih besar langsung ditolak: parser memanggil
   `onError`, berhenti permanen (`broken = true`), membuang buffer, dan
   mengabaikan `feed()` berikutnya. Di sisi penerima socket lalu di-`destroy()`;
   di sisi pengirim koneksinya juga diputus karena peer yang mengirim ack
   kepanjangan sudah tidak layak dipercaya.

   Angka 64 KB dipilih karena isi frame selalu JSON kecil: `transfer-request`
   (nama file maksimum 200 karakter, ukuran, nama pengirim, `batchId`),
   `transfer-response`, `transfer-saved`. Tidak ada frame yang membawa data
   file — byte mentah dikirim setelah parser dilepas dari socket.

2. **`hostGuard`** di `server/security.js`, dipasang di `server/index.js`
   sebelum `sameOriginGuard`. Yang diterima: `localhost`, IP literal
   LAN/Tailscale/loopback (aturan `isAllowedIPv4`/`isAllowedIPv6` yang sudah
   ada), dan nama mesin ini sendiri (`os.hostname()` plus bentuk pendek &
   mDNS). Nama domain selalu ditolak — domain penyerang tidak bisa lagi
   menunjuk ke server ini lewat browser.

   Opt-in yang disediakan: `LANDROP_ALLOWED_HOSTS` (daftar nama tambahan,
   mis. MagicDNS Tailscale) dan `LANDROP_ALLOW_ANY_HOST=1` (server di
   belakang reverse proxy).

## Konsekuensi

**Positif**
- Satu paket 4-byte tidak lagi bisa memaksa alokasi buffer besar; jalur
  transfer tetap jalan untuk semua frame normal (diverifikasi tes perilaku).
- Jalur masuk lewat DNS rebinding tertutup, termasuk untuk endpoint tanpa PIN.
- Nol dependency baru, nol perubahan UI, nol langkah tambahan di alur kirim.

**Negatif**
- **`MAX_FRAME_BYTES` adalah plafon yang harus diingat.** Kalau nanti ada frame
  yang memang membawa data (mis. daftar file satu batch dalam satu frame),
  angkanya dinaikkan — bukan cek-nya dihapus.
- **Host guard bisa menolak cara akses yang sah.** Operator yang mengakses
  lewat nama (MagicDNS Tailscale, nama NetBIOS, domain lokal, reverse proxy)
  harus mendaftarkannya di `LANDROP_ALLOWED_HOSTS`. Gejalanya 403 dengan pesan
  yang menyebut env-nya, jadi tidak buta-buta.
- **Bukan autentikasi.** IP LAN yang sama tetap boleh kirim file; yang hilang
  cuma jalur "browser ke domain penyerang yang menunjuk ke sini".
- **Nama mesin sendiri ikut diterima.** Kalau penyerang kebetulan memakai nama
  mesin ini sebagai domain (mis. `LAPTOP-3F2A`), guard-nya lolos — tapi itu
  nama yang tidak bisa dia arahkan sesukanya seperti domain miliknya sendiri,
  dan pemakaian normal nama mesin itu memang perlu dilayani.

## Verifikasi

- `npm run check:security` — tes perilaku baru: frame normal diterima, frame
  di atas batas ditolak tanpa pernah diproses, frame tepat di batas diterima,
  frame terbagi beberapa paket tetap dirakit, parser berhenti setelah menolak;
  host guard menerima IP LAN/loopback/localhost/nama mesin dan menolak domain
  asing, IP publik, dan Host kosong.
- `npm run e2e` — alur upload → request → send tetap lolos (semua koneksi uji
  memakai IP, bukan domain).
