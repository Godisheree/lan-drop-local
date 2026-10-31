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

1. **Ruang lingkup gerbang: halaman pantau + data yang dibacanya.** Server yang
   memilih halaman: browser tanpa sesi sah menerima `dashboard-login.html`, browser
   bersesi menerima `dashboard.html`. Yang ikut dikunci: `/logs` (menolak 401 tanpa
   sesi) dan jalur statis `/dashboard.html` (dialihkan ke `/dashboard`). Alasannya
   ditemukan saat audit setelah gerbang ini dipasang — mengunci halamannya saja tidak
   ada artinya kalau isi yang sama bisa dibaca lewat `curl /logs`, dan `public/dashboard.html`
   tetap tersaji sebagai berkas statis di alamat lain (bukti pengukuran di bagian
   "Audit setelah gerbang dipasang"). Endpoint yang dipakai UI kirim file
   (`/transfer/*`, `/history`, `/devices`, `/status`, `/discovery/status`) **tetap
   terbuka**: halaman kirim file memakai endpoint yang sama dengan dashboard, jadi
   mengunci semuanya = mematahkan alur utama. `/history` khususnya memang ditampilkan
   oleh panel riwayat di UI utama — jadi bukan rahasia yang bisa ditutup tanpa
   mengubah janji ADR-0007; yang ditutup adalah **log server**, yang tidak pernah
   muncul di UI utama.

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

- **PIN tidak menutup alur kirim file.** Siapa pun yang bisa menjangkau portnya masih
  bisa membaca `/history`, `/devices`, dan `/status` lewat URL mentah atau `curl` —
  endpoint itu memang dipakai UI kirim file. Yang ditutup: halaman pantau dan `/logs`
  (isi log menyebut nama berkas, alamat IP, dan folder simpan — tidak ada di UI utama).
  Gerbang ini menutup pengintaian lewat browser dan lewat `curl /logs`, bukan penyerang
  yang niat; menutup seluruh API berarti mengubah janji ADR-0007.
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

## Audit setelah gerbang dipasang

Gerbang di atas diuji ulang dengan `curl` ke instance terpisah (port uji, `LANDROP_DATA_DIR`
di luar repo) — bukan lewat browser, karena yang mau dibuktikan justru jalur non-browser.
Dua lubang ketemu, keduanya sudah ditutup:

1. **`GET /dashboard.html` → HTTP 200, 9332 byte, berisi `logPane`.** Halaman itu ada di
   `public/`, jadi `express.static` menyajikannya apa adanya di alamat lain — gerbang PIN
   di `/dashboard` tidak pernah dilewati. Ditutup dengan pengalihan tetap ke `/dashboard`
   sebelum middleware statis. Sekarang: `HTTP 302 → /dashboard`, dan tanpa sesi yang
   terkirim halaman PIN (1592 byte, tanpa `logPane`).
2. **`GET /logs?since=0` → HTTP 200 tanpa cookie.** Isi log memuat nama perangkat,
   alamat IP laptop, nama berkas yang dikirim, dan folder simpan — yaitu hal yang
   persis mau ditutup. Ditutup: tanpa sesi sekarang `HTTP 401 {"error":"Perlu PIN dashboard"}`,
   dengan sesi tetap `200` + `{lines, lastId, depth}` seperti sebelumnya.

Yang **diukur tetap aman** setelah ditutup: `/dashboard` dan `/dashboard/` tanpa sesi →
halaman PIN (tidak ada `logPane`) · cookie palsu/kosong → tetap halaman PIN · PIN salah →
401, PIN 8 angka (panjang beda dari bawaan) → 401 (bukan 500) · payload aneh
(`{"pin":123456}`, `{"pin":null}`, `{}`) → 401, bodi bukan JSON → 400 · `POST /dashboard/pin`
tanpa sesi → 401 · 12 percobaan PIN berturut-turut → 401, 401, lalu 429 (rate limit bekerja) ·
logout → kembali ke halaman PIN · UI kirim file `/` tetap `200` tanpa PIN, begitu juga
`/history` (dipakai panel riwayat UI utama) · header `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, CSP `default-src 'self'` terpasang di halaman PIN.
Kesimpulan yang sama juga jadi pemeriksaan tetap di `scripts/check-dashboard.js`
(`/dashboard.html` 302, `/logs` 401 tanpa sesi, `200` dengan sesi) supaya lubang ini tidak
bisa balik tanpa ada yang gagal.
