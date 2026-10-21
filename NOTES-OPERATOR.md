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

LAN DROP **Fase 4 selesai** + **alamat Tailscale di panel Sambung**.
Ter-commit (`8f99540` · `bd212a8` · `28e613b` · `348c273` · `c5f1188`),
laporan terkonfirmasi `read`.

Fase 0-3 (UI/UX overhaul) juga sudah selesai sebelumnya (`428249f`).

**Tailscale:** transfer sudah didukung sejak awal (announce unicast ke peer
tailnet). Yang ditambahkan: alamat Tailscale muncul di panel Sambung dan bisa
dipilih untuk QR, jadi file bisa dikirim ke perangkat yang tidak di WiFi yang
sama. Lihat `docs/adr/0006-tailscale-di-panel-sambung.md`.

**Yang sengaja ditunda ke Fase 5:** SSE untuk progres transfer. Alasannya
(biaya vs manfaat, dan risiko event hilang pada list endpoint) sudah
dipertimbangkan; keputusannya diambil, tinggal dikerjakan.

Referensi tes LAN DROP:
- `npm run check` — sintaks semua file JS
- `npm run audit` — karakter asing
- `npm run check:unused` — import mati
- `npm run smoke` — 3 viewport, cek error console, selector QR
- `npm run verify:qr` — QR di-decode OpenCV
- `npm run verify:pwa` — manifest, ikon, service worker
- `npm run e2e` — 2 instance, transfer nyata (port dinamis)
- `npm run icons` — regenerate ikon PWA

Panduan pasang ke layar utama: `docs/guides/install-pwa.md`
