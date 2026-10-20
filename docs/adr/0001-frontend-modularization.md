# ADR-0001 — Frontend Dimodularkan Jadi ES Modules

- **Status:** Diterima
- **Tanggal:** 2025-09-21
- **Memengaruhi:** `public/index.html`, `public/js/*`, `public/css/*`

## Konteks

`public/client.js` awalnya grew menjadi **1043 baris** dalam satu file, dengan:

- 7 interval polling global
- state mutable yang tersebar (`activeTransfers`, `transferMeta`, `knownRequestIds`, `requestQueue`, `textOverlayQueue`, …)
- rendering HTML lewat string template + `innerHTML`
- handler yang didaftarkan di dua tempat berbeda (`setupTextSend()` dipanggil di baris 374 **dan** di `init()` baris 66, sehingga setiap klik tombol teks memicu handler dua kali)

Untuk Fase 0–3 kita perlu menambah: panel Sambung/QR, tab mobile, dark mode, batch grouping,
speed/ETA, focus trap, live region, badge notifikasi. Semuanya di file yang sama
= file 2500+ baris, mustahil di-review.

## Keputusan

** pecah frontend jadi ES modules native (tanpa build step).**

```
public/
  index.html
  css/
    tokens.css      — design token (warna, spacing, radius, shadow) + dark mode
    base.css        — reset, tipografi, layout dasar
    components.css  — device card, transfer item, modal, toast, tombol
    views.css       — panel activity, riwayat, panel sambung, tab mobile
  js/
    main.js         — bootstrap + orkestrasi polling
    core/
      api.js        — wrapper fetch
      state.js      — state store + subscribe
      format.js     — formatBytes, formatSpeed, formatEta, formatDuration
      dom.js        — helper el()/build DOM aman (pengganti innerHTML)
    features/
      devices.js    — daftar perangkat
      transfers.js  — item transfer, progress, speed/ETA
      text.js       — composer & overlay teks
      history.js    — panel riwayat
      connect.js    — panel Sambung (URL + QR)
      notify.js     — toast, badge judul tab, favicon badge, bunyi
      a11y.js       — focus trap, live region
    vendor/
      qrcode.js     — MIT, vendored (lihat ADR-0002)
```

ES modules dipilih (bukan bundler) karena:

- **Tanpa build step** — `npm start` tetap `node server/index.js`. Tidak ada webpack/vite/esbuild.
- Browser & Electron (Chromium modern) support native ES modules ≥ 2018.
- Dependency Injection antar-modul lewat import eksplisit, bukan global mutable.
- Tiap file jadi 100–300 baris, reviewable.

Server tetap `express.static` — modul dimuat via `<script type="module">`.

## Konsekuensi

**Positif**
- File kecil & fokus; regresi mudah dilacak lewat `git blame` per modul.
- State store tunggal eliminates "di mana variabel ini diubah?".
- Rendering via DOM API menutup celah XSS secara struktural, bukan lewat escaping.

**Negatif**
- Butuh HTTP/2 atau set minimal untuk module graph; `file://` tidak bisa dipakai.
  → Electron & browser sudah lewat HTTP (`http://localhost:3000`), aman.
- Delapan file request tambahan. Ditekan dengan import graph yang rapat
  (`core/*` → `features/*` → `main.js`), ~6 request paralel.
- Migrasi bertahap: file lama dibuang setelah modul baru siap, bukan di-place-refactor.

## Mitigasi

- Modul `core/dom.js` menyediakan `el()` — satu-satunya cara membuat DOM. Code review
  menolak `innerHTML` dengan data dinamis.
- `core/state.js` menjadi satu-satunya holder state; tidak ada `let` global lintas modul.
