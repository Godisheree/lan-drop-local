# ADR-0010 — Warna Aksen Oren dan Mark Logo Baru

- **Status:** Diterima
- **Tanggal:** 2026-11-01
- **Memengaruhi:** `public/css/tokens.css`, `public/css/dashboard.css`,
  `public/js/main.js`, `public/js/features/notify.js`,
  `scripts/generate-icons.js`, `public/icons/*.png`,
  `public/manifest.webmanifest`

## Konteks

Warna aksen lama biru (`--accent: #5B8DEF`, `--accent-strong: #3B6FE0`) dipilih
saat produk masih tanpa identitas visual: biru jadi pilihan aman, bukan pilihan
yang sengaja. Pemilik produk minta identitas yang lebih khas, dengan tiga
gagasan: oren, netral hitam→abu, dan hijau/merah.

Catatan penting sebelum memilih: aplikasi ini **sudah** memakai hijau
(`--success`) dan merah (`--danger`) untuk status transfer, dan oranye
(`--warning`) untuk peringatan. Prinsip UI/UX #2 (`docs/product/ux-principles.md`)
melarang warna dipakai sebagai satu-satunya penanda status.

## Keputusan

**Oren jadi aksen utama, netral hitam→abu tetap, hijau/merah tetap milik status.**

Alasan menolak alternatif:

- **Hijau/merah sebagai aksen** — dua warna itu sudah berarti "berhasil" dan
  "gagal" di kartu transfer. Kalau dipakai juga sebagai tombol aksi, pengguna
  kehilangan satu-satunya isyarat cepat beda "aksi" dan "hasil".
- **Hitam→abu sebagai aksen** — itu peran token latar (`--bg-canvas`,
  `--bg-sunken`, `--bg-surface`) dan sudah jalan. Menjadikannya aksen berarti
  menghapus kontras antara aksi dan latar.
- **Oren sebagai aksen** — aman, hangat, dan ada di luar hijau/merah. Sisa satu
  benturan: `--warning` lama `#FF9500` cuma beda 1,30:1 dari aksen oren, jadi
  "peringatan" ikut terbaca sebagai "aksi".

Nilai akhir (rasio kontras diukur, bukan dikira-kira):

| Token | Terang | Gelap |
|---|---|---|
| `--accent` (dekoratif) | `#FF6B1A` 2,85:1 | `#FF7A1F` 6,55:1 |
| `--accent-strong` | `#C2410C` 5,18:1 | `#FF9A5C` 8,16:1 |
| `--warning` | `#F2B705` | `#FFCC00` |
| `--warning-text` | `#8A6400` 5,38:1 | `#FFC93C` 11,12:1 |

`--warning` digeser ke kuning-amber supaya tidak lagi bertabrakan dengan aksen.
Ini satu-satunya perubahan makna warna yang keluar dari permintaan — dicatat
di sini supaya tidak dikira kecelakaan.

**Mark logo**: squircle gradien `#FF6B1A` → `#C2410C` dengan panah turun bergaris
dasar. Panah + garis dasar = "drop": sesuatu jatuh ke sebuah permukaan. Bentuk
yang sama dipakai di dua tempat yang harus tetap sinkron:

- `scripts/generate-icons.js` — PNG statis (`npm run icons`), 192/512/maskable/apple/favicon-32
- `public/js/features/notify.js` — favicon dinamis di canvas (ikut badge jumlah transfer)

`theme_color` manifest jadi `#C2410C` (bukan lagi `#F7F7F9`): status bar PWA
memakai putih di atas aksen-strong, rasionya 5,18:1.

## Konsekuensi

**Positif**

- Aksen dan status tidak lagi berbagi hue yang sama; makna warna tetap tunggal.
- Logo tidak lagi bergantung pada warna brand lama — ikon bisa dirender ulang
  kapan saja tanpa aset desain eksternal (nol dependency, tetap begitu).
- Kontras naik: `--accent-strong` terang dari 4,63:1 ke 5,18:1.

**Negatif**

- `--warning` bergeser hue, jadi tangkapan layar dokumentasi lama tidak lagi
  cocok. Mitigasi: nilai kontras dicatat di `docs/guides/qa-checklist.md`, cek
  ulang saat token berubah.
- Mark yang digambar secara prosedural tidak bisa "diganti desainer" tanpa
  menyentuh `generate-icons.js`. Mitigasi: bentuk dijaga sesederhana mungkin —
  satu batang, satu chevron, satu garis dasar.
- Ikon PWA yang sudah tersimpan di HP tidak otomatis berubah. Mitigasi:
  `CACHE_VERSION` di `public/sw.js` naik ke `landrop-shell-v14`.

**Aturan yang tetap berlaku**

- Tidak ada hex literal di luar `tokens.css` (ADR-0003). Dua pengecualian yang
  memang harus ada — favicon canvas dan fallback token di `main.js` — memakai
  `#C2410C` dan diberi komentar penunjuk ke ADR ini.
- Hover tombol primary menggelap (`filter: brightness(0.92)`), **tidak** pindah
  ke `--accent`: teks `--text-on-accent` di atas `--accent` cuma 2,85:1 dan
  gagal WCAG AA.
