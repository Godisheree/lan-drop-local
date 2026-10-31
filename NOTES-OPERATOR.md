# Catatan Operator — Permintaan Berulang

> File ini adalah pengingat yang dibaca agent pada sesi berikutnya.
> Tanggal: 2025-09-21

## Permintaan WhatsApp (aktif)

**Owner/whatsapp:** `+6282143572157` (nomor owner)

**Bot:** `D:\codingan\KhomklangBOT` — project bot WhatsApp (Baileys).
Sesi WhatsApp sudah terautentikasi (`auth/creds.json` ada).

### Cara mengirim laporan (udah jadi, tinggal pakai)

```bash
cd D:\codingan\KhomklangBOT

# 1. isi laporan (isi owner-report.json)
node scripts/send-owner-report.js --preview   # cek dulu tampilannya

# 2. kirim
node scripts/send-owner-report.js

# 3. verifikasi benar-benar sampai (exit 0 = terkonfirmasi)
node scripts/verify-owner-report.js
```

Yang sudah disiapkan:

| File | Fungsi |
|---|---|
| `scripts/send-owner-report.js` | Kirim laporan ke owner permanen. `--preview` = print saja |
| `scripts/verify-owner-report.js` | Kirim ulang + tunggu status ACK WhatsApp, exit 0 = terkirim |
| `scripts/report-builder.js` | Susun isi laporan dari JSON ke format Khomklang |
| `scripts/owner-report.json` | Isi laporan (ubah di sini, bukan di kode) |
| `scripts/README.md` | Dokumentasi skrip |

Detail teknis penting:

- **Satu session satu proses.** Jangan jalankan `npm start` (bot utama)
  bersamaan dengan skrip di atas — keduanya rebut session, salah satunya
  ter-logout. Tutup bot dulu, atau tunggu bot mati.
- Nomor owner = `PERMANENT_OWNER` di `src/runtime/backup-owner.js` (sudah
  sama dengan yang diminta owner).
- Bukti delivery: untuk chat **privat**, Baileys memancarkan event
  `messages.update` dengan status numerik — `server-ack` (server terima),
  `delivery-ack` (sampai ke HP), `read` (owner buka chat).
  Event `message-receipt.update` **hanya** untuk grup/status — jangan
  dipakai sebagai bukti delivery di chat privat.
- Owner tidur → `delivery-ack` tetap bisa muncul (HP terkoneksi), tapi
  `read` tidak akan muncul sampai owner membuka chat.

**Isi laporan yang diminta:** ringkasan hasil pekerjaan saja. Tidak perlu
minta persetujuan, tidak perlu interaksi tambahan.

**Cakupan nomor:** hanya nomor owner di atas. Jangan kirim ke nomor lain.

## Status/task terakhir

LAN DROP **Fase 4 selesai** + **alamat Tailscale di panel Sambung** +
**hardening keamanan**. Ter-commit (`8f99540` · `bd212a8` · `28e613b` ·
`348c273` · `c5f1188`), laporan terkonfirmasi `read`.

Fase 0-3 (UI/UX overhaul) juga sudah selesai sebelumnya (`428249f`).

**Tailscale:** transfer sudah didukung sejak awal (announce unicast ke peer
tailnet). Yang ditambahkan: alamat Tailscale muncul di panel Sambung dan bisa
dipilih untuk QR, jadi file bisa dikirim ke perangkat yang tidak di WiFi yang
sama. Lihat `docs/adr/0006-tailscale-di-panel-sambung.md`.

**Tailscale di HP/Termux (tanpa CLI):** aplikasi Tailscale dari Play Store
cukup — CLI tidak perlu diinstall. Yang perlu dicek: (1) aplikasi Tailscale di
HP sudah **connected** (bukan cuma terinstall), (2) alamat CGNAT 100.x sudah
muncul di **kartu Status jaringan** (dashboard `/dashboard`) — atau di terminal
kalau dijalankan dengan `--debug`. Karena Tailscale menyala belakangan,
alamatnya muncul otomatis beberapa detik kemudian — server memantau terus,
bukan cuma sekali saat start. CLI cuma dipakai untuk mencari peer tailnet
duluan; tanpa CLI, HP tetap bisa **ditemukan** desktop lewat reply-back.

