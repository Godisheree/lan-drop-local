# ADR-0003 — Dark Mode Lewat Token, Bukan Class Toggle

- **Status:** Diterima
- **Tanggal:** 2025-09-21
- **Memengaruhi:** `public/css/tokens.css`, `public/js/main.js`

## Konteks

Ada permintaan dark mode. Dua pendekatan umum:

1. **Class toggle** — `<html class="dark">`, setiap selector ditulis dua kali
   (`.card { … }` + `.dark .card { … }`).
2. **Token** — semua warna hardcode diganti `var(--token)`, lalu blok
   `@media (prefers-color-scheme: dark)` menimpa nilai token.

## Keputusan

**Token**, plus satu class `.theme-dark` / `.theme-light` yang **override**
preferensi sistem. Aturan main:

- `prefers-color-scheme` = default (cuma **1** blok override token).
- Pilihan manual user = class di `<html>`, di-persist ke `localStorage`.
- Preferensi manual menang atas OS; kode mendeteksi perubahan OS saat class belum diset manual.

## Konsekuensi

**Positif**
- Menambah warna baru cukup 1 deklarasi per mode — tidak ada duplikasi selector.
- Kontras tiap pasangan token bisa diverifikasi terpusat.
- Transisi tema mulus (token berubah, layout tidak).

**Negatif**
- Token harus benar-benar lengkap. Kalau ada warna hardcode yang lolos,
  elemen itu tidak ikut tema → **inconsistency visual**.
  Mitigasi: code review wajib menolak hex/rgb literal di luar `tokens.css`.
- Token tidak bisa dinamis per-konteks (mis. warna border hanya di dark).
  Mitigasi: token semantik (`--border-subtle`), bukan token warna mentah
  (`--gray-200`) — pemakai yang salah tidak bisa "menebak" warna.

## Aturan token semantik

| Token | Peran |
|---|---|
| `--bg-canvas` / `--bg-surface` / `--bg-elevated` | lapisan latar |
| `--text-primary` / `--text-secondary` / `--text-muted` | hierarki teks |
| `--accent` / `--accent-strong` / `--accent-soft` | aksi utama & status fokus |
| `--success` / `--danger` / `--warning` | status transfer |
| `--border-subtle` / `--border-strong` | pemisah |
| `--shadow-card` / `--shadow-modal` | kedalaman |

Setiap pasangan teks/latar dicek rasio kontrasnya (lihat `docs/guides/qa-checklist.md`).
