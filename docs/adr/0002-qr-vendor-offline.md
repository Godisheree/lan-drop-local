# ADR-0002 — QR Code Digenerate Offline di Browser (Tanpa CDN)

- **Status:** Diterima
- **Tanggal:** 2025-09-21
- **Memengaruhi:** `public/js/vendor/qrcode.js`, `public/js/features/connect.js`, `package.json`

## Konteks

Panel **Sambung** perlu menampilkan QR berisi URL LAN supaya pengguna HP bisa langsung
scan dan buka — ini primer onboarding LAN DROP ("kedua perangkat buka URL yang sama").

Kandidat:

1. **CDN** (`cdn.jsdelivr.net/npm/qrcode…`) — satu baris, tapi **melanggar prinsip inti produk**:
   LAN DROP 100% offline, tidak ada data keluar dari jaringan.Ditambah lagi, kalau perangkat
   tidak punya internet sama sekali (rumah tanpa uplink, Mode Kapal), QR tidak akan
   ter-render — justru di skenario mana QR paling dibutuhkan.
2. **Server-side generate** (`qrcode` npm package → PNG) — butuh dependency native,
   menambah proses server, dan gambar harus dikirim lewat network.
3. **Vendor file statis** — file JS tunggal, dimuat lokal, digenerate di browser.

## Keputusan

**Vendor `qrcode-generator` v1.4.4 (MIT) ke `public/js/vendor/qrcode.js`.**

- Lisensi MIT, file ~56 KB (unminified) — di-*minify* saat commit.
- Lisensi asli disimpan di `public/js/vendor/qrcode.LICENSE`.
- Dipakai via `qrcode(0, 'M')` → `.createSvgTag()` atau `.createDataURL()` untuk PNG.
- Error correction level **M** — cukup untuk QR yang dicetak di layar dan dipindai
  dari sudut/condition cahaya Extrap.
- Murni client-side: `0` request ke luar jaringan, `0` dependency baru di `package.json`.

## Konsekuensi

**Positif**
- Prinsip "100% offline" terjaga sepenuhnya.
- Tidak ada dependency runtime di `package.json` — `npm install` tetap ringan.
- QR bisa di-cache sebagai aset statis, di-service oleh Express.

**Negatif**
- Ada file vendor di repo → perlu update manual saat ada versi baru.
  Mitigasi: file diberi header komentar penanda asal + versi.
- 56 KB unminified. Mitigasi: minify saat commit (target < 20 KB).
- Library ini sudah "legacy" (tidak ada release sejak 2019). Mitigasi: hanya dipakai
  untuk encode QR statis — API-nya stabil dan tidak ada dependensi runtime.

## Vendor guideline (berlaku untuk library berikutnya)

Library yang di-vendor **wajib**:
1. Lisisi jelas & permisif (MIT / Apache-2.0 / BSD).
2. Tidak butuh network saat runtime.
3. Tidak menarik dependency transitif.
4. File lisensi asli ikut di-commit.

Kalau sebuah library butuh proses build, rantai, atau updateVia npm, **jangan** di-vendor —
pakai dependency npm biasa supaya bisa di-update.