**Keamanan:** audit menutup 3 celah remote (bocor file privat via
`/transfer/send-file`, command injection lewat nama file di Termux, SSRF lewat
ffmpeg) + menambah security header, rate limit, batas upload, dan pembatasan
target IP ke LAN/Tailscale. Autentikasi di alur kirim file **sengaja tidak**
ditambahkan (kontrak "nol setup") — lihat
`docs/adr/0007-keamanan-berlapis-tanpa-autentikasi.md`. Satu pengecualian:
**halaman pantau `/dashboard` dikunci PIN** (bawaan `123456`, diingat 30 hari
per browser, 10 percobaan/menit) karena isinya riwayat transfer + log server —
lihat `docs/adr/0009-pin-dashboard.md`. UI kirim file di `/` tetap bebas, jadi
alur kirim dari HP tidak berubah. Kalau PIN lupa: hapus nilai `dashboardPin` di
`settings.json` (= kembali ke `123456`).
Regression check: `npm run check:security`.

**Yang sengaja ditunda ke Fase 5:** SSE untuk progres transfer. Alasannya
(biaya vs manfaat, dan risiko event hilang pada list endpoint) sudah
dipertimbangkan; keputusannya diambil, tinggal dikerjakan.

Referensi tes LAN DROP:
- `npm run check` — sintaks semua file JS
- `npm run audit` — karakter asing
- `npm run check:unused` — import mati
- `npm run check:security` — regression check keamanan
- `npm run check:identity` — regression check nama device
- `npm run check:routing` — regression check routing peer (LAN vs Tailscale)
- `npm run check:routes` — 2 instance sungguhan di 3 jalur (loopback, WiFi, Tailscale)
- `npm run smoke` — 3 viewport, cek error console, selector QR
- `npm run verify:qr` — QR di-decode OpenCV
- `npm run verify:pwa` — manifest, ikon, service worker
- `npm run e2e` — 2 instance, transfer nyata (port dinamis)
- `npm run icons` — regenerate ikon PWA

**Log & terminal:** log server hidup di dashboard (`/dashboard`, kartu LOG SERVER)
— ring buffer 300 baris, bisa disalin dari HP, hilang saat restart. Terminal
sengaja **diam**: yang tercetak cuma satu baris tanda siap + alamat dashboard,
mis. `✅ LAN DROP aktif — dashboard: http://localhost:3000/dashboard • dari
perangkat lain: http://192.168.1.8:3000/dashboard`. Kalau memang sedang
menelusuri masalah dan mau banner lengkap (alamat LAN/Tailscale, port, status
discovery) kembali mengalir:

```bash
npm run start:debug        # = node server/index.js --debug
LANDROP_DEBUG=1 node server/index.js
```

Level `error` tetap selalu tercetak, dengan atau tanpa flag — kalau servernya
sendiri gagal jalan (port dipakai), dashboard-nya belum ada untuk dibaca.

## Troubleshooting: device tidak ditemukan / kirim ke localhost

1. **Buka panel Sambung → blok "Status jaringan".** Di situ kelihatan:
   broadcast per interface (gagal? kode errornya apa), listener UDP,
   jumlah peer, dan status Tailscale. Ini jawaban cepat untuk "kenapa gak
   ketemu".
2. **`EHOSTUNREACH` di status broadcast** → Tailscale/VPN mengambil alih
   default route. Quit VPN, atau pakai Tailscale dengan "bypass" untuk LAN.
3. **Peer tidak muncul padahal WiFi sama** → cek firewall/router memblokir
   UDP 41234, dan pastikan **kedua device menjalankan LAN DROP sendiri**
   (HP: `node server/index.js` di Termux). Membuka halaman di browser saja
   tidak cukup — hanya jadi klien.
4. **HP di data seluler (bukan WiFi)** → tidak ada alamat LAN, jadi peer
   hanya bisa dijangkau lewat Tailscale. Pastikan aplikasi Tailscale di HP
   benar-benar *connected* dan kartu "Status jaringan" di dashboard menunjuk
   alamat Tailscale (atau `node server/index.js --debug` kalau mau lihat di
   terminal).
5. **Kirimannya nyasar ke `localhost`** → sudah diperbaiki (alamat peer
   tidak lagi bisa berupa `localhost`, dan target ke diri sendiri ditolak).
   Kalau masih muncul, cek `npm run check:routes` — skrip itu menguji 2
   instance di 3 jalur nyata.
6. **Nama device di HP = "localhost"** → sudah diperbaiki (sekarang model HP,
   mis. "OPPO A38"). Mau namain sendiri: `DEVICE_NAME="HP-Umi" node server/index.js`.

Panduan pasang ke layar utama: `docs/guides/install-pwa.md`
