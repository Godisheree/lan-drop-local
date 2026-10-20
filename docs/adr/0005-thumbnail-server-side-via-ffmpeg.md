# ADR-0005 — Thumbnail Foto/Video Dibuat di Server

- **Status:** Diterima
- **Tanggal:** 2025-10-21
- **Memengaruhi:** `server/thumbnail.js`, `server/ffmpeg.js`, `server/index.js`, `server/transfer.js`, `server/history.js`, `public/js/features/thumbnail.js`, `public/js/features/gallery.js`

## Konteks

Setelah file diterima, pengguna ingin **melihat apa yang mereka terima** tanpa
harus membuka File Explorer. Untuk foto & video, thumbnail adalah cara tercepat.

Pertanyaan utamanya: **di mana thumbnail dibuat — server atau browser?**

Untuk file yang **diterima**, jawabannya jelas: file-nya ada di filesystem
mesin server (`D:\LAN-DROP\Pictures`), sedangkan browser di perangkat lain
tidak punya akses `file://`. Kalau browser laptop mau menampilkan foto yang
disimpan di folder server laptop yang berbeda — mustahil tanpa bantuan server.

Untuk file yang **dikirim**, file-nya ada di `uploads-temp` server sendiri
sebelum dihapus, jadi server-side juga memungkinkan. Tapi kalau file itu
dihapus setelah transfer, thumbnail harus sudah dibuat lebih dulu — race
yang mudah salah.

## Keputusan

**Thumbnail dibuat di server, dari file yang sudah tersimpan, menggunakan
ffmpeg yang SUDAH ADA untuk auto-transcode.** Tanpa dependency baru.

Detail teknis:

1. **ID opaque, path tidak pernah dari URL.** `id = sha1(path).slice(0,16)`.
   Client hanya pernah mengirim id; server memetakan id → path dari daftar
   file yang sudah dia terima (`thumbnail.registerFile()`). ID yang tidak
   dikenal → 404. Ini menutup path traversal secara struktural, bukan dengan
   blacklist.
2. **Whitelist ekstensi.** Hanya `PHOTO_EXTENSIONS` & `VIDEO_EXTENSIONS` yang
   diproses. Format lain (pdf, zip, doc) tidak pernah menyentuh ffmpeg.
3. **ffmpeg dibatasi.** `-nostdin` (tidak interaktif), `-loglevel error`,
   `-protocol_whitelist file` (menolak demuxer jaringan — file dari peer tidak
   boleh menarik resource dari internet), dan timeout 20 detik.
4. **Fallback tanpa ffmpeg.** Kalau ffmpeg tidak ada di mesin user, gambar
   berformat `jpg/png/gif/webp/bmp` dikembalikan **apa adanya** (browser yang
   menskalakan), selama ukurannya ≤ 12 MB. Video tanpa ffmpeg → 404 → UI
   jatuh ke emoji. Degradasi halus, bukan error.
5. **Cache + prune.** Thumbnail disimpan di `<dataDir>/thumbs/<id>.jpg`,
   dibatasi 300 file (paling lama dihapus dulu).
6. **Dedupe in-flight.** 10 request bersamaan untuk file yang sama hanya
   menjalankan ffmpeg sekali.
7. **Ekstraksi ffmpeg ke modul sendiri** (`server/ffmpeg.js`) supaya
   `thumbnail.js` tidak perlu mengimpor `transfer.js` — itu akan membuat
   import siklik.

## Konsekuensi

**Positif**
- Nol dependency baru. `package.json` tetap `express` + `multer`.
- Thumbnail sama persis dengan file aslinya (bukan render ulang browser yang
  bisa berbeda).
- Berlaku juga di HP — thumbnail-nya dikirim lewat HTTP biasa.
- Galeri tidak menambah request: dibangun dari entri riwayat yang sudah
  di-poll.

**Negatif**
- Butuh ffmpeg terpasang untuk thumbnail video. Tanpa itu, video tidak punya
  thumbnail (foto tetap jalan lewat fallback).
- Ekstraksi `server/ffmpeg.js` menyentuh `server/transfer.js` — risiko
  moderat, mitigasinya: Ekstraksi ini "pure move", logika tidak diubah, dan
  e2e tetap menguji seluruh alur transfer.
- Server melakukan kerja CPU (encode thumbnail) saat file diterima. Mitigasi:
  dedupe in-flight + timeout + cache.
- Path absolut file tetap bocor lewat `savedTo` (sudah bocor sebelum
  thumbnail ada) — thumbnail tidak menambah kebocoran baru.

## Yang tidak dilakukan

- **Lightbox / preview ukuran penuh.** Butuh endpoint baru + modal dengan
  aksesibilitas lengkap. Nilai rendah untuk P2P file sharing — yang berguna
  justru lokasi file, dan itu sudah ada (tombol "Salin").
- **Thumbnail sisi pengirim.** Mungkin, tapi file upload dihapus setelah
  transfer, jadi harus dibuat saat upload (fire-and-forget). Menunggu
 melihat apakah galeri sisi pengirim benar-benar dipakai.
- **Embed thumbnail di dalam history.json.** Base64 bikin file riwayat
  membengkak. ID + cache di disk jauh lebih ringan.
