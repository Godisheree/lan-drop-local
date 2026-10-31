# Bahasa UI LAN DROP

Aturan teks yang dilihat user. Tujuannya satu: halaman ini harus terbaca seperti
alat, bukan seperti aplikasi chat. Ditulis buat siapa pun yang menambah teks baru,
termasuk diri sendiri enam bulan lagi.

## Aturan

1. **Tanpa emoji di UI.** Ikon digambar CSS (`#btnTheme .theme-icon`), atau dihapus
   kalau cuma hiasan. Emoji baru boleh muncul di output terminal/operator, bukan di
   `public/`.
2. **Sentence case** untuk judul kartu, judul modal, tombol, dan label kolom.
   "Perangkat terhubung", bukan "Perangkat Online".
3. **Satu istilah untuk satu hal, di semua halaman.** Daftar di bawah wajib dipakai
   apa adanya — kalau butuh istilah baru, tambahkan ke daftar dulu, jangan pakai
   sinonim liar.
4. **Tanpa jargon yang bisa diganti kata biasa.** "Penemuan perangkat", bukan
   "Kesehatan discovery". Istilah jaringan yang memang tidak punya padanan
   (Tailscale, port, HTTP) tetap dipakai — itu nama, bukan jargon.
5. **Kata kerja untuk tombol**: Sambungkan, Kirim, Terima, Tolak, Salin, Simpan,
   Pasang aplikasi, Muat ulang, Keluar.
6. **Tulis hasil, bukan proses**: status transfer memakai "Mengunggah 3 file (40%)",
   bukan "Sedang dalam proses upload".
7. **Ejaan**: Wi-Fi (bukan WiFi), mengunggah (bukan mengupload), perangkat
   (bukan device), antarmuka (bukan interface).
8. **Nama dari perangkat lain = klaim, bukan identitas.** Kalau menampilkan nama
   pengirim, sertakan alamat IP-nya di dekat situ.

## Daftar istilah

| Pakai | Jangan |
| --- | --- |
| Transfer berjalan | Aktivitas Transfer, Transfer aktif |
| Perangkat terhubung | Perangkat Online, Perangkat online |
| Perangkat dikenal, perangkat tailnet | peer, Peer dikenal |
| Penemuan perangkat | Kesehatan discovery |
| Penyimpanan | Ruang simpan, Ruang disk |
| Galeri | Galeri terakhir |
| Riwayat transfer | Aktivitas transfer |
| Buka halaman kirim | Buka UI kirim file |
| Hanya error | Error saja |
| Antarmuka | Interface |

## Status transfer

Status ditulis sebagai kata, bukan ikon: **Selesai**, **Gagal**, **Dibatalkan**,
**Belum dikonfirmasi**. Riwayat memakai format `Kirim ke <nama>` atau
`Terima dari <nama>`, lalu ukuran berkas, waktu, dan status kalau bukan "selesai".
Baris yang berhasil tidak perlu label — yang perlu dibaca cuma yang tidak normal.

## Sebelum selesai: periksa sendiri

```bash
# 1. tidak ada emoji di UI web. Sisa ✕ (U+2715, tombol tutup) dan panah itu
#    tanda baca, bukan emoji — jadi sengaja dikecualikan.
grep -rnoP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]" public/ \
  --include=*.html --include=*.js --include=*.css | grep -vP ":✕$"

# 2. tidak ada istilah lama yang tertinggal
grep -rn "WiFi\|Aktivitas Transfer\|Perangkat Online\|Kesehatan discovery\|Ruang simpan\|Galeri terakhir\|Mengupload\|device harus" public/

# 3. suite + e2e (e2e butuh terminal TTY)
npm test && npm run e2e
```

Teks yang berubah berarti shell PWA ikut berubah: naikkan `CACHE_VERSION` di
`public/sw.js`, kalau tidak, pengguna yang sudah pernah membuka halaman akan melihat
campuran teks lama dan baru.
