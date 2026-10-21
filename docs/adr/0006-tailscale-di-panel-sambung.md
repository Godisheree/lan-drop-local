# ADR-0006 — Alamat Tailscale Ditampilkan Bersamaan dengan LAN di Panel Sambung

- **Status:** Diterima
- **Tanggal:** 2025-10-21
- **Memengaruhi:** `server/index.js` (`getLanUrls`), `public/js/features/connect.js`, `public/js/core/state.js`, `public/index.html`

## Konteks

Panel **Sambung** (Fase 4) menampilkan QR + daftar URL supaya perangkat kedua
bisa langsung membuka halaman yang sama. Pada versi pertama, panel itu hanya
mengambil alamat dari `listLANIPv4()`.

`listLANIPv4()` (di `server/platform.js`) sengaja **menyaring interface
Tailscale** — interface-nya masuk daftar `VIRTUAL_IFACE_HINTS`. Itu benar untuk
**broadcast**: UDP broadcast tidak menembus WireGuard mesh, jadi mengiklankan
alamat tailnet ke WiFi hanya menghasilkan alamat yang tak bisa dipakai.

Akibatnya: **alamat Tailscale tidak pernah muncul di UI**, padahal
1. Server sudah punya Tailnet-nya sendiri dan mencantumkannya di log startup
   (`🔒 Tailscale → http://100.97.37.73:3000`).
2. Transfer **sudah bisa** jalan lewat tailnet — `discovery.js` mengirim
   announce unicast ke peer tailnet dengan `ip` = alamat Tailscale milik
   server sendiri, dan peer balik-mengecek ke alamat itu.
3. Port 3000 (HTTP) dan 3001 (transfer) memang ter-bind di `0.0.0.0`, jadi
   keduanya terjangkau lewat alamat Tailscale.

Jadi ada ketidaksesuaian: **transfernya mendukung Tailscale, tapi UI-nya
menyembunyikan alamat Tailscale.** Untuk pengguna yang routinely memindahkan file
lewat tailnet (HP di data seluler, laptop di kantor), QR yang menunjuk IP Wi-Fi
justru tidak berguna — HP-nya tidak akan pernah bisa 기획 alamat tersebut.

## Keputusan

**Tampilkan keduanya, dan biarkan user memilih alamat mana yang dipakai untuk
QR.**

1. `getLanUrls()` di `server/index.js` sekarang mengembalikan daftar alamat:
   - alamat LAN (Wi-Fi) — `via: 'lan'`
   - alamat Tailscale (CGNAT 100.64.0.0/10) — `via: 'tailscale'`, diambil dari
     `tailscale.getSelfTailscaleIP()` (tanpa CLI, jadi jalan di Termux juga)
2. **Tidak mungkin dobel**: `listLANIPv4()` sudah memfilter interface
   Tailscale, jadi Tailscale hanya masuk lewat jalur kedua.
3. **Default tetap LAN.** Alasan: janji inti LAN DROP adalah "nol setup" — selama
   kedua perangkat di WiFi yang sama, langsung jalan. Tailscale menuntut Tailscale
   terpasang di perangkat kedua, jadi itu bukan default yang bebas hambatan.
4. **User bisa memilih** alamat aktif di panel Sambung. Baris alamat memakai
   `aria-pressed`, jadi statusnya terbaca screen reader. Memilih baris lain
   me-render ulang QR.
5. **Hint kontekstual.** Kalau alamat Tailscale yang dipilih, panel menjelaskan
   bahwa alamat itu bisa dibuka dari mana saja selama perangkat ada di tailnet
   yang sama — bukan harus WiFi yang sama. Kalau LAN yang dipilih, hint
   menyebut syarat WiFi yang sama.

## Konsekuensi

**Positif**
- Kemampuan Tailscale yang sudah ada di server akhirnya terlihat di UI.
- Alamat tailnet bisa dibagikan ke orang yang **tidak di WiFi yang sama**.
- Tidak ada perubahan pada mekanisme broadcast — filtering interface Tailscale
  tetap utuh, jadi tidak ada regresi di penemuan peer lewat WiFi.

**Negatif**
- Panel Sambung jadi sedikit lebih padat (satu baris ekstra kalau Tailscale
  aktif). Diterima — informasinya relevan.
- QR hanya berisi satu alamat. Kalau penggunanya mau share ke kedua jenis
  jaringan sekaligus, harus scan dua kali (atau pakai tombol "Salin" per baris).
  Alternatif: tampilkan **dua** QR kalau ada >1 alamat. Itu menambah kompleksitas
  visual; untuk sekarang satu QR + selector cukup, dan tiap baris punya tombol
  "Salin" sendiri.
- Kalau Tailscale terpasang tapi **tidak** terhubung (interface belum up),
  `getSelfTailscaleIP()` mengembalikan null → alamatnya tidak muncul. Bagus:
  menampilkan alamat yang tak bisa dipakai lebih buruk daripada tidak
  menampilkannya sama sekali.

## Verifikasi

`scripts/smoke.js` punya pemeriksaan khusus: kalau panel menampilkan lebih dari
satu alamat, test memastikan memilih baris kedua benar-benar memindahkan
`is-active`, memperbarui `aria-pressed`, **mengubah isi QR**, dan menyisakan
satu paragraf hint saja (tanpa duplikat).

`scripts/check-tailscale-ui.js` Sekaligus mendekode QR yang sedang aktif
dengan OpenCV dan mencocokkan isinya dengan URL yang dipilih — jadi bukan
sekadar "QR-nya ada".
