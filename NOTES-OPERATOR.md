# Catatan Operator — Permintaan Berulang

> File ini adalah pengingat yang dibaca agent pada sesi berikutnya.
> Tanggal: 2025-09-21

## Permintaan WhatsApp (aktif)

**Owner/whatsapp:** `+6282143572157` (nomor owner)

**Bot:** ada di `D:\codingan\KhomklangBOT` — project bot WhatsApp terpisah.
Untuk mengirim laporan ke owner:

1. Bikin/aktifkan file yang diperlukan di `D:\codingan\KhomklangBOT`.
2. Jalankan bot-nya.
3. Kirim laporan ke `+6282143572157`.

**Isi laporan yang diminta:** ringkasan hasil pekerjaan (cukup laporan saja —
tidak perlu minta persetujuan, tidak perlu interaksi tambahan).

**Kapan:** setelah pekerjaan selesai. Owner sedang tidur —agent Expected to
работать autonomously sampai selesai, lalu kirim laporan.

**Cakupan nomor:** hanya nomor owner di atas. Jangan kirim ke nomor lain.

## Status/task yang sedang berjalan

Lihat `docs/CHANGELOG.md` dan `git log` untuk progres terkini.
Referensi tes: `scripts/e2e.js` (2 instance), `scripts/smoke.js` (3 viewport),
`scripts/verify-qr.js` (QR bisa discan).
