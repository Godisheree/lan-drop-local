# Panduan: Memasang LAN DROP di Layar Utama

LAN DROP bisa ditambahkan ke layar utama HP seperti aplikasi biasa. Yang
penting untuk diketahui: **seberapa banyak yang benar-benar jalanbergantung pada
koneksinya**.

## Ringkasan

| Yang | Di HP via `http://192.168.x.x:3000` | Di `localhost` / HTTPS |
|---|---|---|
| Ikon di layar utama | ✅ | ✅ |
| Dibuka tanpa chrome browser | ✅ | ✅ |
| Install prompt otomatis (Chrome) | ❌ | ✅ |
| Jalan saat server mati (offline shell) | ❌ | ✅ |

**Alasannya:** service worker — teknologi di balik "jalan offline" dan install
prompt penuh Chrome — hanya boleh jalan di **secure context** (HTTPS atau
`localhost`). LAN DROP di HP diakses lewat HTTP, jadi browser mengabaikannya.

Ini bukan bug LAN DROP, tapi batas browser. Lihat
[ADR-0004](../adr/0004-pwa-di-konteks-http-lan.md).

## Android (Chrome)

1. Buka `http://192.168.x.x:3000` di Chrome.
2. Ketuk tombol **⋮** di pojok kanan atas.
3. Pilih **"Tambahkan ke layar utama"** (atau "Install aplikasi").
4. Ketuk **"Tambahkan"**.

Ikon LAN DROP muncul di layar utama. Diketuk, aplikasinya terbuka tanpa
address bar — dan tetap menunjuk ke server yang sedang jalan, jadi selama
server LAN DROP hidup, semua fitur tetap berfungsi.

## iPhone / iPad (Safari)

1. Buka `http://192.168.x.x:3000` di **Safari** (bukan Chrome — iOS hanya
   mendukung ini untuk add-to-home-screen).
2. Ketuk tombol **Bagikan** (kotak dengan panah atas).
3. Gulir dan pilih **"Tambah ke Layar Utama"**.
4. Ketuk **"Tambahkan"**.

## Desktop (Chrome / Edge)

Kalau server dijalankan di `localhost` (mis. `npm start` di komputer sendiri):

- Chrome/Edge menampilkan ikon **install** (⊕) di address bar — klik itu.
- Atau buka menu **⋮ → "Instalasi" / "Install LAN DROP"**.

Di mode ini install prompt-nya muncul otomatis, dan service worker aktif
sehingga shell aplikasi tersimpan di cache.

## Kalau ingin install penuh (offline shell)

Butuh **HTTPS dengan sertifikat tepercaya**. Opsi yang benar:

- **Let's Encrypt + DNS-01** untuk domain lokal (mis. `lan.drop`) yang
  diarahkan ke IP lokal.
- **mkcert** — sertifikat lokal tepercaya untuk browser di mesin yang sama.

Yang **tidak** berhasil: sertifikat self-signed. Origin dengan error
sertifikat tetap bukan secure context, jadi service worker tetap ditolak.

Kalau sudah punya HTTPS, service worker LAN DROP otomatis aktif — tidak ada
setting yang perlu diubah.

## Memeriksa apakah service worker aktif

Buka di browser yang sama:

```js
await navigator.serviceWorker.getRegistration()
// null  -> tidak aktif (kemungkinan besar karena HTTP)
// object-> aktif
```

## Cache & pembaruan

Service worker menyimpan shell aplikasi dengan nomor versi
(`landrop-shell-v1`). Kalau kamu mengubah file frontend, **naikkan
`CACHE_VERSION` di `public/sw.js`** — kalau tidak, pengguna bisa melihat UI
versi lama.

Aplikasi menampilkan toast "Versi baru tersedia" saat versi baru siap.
Tekan `r` untuk memuat ulang.

## Pemecahan masalah

| Gejala | Penyebab | Solusi |
|---|---|---|
| Tidak ada tombol install otomatis | HTTP (bukan secure context) | Pakai petunjuk manual di atas |
| Ikon add-to-home-screen tidak muncul di iOS | Dibuka di Chrome, bukan Safari | Gunakan Safari |
| Aplikasi lama masih tampil | Cache service worker | Tekan `r`, atau bersihkan cache situs |
| Setelah add-to-home-screen, aplikasi tidak terbuka | Server LAN mati | Server harus hidup; LAN DROP butuh server untuk mencari peer |
