# LAN DROP — Dokumentasi

Dokumentasi produk & teknis LAN DROP. Struktur mengikuti konvensi tim kecil: setiap
keputusan penting punya **ADR**, tiap alur punya **panduan**, dan perubahan punya
**catatan rilis**.

## Peta dokumen

| Path | Isi | audiences |
|---|---|---|
| [product/overview.md](product/overview.md) | Apa itu LAN DROP, siapa penggunanya, masalah yang diselesaikan | semua orang |
| [product/ux-principles.md](product/ux-principles.md) | Prinsip desain & aksesibilitas yang mengikat semua perubahan UI | design + engineering |
| [adr/](adr/) | Architecture Decision Records — keputusan yang mengikat dan alasannya | engineering |
| [guides/frontend-architecture.md](guides/frontend-architecture.md) | Struktur frontend, modul, alur data | engineering |
| [guides/qa-checklist.md](guides/qa-checklist.md) | Checklist QA manual untuk rilis UI | QA + engineering |
| [guides/install-pwa.md](guides/install-pwa.md) | Cara memasang LAN DROP ke layar utama | semua orang |
| [../CHANGELOG.md](../CHANGELOG.md) | Catatan perubahan yang bisa dilihat user | semua orang |

## Cara kerja dokumentasi

1. **Rencana → eksekusi → catat.** Setiap unit kerja UI selesai, perbarui
   [CHANGELOG.md](../CHANGELOG.md) di bagian "Belum Rilis" beserta dampaknya ke user.
2. **Keputusan baru → ADR.** Kalau sebuah keputusan sulit dibalik (mis. memilih
   library QR vendor vs CDN), tulis ADR-nya di [adr/](adr/) sebelum mengimplementasikan.
3. **Pola berulang → panduan.** Kalau instructions yang sama dipakai di >2 tempat,
   pindahkan ke [guides/](guides/) dan rujuk dari CLAUDE.md.

## Konvensi penulisan

- Bahasa dokumen: **Bahasa Indonesia** (konsisten dengan UI dan komentar kode).
- Format commit: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `refactor:`.
- Judul ADR: `NNNN-judul-keputusan.md`, nomor tidak pernah dipakai ulang.
- Rilis mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) + SemVer.

## Ringkasan status

| Area | Status |
|---|---|
| Fungsionalitas inti (transfer, resume, riwayat, teks) | stabil |
| UI/UX overhaul (Fase 0–3) | selesai |
| Fase 4: shortcut keyboard, thumbnail, PWA, hardening mobile | selesai |
| Transfer & QR lewat Tailscale | selesai — lihat [ADR-0006](adr/0006-tailscale-di-panel-sambung.md) |
| Hardening keamanan (path allowlist, batas jaringan, anti shell/SSRF) | selesai — lihat [ADR-0007](adr/0007-keamanan-berlapis-tanpa-autentikasi.md) |
| Autentikasi / pairing token | belum ada — disengaja, lihat ADR-0007 |
| SSE untuk progres transfer (pengganti polling) | rencana — tinggal dikerjakan |
