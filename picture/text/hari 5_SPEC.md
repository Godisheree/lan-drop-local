# Spek Hari 5 — UI Web Dasar (LAN Drop)

## Konteks
Hari 1-4 udah semua backend logic jalan via endpoint (discovery, handshake, streaming) yang dites manual pakai `curl`. Sekarang hari 5: bikin UI web simpel di `public/` supaya semua flow itu bisa dipakai manusia normal — tanpa ngetik curl.

**Prinsip penting:** Hari 5 TIDAK mengubah logic backend dari hari 1-4. UI ini cuma "consumer" dari endpoint yang udah ada (`/devices`, `/transfer/request`, `/transfer/pending`, `/transfer/respond`, `/transfer/progress/:id`, `/transfer/send-file`). Kalau ternyata ada endpoint yang strukturnya kurang pas buat dipakai UI, sesuaikan SEDIKIT (misal nambah field), JANGAN rombak total — supaya gak ngerusak yang udah dites jalan dari hari 1-4.

## Tujuan Akhir Hari 5
Buka `http://<IP-laptop>:3000` (dari laptop atau HP), user bisa:
1. Liat list device lain yang online (auto-update).
2. Drag & drop (atau klik pilih) file, kirim ke salah satu device dari list.
3. Device penerima dapat notifikasi/prompt buat accept/reject.
4. Setelah accept, progress bar jalan otomatis sampai selesai, di KEDUA sisi (pengirim & penerima).
5. Semua ini jalan TANPA buka terminal/curl — pure klik & drag di browser.

## File yang Dibuat/Diedit
- `public/index.html` — struktur halaman
- `public/style.css` — styling (simpel, gak perlu framework CSS, vanilla cukup)
- `public/client.js` — semua logic: fetch ke API, render device list, handle drag&drop, polling progress

## Spesifikasi Teknis

### 1. Layout `index.html`
Struktur minimal:
- Header: nama app "LAN Drop" + nama device sendiri (biar user tau dia "siapa" di jaringan).
- Section "Device Online": list device dari `/devices`, masing-masing device ditampilkan sebagai card/item yang bisa di-drop file ke situ.
- Drop zone: area besar "Drag file di sini" sebagai default target kalau user belum pilih device spesifik, ATAU file di-drop langsung di atas card device tertentu (pilih salah satu pendekatan, yang drop-ke-card-spesifik lebih intuitif kalau device-nya lebih dari satu).
- Modal/area notifikasi: muncul kalau ada incoming transfer request (dari polling `/transfer/pending`), tampil nama pengirim + nama file + ukuran, tombol Accept/Reject.
- Area progress: list transfer yang sedang berjalan (baik sisi kirim maupun terima), masing-masing dengan progress bar dan nama file.

### 2. Device List (`client.js`)
- `setInterval` polling `GET /devices` tiap 2-3 detik, render ulang list.
- Render: nama device + indikator online (misal titik hijau).
- Kalau list kosong (belum ada device lain ketemu), tampilkan pesan jelas: "Belum ada device lain ditemukan di jaringan ini" — supaya user nggak bingung dikira app rusak (terutama kalau lagi kena masalah AP isolation seperti yang udah pernah ketemu di hari 1-2, lihat `TROUBLESHOOTING.md`).

### 3. Drag & Drop → Kirim File
- Pakai event `dragover`, `dragleave`, `drop` di drop zone / card device. `e.preventDefault()` di `dragover` dan `drop` (default browser behavior buka file di tab baru, harus dicegah).
- Dari `event.dataTransfer.files`, ambil file pertama (multi-file bisa jadi next improvement, hari 5 cukup 1 file dulu).
- **Constraint teknis penting:** browser TIDAK bisa kasih `filePath` absolut dari File API (alasan keamanan browser). Tapi endpoint hari 4 (`/transfer/send-file`) butuh `filePath` di disk. Untuk hari 5, gunakan pendekatan ini:
  - Upload file dulu dari browser ke server pengirimnya sendiri lewat endpoint baru `POST /transfer/upload` (pakai `multipart/form-data`, bisa pakai library `multer` di Express) — server simpan sementara file itu di folder lokal (misal `./uploads-temp/`), dapatkan `filePath` lokal di server.
  - Baru setelah itu otomatis lanjut alur: `POST /transfer/request` (kirim metadata fileName+fileSize asli dari file yang diupload) → tunggu accept → `POST /transfer/send-file` dengan `filePath` hasil upload tadi.
  - Ini berarti hari 5 nambah 1 endpoint kecil di backend (`/transfer/upload`, pakai `multer`), bukan murni cuma file frontend. Sebutkan ini ke AI agent supaya gak kaget pas implementasi.
