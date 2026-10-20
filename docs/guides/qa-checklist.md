# Checklist QA Rilis UI

Checklist ini dipakai sebelum rilis perubahan UI. Repo ini tidak punya test
otomatis penuh, jadi pemeriksaan manual + skrip bantu adalah jaring
keamanannya.

## Skrip bantu (otomatis)

```bash
node scripts/check-js.js        # sintaks semua file JS (ESM-aware)
node scripts/audit-charset.js   # deteksi karakter asing yang tidak sengaja
node scripts/smoke.js --url http://localhost:3000   # 3 viewport, cek error console
node scripts/verify-qr.js --url http://localhost:3000  # QR di-decode OpenCV
node scripts/verify-pwa.js --url http://localhost:3000 # manifest, ikon, service worker
node scripts/e2e.js             # 2 instance, transfer nyata dua arah
```

| Skrip | Menangkap |
|---|---|
| `check-js.js` | Syntax error, import rusak, `continue` di luar loop |
| `audit-charset.js` | Artefak generasi (Cyrillic/CJK) di teks & komentar |
| `smoke.js` | Error console, uncaught exception, request 404/500, elemen hilang |
| `verify-qr.js` | QR tidak valid / tidak cocok dengan URL yang ditampilkan |
| `verify-pwa.js` | Manifest rusak, ikon salah ukuran, SW cache API, URL CDN |
| `e2e.js` | Alur transfer rusak, batch tidak terkelompok, cancel gagal, shortcut mati, thumbnail hilang |

**Prasyarat `verify-qr.js`:** `pip install opencv-python-headless pillow`

## Manual — di layar desktop (1440×900)

- [ ] Header: logo, tombol Sambung, tombol tema, nama perangkat — tidak ada yang terpotong
- [ ] Buka panel **Sambung**: QR terlihat, URL tampil, tombol "Salin" berfungsi
- [ ] Scan QR dengan HP → halaman terbuka di HP
- [ ] Klik tombol tema → seluruh layout berubah, warna teks tetap terbaca
- [ ] Kirim 3 file sekaligus → **satu kartu batch** dengan 3 baris, bukan 3 kartu
- [ ] Selama transfer: kecepatan & sisa waktu tampil, progress bar bergerak
- [ ] Setelah selesai: **folder tujuan tampil** dan bisa disalin
- [ ] File foto/video yang diterima → **thumbnail** tampil di kartu transfer
- [ ] Galeri menampilkan media terbaru; klik thumbnail → path tersalin
- [ ] Transfer selesai → kartu otomatis melipat setelah ~6 detik
- [ ] Tombol "Batal" hilang setelah status terminal
- [ ] Kirim teks → muncul di peer, tombol "Salin" berhasil
- [ ] Panel riwayat bisa dilipat & dibuka lagi
- [ ] Toast tidak saling menimpa; beberapa toast tampil bersamaan

## Manual — di HP (390×844)

- [ ] Header muat dalam satu baris: logo, tombol Sambung, tombol tema, nama perangkat
- [ ] Tab **Perangkat | Aktivitas** ada dan bisa diganti
- [ ] Transfer berjalan → **sticky progress bar** terlihat di bawah
- [ ] Layar **tidak mati** selama transfer (wake lock aktif)
- [ ] Menutup tab saat transfer aktif → muncul peringatan
- [ ] Menerima file besar dengan ruang disk kurang → ditolak dengan pesan jelas
- [ ] Tombol di device card bisa ditekan (target sentuh ≥ 44px)
- [ ] Modal memenuhi layar, tombol di bawah tidak tertutup keyboard
- [ ] Textarea composer bisa diketik, counter karakter jalan
- [ ] Tidak ada scroll horizontal di halaman mana pun

## PWA & shortcut

- [ ] Panel Sambung menampilkan bagian "Aplikasi" + daftar pintasan
- [ ] Di desktop (`localhost`): tombol install Chrome muncul, service worker
      terdaftar (`navigator.serviceWorker.getRegistration()` tidak null)
- [ ] Di HP via `http://192.168.x.x:3000`: muncul **petunjuk manual**
      (Android `⋮` / iOS Bagikan), bukan tombol install yang tidak berfungsi
- [ ] "Tambahkan ke Layar Utama" di iOS Safari → ikon LAN DROP muncul, dibuka
      tanpa address bar
- [ ] Service worker **tidak** menyajikan `/devices`, `/history`, `/transfer/*`
      dari cache (device & transfer harus selalu segar)
- [ ] Setelah file frontend berubah → `CACHE_VERSION` di `public/sw.js`
      dinaikkan, toast "Versi baru tersedia" muncul, tekan `r` untuk reload
- [ ] `Enter` di modal permintaan menerima · `Esc` menolak · `Ctrl+Enter`
      mengirim teks
- [ ] Enter di tombol "Tolak" menolak (perilaku native tombol, tidak ditimpa)

## Aksesibilitas (WCAG 2.2 AA)

- [ ] Tab lewat keyboard: `Tab` melewati semua kontrol, tidak pernah terjebak
- [ ] Fokus selalu terlihat (ring `focus-visible` kontras)
- [ ] Modal: `Tab` memutar di dalam, `Esc` menutup, fokus kembali ke pemicunya
- [ ] Semua tombol ikon-only punya `aria-label`
- [ ] Perubahan status transfer diumumkan screen reader (live region)
- [ ] Progress bar punya `role="progressbar"` + `aria-valuenow`
- [ ] Kontras teks minimal 4,5:1 (teks besar 3:1) — cek di terang **dan** gelap
- [ ] `prefers-reduced-motion: reduce` mematikan semua animasi
- [ ] Tidak ada informasi yang conveyed hanya lewat warna

## Kontras token (verifikasi manual)

Pasangan ini sudah dihitung dan harus tetap berlaku:

| Pasangan | Rasio | Minimum |
|---|---|---|
| `--text-primary` di `--bg-surface` | 16,1:1 | 4,5:1 |
| `--text-secondary` di `--bg-surface` | 5,96:1 | 4,5:1 |
| `--text-muted` di `--bg-surface` | 4,62:1 | 4,5:1 |
| `--accent-strong` di `--bg-surface` | 4,63:1 | 4,5:1 |
| teks putih di `--accent-strong` | 4,63:1 | 4,5:1 |
| `--success-text` di `--bg-surface` | 4,58:1 | 4,5:1 |
| `--danger-text` di `--bg-surface` | 5,62:1 | 4,5:1 |

Kalau token berubah, hitung ulang. Mode gelap punya pasangan token sendiri —
nilai modus terang tidak bisa diasumsikan berlaku di modus gelap.

## Sebelum commit

- [ ] `node scripts/check-js.js` — 0 failure
- [ ] `node scripts/audit-charset.js` — OK
- [ ] `node scripts/smoke.js` — "SEMUA BERSIH"
- [ ] `node scripts/verify-pwa.js` — semua PASS
- [ ] `node scripts/e2e.js` — semua PASS
- [ ] `git diff` dibaca: tidak ada `console.log`, tidak ada hardcoded URL/CDN
- [ ] [CHANGELOG.md](../../CHANGELOG.md) diperbarui
- [ ] Tidak ada secret yang ter-commit

## Kalau ada yang gagal

1. Jangan commit dulu.
2. Regresi dari commit terakhir: `git stash` → test → `git stash pop`.
3. Kalau test yang salah, perbaiki test **dan** jelaskan di PR kenapa test itu
   salah — jangan diam-diam menurunkan standarnya.
4. Kalau produknya yang salah, tulis ulang test-nya dulu (RED), baru perbaiki
   implementasinya (GREEN).
