# ADR-0009 — PIN untuk Halaman Pantau (UI Kirim File Tetap Terbuka)

- **Status:** Diterima
- **Tanggal:** 2026-11-01
- **Memengaruhi:** `server/pin.js` (baru), `server/settings.js`, `server/index.js`, `public/dashboard-login.html` (baru), `public/js/login.js` (baru), `public/dashboard.html`, `public/js/dashboard.js`, `scripts/check-dashboard.js`
- **Terkait:** [ADR-0007](0007-keamanan-berlapis-tanpa-autentikasi.md) (tidak digantikan; lihat "Konteks")

## Konteks

ADR-0007 memilih **tanpa autentikasi** karena alasan produk yang masih berlaku:
"kedua device buka URL yang sama" adalah inti janji LAN DROP. Pairing token berarti
langkah tambahan di alur kirim file — dan itu tetap ditolak.

Yang belum dijawab ADR-0007 adalah satu detail yang ditemukan saat pemakaian nyata:
port HTTP tidak cuma menyajikan UI kirim file, tapi juga **`/dashboard`** — halaman
pantau yang isinya riwayat transfer (nama file, ukuran, perangkat pengirim),
daftar peer, dan **isi log server**. Di Wi-Fi rumah yang isinya cuma perangkat
sendiri, itu tidak masalah. Begitu LAN DROP dipasang di kos, kantor, atau kafe —
tempat jaringan yang sama dipakai orang lain — halaman itu jadi jendela yang
memperlihatkan apa saja yang lewat.

Jadi masalahnya bukan "siapa boleh mengirim file" (soal itu sudah dijawab ADR-0007),
tapi **"siapa boleh mengintip"**. Dua pertanyaan itu pantas dijawab berbeda.

## Keputusan

**Halaman pantau dikunci PIN; UI kirim file tetap bebas.**

1. **Ruang lingkup gerbang cuma `/dashboard`.** Server yang memilih halaman:
   browser tanpa sesi sah menerima `dashboard-login.html`, browser bersesi menerima
   `dashboard.html`. Semua endpoint API (`/transfer/*`, `/history`, `/devices`,
   `/logs`, ...) **tidak** dikunci — halaman kirim file memakai endpoint yang sama
   dengan dashboard, jadi mengunci endpoint = mematahkan alur utama. Ini disadari
   dan dicatat sebagai batasan (lihat Konsekuensi).

2. **PIN 4-8 angka, default `123456`, ditampilkan sampai diganti.** PIN bawaan
   sengaja tidak disembunyikan: user yang baru pasang harus bisa masuk tanpa mencari
   dokumentasi, dan PIN yang tidak diketahui siapa pun akan berakhir jadi masalah
   dukungan ("saya terkunci dari server saya sendiri"). Selama PIN masih bawaan,
   server mengingatkan di log dan halaman login menampilkan hint. Begitu diganti,
   hint-nya hilang sendiri (`/dashboard/pin-info` balas `hint: null`).

3. **Sesi = cookie `HttpOnly; SameSite=Lax`, umur 30 hari, disimpan di memori.**
   Bukan di disk: restart server berarti semua browser diminta PIN lagi. Sesi di
   disk membuat "keluar" tidak ada artinya, karena token bisa hidup lebih lama dari
   niat user mencabutnya.

4. **Percobaan PIN dibatasi 10/menit per IP.** PIN yang lebih pendek dari kredensial
   akun hanya berguna kalau laju coba-coba juga dibatasi.

5. **Ganti PIN mematikan semua sesi** (`pin.revokeAll()`), termasuk sesi yang dipakai
   mengganti. Browser lama tidak boleh tetap masuk dengan izin lama.

6. **Perbandingan PIN pakai `crypto.timingSafeEqual`**, dan PIN disimpan apa adanya
   di `settings.json` — bukan hash. Alasannya: PIN ini pagar sopan-santun antar
   perangkat di satu jaringan, bukan kredensial akun; penyerang yang bisa membaca
   `settings.json` sudah memegang mesinnya. `ponytail:` dicatat di kode — ganti ke
   hash kalau suatu saat setting disinkronkan antar perangkat.

## Konsekuensi

**Yang didapat:**

- Tetangga Wi-Fi (atau tamu yang minta password WiFi) tidak bisa lagi membuka
  riwayat transfer dan log server cuma dengan menebak alamat.
- Alur kirim file tidak berubah sedikit pun: buka URL, kirim, kelar.
- Nol dependency baru; gerbangnya ~90 baris (`server/pin.js` + 4 rute).

**Yang dikorbankan / batasan yang harus diingat:**

- **PIN tidak menutup API.** Siapa pun yang bisa menjangkau portnya masih bisa
  membaca `/history` atau `/logs` lewat URL mentah atau `curl`. Gerbang ini menutup
  pengintaian lewat browser, bukan penyerang yang niat. Menutup API sepenuhnya butuh
  langkah yang berbeda (dan itu bertabrakan dengan alur HP yang harus tetap sekali-buka).
- **PIN bawaan = pintu terbuka** sampai user menggantinya. Karena itu pengingatnya
  ada di dua tempat (log server + halaman login).
- **Sesi hilang setiap server restart.** Untuk pemakaian harian di laptop pribadi ini
  jarang, tapi di Termux (server sering ikut proses hidup-mati Android) user akan
  mengetik PIN lebih sering daripada yang dia harapkan.
- **PIN dan sesinya lewat HTTP polos.** Di Wi-Fi terbuka, cookie sesi bisa disadap orang
  yang sudah ada di jaringan itu; umur 30 hari memperpanjang nilai cookie yang bocor.
  Di jaringan yang tidak dipercaya, LAN DROP memang bukan alat yang tepat (lihat
  ADR-0007) — PIN ini memperbaiki kasus "tetangga kos iseng", bukan penyadapan.
- **PIN lupa = mengedit `settings.json`** (`dashboardPin`) atau menghapus file itu untuk
  kembali ke `123456`. Belum ada tombol "lupa PIN" di UI, dan memang tidak mungkin
  dibuat tanpa jalur pemulihan yang bisa disalahgunakan.