- Tampilkan nama file & ukuran di UI sesaat setelah di-drop, sebelum proses kirim selesai (feedback instan ke user, jangan biarkan UI diam tanpa respon).

### 4. Notifikasi Incoming Request
- Polling `GET /transfer/pending` tiap 2 detik.
- Kalau ada entry baru yang belum pernah ditampilkan (track id yang udah pernah muncul di state JS, biar gak duplikat notif), tampilkan modal/banner: nama pengirim, nama file, ukuran (format jadi KB/MB yang gampang dibaca, bukan raw bytes), tombol **Accept** dan **Reject**.
- Klik Accept → `POST /transfer/respond` dengan `accept: true`. Klik Reject → `accept: false`. Modal hilang setelah aksi.

### 5. Progress Bar
- Setelah request di-accept (baik dari sisi pengirim yang tau lewat status `accepted`, atau sisi penerima yang baru klik accept), mulai polling `GET /transfer/progress/:requestId` tiap 500ms-1s.
- Render progress bar (elemen `<progress>` HTML native cukup, atau div dengan width % via CSS) yang keupdate sesuai `percent` dari response.
- Begitu status `completed`, ganti tampilan jadi checkmark/teks "Selesai", stop polling buat request itu (jangan polling selamanya).
- Kalau status `failed`, tampilkan error dengan jelas (bukan diam-diam hilang).

### 6. Format Ukuran File (helper kecil)
Buat fungsi `formatBytes(bytes)` yang convert raw bytes ke KB/MB/GB yang dibaca manusia, dipakai di beberapa tempat (info file di drop, info di modal notifikasi, dll) — jangan tampilkan raw byte number ke user.

## Test "Selesai" (WAJIB dijalankan manual)
Gunakan 2 device fisik kalau memungkinkan (laptop + HP) — hari 5 ini momen yang paling representatif buat tes real karena ngelibatin UI manusia, beda dari hari 1-4 yang masih bisa disimulasi via curl di 1 laptop.

1. Buka `http://<IP-laptop>:3000` di laptop, dan `http://<IP-laptop>:3000` dari HP (device kedua) — pastikan kedua sisi muncul device sendiri & device lain di list "Device Online" masing-masing.
2. Dari laptop, drag file kecil (misal foto) ke card device HP di list.
3. Di HP, harus muncul notifikasi accept/reject dengan info file yang benar (nama, ukuran terbaca jelas).
4. Klik Accept di HP → progress bar muncul di KEDUA sisi (laptop sebagai pengirim, HP sebagai penerima), naik bertahap.
5. Setelah selesai, cek file di HP (folder `downloads/` sisi server HP) — buka filenya, pastikan utuh/tidak korup.
6. Ulangi tapi kali ini klik Reject — pastikan tidak ada file tersimpan, dan UI di sisi laptop dapat feedback jelas bahwa ditolak (bukan diam tanpa respon).
7. Test dengan tidak ada device lain nyala (matikan instance kedua) — pastikan UI nampilkan pesan "belum ada device" yang jelas, bukan layar kosong membingungkan.

## Potensi Masalah
- **HTTPS auto-redirect di Chrome HP** — sudah pernah ketemu di hari 1 (lihat `TROUBLESHOOTING.md`). Pastikan semua URL yang di-fetch dari `client.js` pakai relative path (`/devices`, bukan `http://...`) supaya otomatis ikut protokol halaman yang sedang dibuka, mengurangi risiko masalah ini muncul lagi di konteks AJAX call.
- **Polling terlalu sering bikin lag** — kalau ada banyak `setInterval` menumpuk (device list + pending + progress tiap transfer aktif) dan gak pernah di-`clearInterval`, terutama buat polling progress yang harus berhenti begitu `completed`/`failed`. Pastikan ini dibersihkan, jangan numpuk interval mati yang tetap jalan di background.
- **State id yang sudah ditampilkan ketika reload halaman** — kalau user refresh browser, state JS (termasuk "request mana yang sudah pernah muncul modalnya") hilang. Untuk MVP hari 5 ini gak masalah (acceptable), tapi sebutkan sebagai known limitation, jangan dianggap bug yang harus difix sekarang.
- **multer setup** — kalau AI agent belum pernah pasang `multer`, perlu `npm install multer`, dan pastikan folder tujuan upload sudah dibuat (`fs.mkdirSync` dengan `recursive: true`) sebelum dipakai.

## Yang BUKAN Scope Hari 5
- Resume transfer, multi-file sekaligus, enkripsi → opsional di luar MVP 7 hari.
- Electron packaging → hari 7.
- Testing menyeluruh berbagai skenario jaringan → hari 6.
