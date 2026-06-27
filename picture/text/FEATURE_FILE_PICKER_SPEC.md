# Spek Tambahan — File Picker Button (LAN Drop)

## Konteks
Hari 1-5 udah selesai dan TERBUKTI jalan end-to-end (laptop ↔ HP via Termux, drag&drop file, transfer sukses, file valid muncul di Galeri HP). Sekarang nambah fitur pelengkap: **tombol "Tambah File"** di tiap card device, sebagai ALTERNATIF dari drag&drop (bukan menggantikan).

## Kenapa Perlu
Drag&drop itu enak di desktop, tapi di HP/mobile browser:
- Gak ada konsep "drag file dari luar browser ke dalam browser" yang natural kayak di desktop (gak ada file explorer yang gampang di-drag bareng browser, beda dari Windows/Mac).
- User HP biasanya expect klik tombol → muncul dialog pilih dari Galeri/File Manager, itu pattern yang familiar.

Jadi: desktop tetap bisa drag&drop seperti biasa, DITAMBAH tombol "+" sebagai opsi kedua. Di HP, tombol "+" inilah jalan utama (karena drag&drop gak praktis di situ).

## Constraint Penting — JANGAN UBAH backend yang sudah jalan
Fitur ini PURE penambahan di sisi cara user MEMILIH file. Flow setelah file terpilih (upload ke server sendiri via `/transfer/upload`, lalu `/transfer/request`, dst) **harus tetap sama** seperti yang sudah jalan di hari 5 — JANGAN bikin jalur kode baru yang beda dari yang sudah dites berhasil. Fungsi yang sudah ada di `client.js` untuk handle "file terpilih → upload → request" harus DI-REUSE, bukan diduplikasi/ditulis ulang.

## Spesifikasi Teknis

### 1. UI — Tambah Tombol di Tiap Card Device
Di `public/index.html` / render card device (`client.js`), di tiap card device yang sekarang ada teks "Seret file ke sini untuk mengirim", tambahin juga:
- Tombol kecil, misal ikon "+" atau teks "Pilih File", diletakkan di dalam card device yang sama (bukan di tempat terpisah, biar jelas "tombol ini buat kirim ke device INI").
- Tombol ini trigger `<input type="file">` yang **hidden** secara visual (gunakan CSS, jangan pakai `display:none` kalau butuh tetap accessible — pakai teknik visually-hidden standar, atau simpel pakai `style="display:none"` dan trigger via `inputElement.click()` dari JS, ini cukup untuk MVP).
- Tiap card device punya `<input type="file">` tersendiri (atau 1 input global yang "tau" device target mana yang sedang aktif dipilih sebelum `.click()` dipanggil) — pilih pendekatan yang lebih simpel untuk diimplementasikan tanpa duplikasi banyak kode.

### 2. Dukung Foto & Video, Tapi Tidak Membatasi ke Hanya Itu
- Set atribut `accept="image/*,video/*"` pada `<input type="file">` SEBAGAI HINT/filter supaya saat user klik tombol di HP, yang muncul prioritas Galeri foto/video (lebih natural untuk kasus pakai utama: kirim foto/video).
- **TAPI** jangan benar-benar membatasi tipe file di validasi backend — kode hari 4-5 yang sudah ada seharusnya sudah general untuk semua jenis file, JANGAN tambahkan validasi baru yang menolak file selain foto/video. Atribut `accept` ini hanya mempengaruhi UI picker, bukan pembatasan fungsional.

### 3. Event Handler
- Pasang `change` event listener di `<input type="file">`. Begitu user pilih file dari dialog (Galeri/File Manager), event ini fire dengan `event.target.files`.
- Ambil file pertama dari `event.target.files[0]` (selaras dengan drag&drop yang juga ambil 1 file pertama di hari 5 — TIDAK menambah dukungan multi-file di tahap ini, supaya konsisten dan tidak menambah kompleksitas yang tidak diminta).
- Panggil ulang fungsi yang SAMA yang dipakai drag&drop untuk proses "file terpilih → upload → kirim request" (refactor sedikit jika perlu supaya 1 fungsi bisa dipanggil dari 2 sumber: event `drop` dan event `change` input file — JANGAN tulis ulang logic upload dari nol).
- Setelah file diproses (berhasil mulai dikirim), reset value `<input type="file">` (`inputElement.value = ''`) supaya kalau user pilih file yang sama lagi nanti, event `change` tetap ke-trigger (browser tidak fire event `change` kalau value-nya tidak berubah dari file yang sama).

### 4. Styling
- Tombol harus cukup besar untuk di-tap di HP (minimal area tap sekitar 44x44px sesuai standar mobile usability, jangan dibuat terlalu kecil).
- Posisi tombol jangan menutupi/menghalangi area drag&drop yang sudah ada di desktop — pastikan keduanya tetap bisa dipakai bersamaan tanpa konflik tata letak.
- Sesuaikan dengan dark theme yang sudah dipakai di hari 5 (jangan bikin tombol dengan warna kontras yang tidak sesuai tema).

## Test "Selesai" (WAJIB dijalankan manual di kedua device)

### Di Desktop (laptop)
1. Buka `http://<IP-laptop>:3000`.
2. Pastikan drag&drop ke card device masih berfungsi seperti sebelumnya (regresi check — JANGAN sampai fitur lama rusak).
3. Klik tombol "+"/"Pilih File" di card device → dialog file explorer Windows harus muncul.
4. Pilih file (foto/video/file lain) → pastikan proses upload → request → accept di sisi penerima → progress bar tetap berjalan normal seperti hari 5.

### Di HP (Termux + browser)
1. Buka `http://localhost:3000` di HP.
2. Klik tombol "+"/"Pilih File" di card device (laptop) → harus muncul picker bawaan Android (biasanya pilihan: Galeri, File Manager, Camera, dll — karena `accept="image/*,video/*"`).
3. Pilih foto/video dari Galeri HP → pastikan flow lanjut sama seperti di desktop: upload, request muncul di laptop, accept di laptop, progress jalan, file sampai di folder `downloads/` laptop.
4. Test pilih file yang SAMA dua kali berturut-turut (verifikasi fix di poin 3 soal reset input value) — pastikan event `change` tetap ke-trigger kedua kalinya, bukan diam karena value tidak berubah.

## Potensi Masalah
- **Duplikasi logic upload** — risiko terbesar adalah AI agent menulis fungsi baru terpisah untuk handle file dari `<input>` yang mirip tapi tidak identik dengan fungsi drag&drop yang sudah ada, menyebabkan 2 jalur kode yang harus dipelihara terpisah dan mudah out-of-sync kalau ada perubahan di salah satunya nanti. Tegaskan ke AI agent: WAJIB reuse fungsi yang sama.
- **Lupa reset `input.value`** — bug halus yang baru kelihatan kalau user mencoba kirim file yang sama dua kali berturut-turut, gampang terlewat saat testing sekali jalan.
- **Browser HP custom (bukan Chrome/Firefox standar)** — beberapa browser HP punya UI file picker yang berbeda, tapi secara fungsional `<input type="file">` adalah standar HTML, seharusnya tetap berfungsi di hampir semua browser modern.

## Yang BUKAN Scope Ini
- Multi-file selection sekaligus → tetap di luar scope (selaras keputusan hari 5).
- Kompresi/resize foto/video sebelum kirim → di luar scope, kirim file asli seperti apa adanya.
- Preview thumbnail file sebelum kirim → bisa jadi pengembangan lanjutan, tidak wajib di tahap ini.
