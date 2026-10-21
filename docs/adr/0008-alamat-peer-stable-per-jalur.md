# ADR-0008 — Alamat Peer Stabil per Jalur (LAN / Tailscale)

- **Status:** Diterima
- **Tanggal:** 2025-10-22
- **Memengaruhi:** `server/discovery.js`, `server/platform.js`, `server/index.js`, `server/security.js`, `public/js/core/api.js`, `public/js/main.js`, `public/js/features/connect.js`, `scripts/check-routing.js`, `scripts/check-routes.js`

## Konteks

Gejala yang dilaporkan user:

> "Saya kirim teks lewat Tailscale, masuknya malah ke link `localhost:3000`."
> "Seharusnya: kalau Tailscale ya Tailscale, tergantung orangnya lagi pakai link yang mana — jangan diubah-ubah."

Tiga defect menyatu jadi gejala itu:

| # | Defect | Akibat |
|---|---|---|
| **D1** | Alamat peer disimpan di satu field `ip`. Peer yang menyiarkan lewat LAN **dan** Tailscale (deviceId sama) menimpa satu sama lain tiap 2–3 detik. | IP peer "berganti-ganti"; kartu device flickering; kiriman bisa lewat jalur yang tidak dipilih. |
| **D2** | `getLANIP()` mengembalikan **string `'localhost'`** kalau tidak ada interface LAN (HP di data seluler + Tailscale). | Peer ter-*advertise* sebagai `localhost:3000` → `net.createConnection({host:'localhost'})`arti "mesin ini" → **kiriman mendarat di server pengirim sendiri**, bukan di peer. |
| **D3** | Mekanisme pemilihan jalur sudah ada di API (`?via=`) tapi tidak pernah dipakai: server mengabaikan parameternya, frontend tidak pernah mengirimnya. | Tidak ada cara memaksa "pakai Tailscale". |

D2 adalah akar gejala "text-nya nyasar ke localhost": peer HP di data seluler tidak punya alamat LAN, tapi tetap menyiarkan `ip: 'localhost'`. Laptop menerimanya sebagai alamat yang bisa dihubungi, lalu mengirim teks ke dirinya sendiri.

## Keputusan

### 1. Alamat peer disimpan TERPISAH per jalur

`knownDevices` menyimpan `addresses: { lan: {...}, tailscale: {...} }`, bukan satu `ip`. Peer yang menjawab di kedua jalur punya dua entri, masing-masing dengan `lastSeen` sendiri.

`GET /devices?via=lan|tailscale|local` memilih jalur yang dipakai. Response tetap bentuk yang sama (`ip`, `port`, `transferPort`, `via`) plus `fallback: true` kalau jalur yang diminta tidak ada.

### 2. Jalur ditentukan dari ALAMAT SUMBER paket

Bukan dari field `via` di payload. Alamat sumber adalah satu-satunya alamat yang dijamin bisa dihubungi balik lewat jalur paket itu. Pengecualian: sumber loopback (dua instance di satu host) memakai hint `via` di payload.

### 3. Alamat palsu tidak pernah tersimpan

Kalau `ip` di payload tidak layak (bukan IP, `localhost`, `169.254.x`, `0.0.0.0`), dipakai **alamat sumber** paket. `getLANIP()` sekarang mengembalikan `null` (bukan `'localhost'`) dan tidak ada broadcast LAN yang disiarkan kalau tidak ada interface LAN.

### 4. Target yang menunjuk ke diri sendiri ditolak

`isSelfTarget()` (di `server/security.js`) menolak `localhost`, `127.x`, `::1`, dan alamat interface milik server sendiri — dengan pesan jelas, bukan diam-diam mengirim ke diri sendiri. Escape hatch: `LANDROP_ALLOW_SELF_TARGET=1` (dipakai `scripts/e2e.js` & `scripts/check-routes.js` yang memang menjalankan dua instance di `127.0.0.1`).

### 5. Rute mengikuti link yang dibuka user

`currentVia()` di frontend membaca `window.location.hostname`:
- `100.64/10` atau `fd7a::` → `tailscale`
- `localhost` / `127.x` → `local` (peer dijangkau lewat Tailscale dulu — loopback cuma berarti "mesin ini")
- selain itu → `lan`

Default alamat QR di panel Sambung juga mengikuti link yang dipakai, selama user belum memilih sendiri.

### 6. Kegagalan discovery harus terlihat

`GET /discovery/status` (read-only) mengembalikan status per-interface (broadcast aktif/gagal + kode error), status listener, jumlah peer, dan status Tailscale. Error broadcast tidak lagi diemkan: dicatat per interface dengan penjelasan (`EHOSTUNREACH` → "VPN/Tailscale ambil alih default route"), di-dedupe per menit supaya log tidak dibanjiri.

Panel Sambung menampilkan blok **"Status jaringan"** + checklist 4 syarat ("kedua device harus menjalankan LAN DROP sendiri", dst.).

## Konsekuensi

**Positif**
- Gejala "kirim ke localhost" hilang: alamat palsu tidak pernah tersimpan, dan target ke diri sendiri ditolak dengan pesan jelas.
- Rute konsisten dan tidak berubah-ubah: kartu device, tombol kirim, dan log server semuanya menunjukkan jalur yang sama.
- "Device tidak pernah muncul" sekarang punya diagnosis: status broadcast, listener, peer, dan Tailscale terlihat di UI.
- Peer dengan dua alamat (LAN + Tailscale) tidak lagi flickering.

**Negatif**
- Alamat peer tidak lagi "cukup satu" — kode yang membaca `knownDevices` harus sadar ada dua bucket.
- `getLANIP()` bisa `null` → pemanggil wajib menangani (kedua pemanggil sudah diperbarui).
- Guard self-target(addalah behavior change) — script yang menjalankan dua instance di `127.0.0.1` perlu `LANDROP_ALLOW_SELF_TARGET=1`.
- `via: 'local'` adalah jalur ketiga yang hanya bermakna di localhost — device yang peer-nya cuma punya alamat LAN akan tetap fallback ke LAN.

## Verifikasi

- `npm run check:routing` — perilaku: peer dua jalur, jalur `local`, alamat `localhost` tidak pernah tersimpan.
- `npm run check:routes` — **2 instance sungguhan di 3 jalur nyata** (loopback, WiFi `192.168.x.x`, Tailscale `100.x.x.x`): file dua arah (isi identik), teks dua arah, dan file **tidak** mendarat di server pengirim.
- `npm run e2e` — 32/32 (transfer browser sungguhan + status endpoint).
- `npm run smoke` — blok "Status jaringan" ter-render di 3 viewport.
