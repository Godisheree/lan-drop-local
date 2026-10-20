# Arsitektur Frontend

LAN DROP memakai **vanilla JS tanpa build step**. Tidak ada webpack, tidak ada
vite, tidak ada TypeScript. Server Express menyajikan `public/` apa adanya;
browser memuat ES modules secara native.

Lihat [ADR-0001](../adr/0001-frontend-modularization.md) untuk alasan
mengapa `client.js` monolit dipecah.

## Peta berkas

```
public/
├── index.html              — satu halaman, semua anchor
├── css/
│   ├── tokens.css          — design token + dark mode
│   ├── base.css            — reset, tipografi, layout dasar, tombol dasar
│   ├── components.css      — device card, transfer item, modal, toast
│   └── views.css           — layout responsif, tab mobile, sticky progress
└── js/
    ├── main.js             — entry point: polling, routing event, lifecycle
    ├── core/
    │   ├── api.js          — wrapper fetch + endpoint server
    │   ├── state.js        — store state tunggal + subscriber
    │   ├── format.js       — formatBytes, formatSpeed, formatDuration, dll
    │   └── dom.js          — el(), frag(), clear() — satu-satunya cara bikin DOM
    ├── features/
    │   ├── devices.js      — daftar perangkat, drag & drop, file picker
    │   ├── transfers.js    — item transfer, progress, speed/ETA, batch, cancel
    │   ├── send.js         — upload (XHR + progres), request, kirim teks
    │   ├── receive.js      — permintaan masuk, modal, terima/tolak
    │   ├── text.js         — composer & overlay teks
    │   ├── history.js      — panel riwayat
    │   ├── connect.js      — panel Sambung (URL + QR)
    │   ├── notify.js       — toast, badge judul tab, favicon badge, bunyi
    │   ├── theme.js        — light/dark, localStorage, ikuti OS
    │   └── a11y.js         — focus trap, live region, shortcut keyboard
    └── vendor/
        └── qrcode.js       — MIT, vendored (ADR-0002)
```

## Aturan import

```
main.js  →  features/*  →  core/*
```

- `core/` tidak boleh meng-import `features/` ( lapisan bawah tidak tahu lapisan atas).
- `features/` boleh saling meng-import kalau memang ada coupling nyata
  (mis. `receive.js` → `transfers.js` untuk membuat item transfer).
- Tidak ada `import` siklik. Kalau terasa perlu, itu tanda salah batas modul.

## Alur data

```
server (HTTP polling)
   │
   ▼
core/api.js  ──►  features/*  ──►  core/dom.js (render)
                      │
                      ▼
                 core/state.js  (state + subscriber)
```

Aturan:
- **State hanya boleh diubah lewat `setState()`** di `core/state.js`.
  Modul fitur memanggil `getState()` untuk membaca.
- **Rendering hanya lewat `el()`** di `core/dom.js`. Dilarang `innerHTML`
  dengan data dinamis — ini aturan keamanan, bukan preferensi gaya
  (lihat Prinsip 5 di [ux-principles](../product/ux-principles.md)).

## Polling

| Data | Interval | Modul |
|---|---|---|
| Daftar perangkat | 2500 ms | `main.js` → `devices.js` |
| Permintaan masuk | 2000 ms | `main.js` → `receive.js` |
| Teks masuk | 2000 ms | `main.js` → `text.js` |
| Riwayat | 5000 ms | `main.js` → `history.js` |
| Progres transfer | 800 ms | `transfers.js` |

Polling **berhenti saat tab disembunyikan** (`visibilitychange`) — hemat
baterai di HP. Berjalan lagi saat tab kembali terlihat.

## Konvensi

- Bahasa Indonesia untuk teks user-facing, komentar, dan nama variabel.
- Fungsi kecil, satu tujuan. Target 200–400 baris per berkas, maksimal 800.
- Error ditangani di dekat sumbernya; pesan error ditulis untuk dibaca user.
- Tidak ada `console.log` di jalur produksi — `console.error` boleh untuk
  kegagalan yang tidak bisahandled.

## Menambah fitur baru

1. Tentukan dulu: fitur ini mengubah state? render DOM? keduanya?
2. Kalau butuh state baru → tambah di `core/state.js`.
3. Kalau butuh endpoint baru → tambah di `core/api.js`.
4. Buat `features/<nama>.js` yang meng-import `core/dom.js` dan `core/state.js`.
5. Daftarkan di `main.js` (init + polling kalau perlu).
6. Tambah styling di `css/components.css` (komponen) atau `css/views.css` (layout).
7. **Jangan** tambah warna literal di luar `css/tokens.css` — dark mode
   bergantung pada itu.
8. Tambah test di `scripts/e2e.js` atau `scripts/smoke.js`.
9. Update [CHANGELOG.md](../../CHANGELOG.md).
