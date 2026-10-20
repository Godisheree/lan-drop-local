# Architecture Decision Records

Dokumen keputusan arsitektur LAN DROP. Setiap keputusan yang **sulit dibalik** dan
**mempengaruhi lebih dari satu modul** dicatat di sini.

Format: [MADR](https://adr.github.io/madr/) — konteks → keputusan → konsekuensi.

## Indeks

| # | Judul | Status | Tanggal |
|---|---|---|---|
| [0001](0001-frontend-modularization.md) | Frontend dimodularkan jadi ES modules | Diterima | 2025-09-21 |
| [0002](0002-qr-vendor-offline.md) | QR code di-generate offline di browser | Diterima | 2025-09-21 |
| [0003](0003-dark-mode-via-tokens.md) | Dark mode lewat design token | Diterima | 2025-09-21 |

## Template

```markdown
# ADR-NNNN — Judul Keputusan

- **Status:** Usulan | Diterima | Digantikan oleh ADR-XXXX
- **Tanggal:** YYYY-MM-DD
- **Memengaruhi:** path/folder yang berubah

## Konteks
Masalah dan batasan yang memaksa keputusan ini.

## Keputusan
Apa yang kita putuskan.

## Konsekuensi
**Positif** — apa yang didapat.
**Negatif** — apa yang dibayar, dan mitigasinya.
```
