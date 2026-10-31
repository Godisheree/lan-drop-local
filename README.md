# LAN DROP

Bagikan file antar perangkat di jaringan lokal lewat browser — tanpa cloud, tanpa
setup, tanpa akun. HP buka dashboard, kirim file, dan file-nya mendarat langsung
di folder simpan PC (atau sebaliknya).

## Pasang

Butuh Node.js 18+.

**Jalan dari repo** — dapat menu tombol panah + ikon tray:

```bash
npm install
npm start
```

**Sebagai perintah `lan-drop`** — bisa dipanggil dari folder mana saja, tanpa
harus `cd` ke folder repo dulu:

```bash
npm i -g lan-drop-local
lan-drop
```

Belum terbit di npm registry? Pasang langsung dari GitHub — tanpa git, tanpa
login, sama-sama bisa di PC dan Termux:

```bash
npm i -g https://github.com/Godisheree/lan-drop-local/archive/refs/heads/main.tar.gz
lan-drop
```

## Pakai

1. Jalankan `lan-drop` (atau `npm start`).
2. Terminal menampilkan alamat dashboard, mis. `http://localhost:3000/dashboard`.
   Buka itu di browser PC, atau alamat LAN-nya (`http://192.168.x.x:3000/dashboard`)
   dari HP yang tersambung ke WiFi yang sama.
3. **Halaman pantau (`/dashboard`) minta PIN.** PIN bawaannya `123456` — halaman
   login menampilkan hint-nya selama kamu belum menggantinya. Ganti di dashboard
   (kartu PIN) supaya orang lain di WiFi yang sama tidak bisa membuka riwayat
   transfer dan log. Sekali masuk, browser itu diingat 30 hari. Yang ikut terkunci
   bukan cuma halamannya: isi log (`/logs`) juga minta sesi itu, karena tiap barisnya
   menyebut nama berkas, alamat IP, dan folder simpan.
4. Kirim / terima file dari UI utama (`http://192.168.x.x:3000/`) — halaman ini
   **tidak** dikunci, jadi HP tidak perlu mengetik apa pun buat mengirim.

Stop: `Ctrl+C` di terminal. Ganti port: `PORT=4000 lan-drop`. Kalau port itu
sudah dipakai aplikasi lain, LAN DROP pindah sendiri ke port kosong berikutnya
dan menampilkan alamat barunya — jadi tidak perlu dicari manual.

## Pengaturan lewat environment

| Env | Guna | Default |
|---|---|---|
| `PORT` | Port server (kalau sudah dipakai, LAN DROP naik ke port kosong di atasnya) | `3000` |
| `LANDROP_SAVE_DIR` | Folder tujuan file yang diterima (flat, tanpa kategori) | `%USERPROFILE%\Downloads\LAN-DROP` (Windows) / `~/storage/pictures` (Termux) |
| `LANDROP_DATA_DIR` | Folder history, pengaturan, buffer upload | `%APPDATA%\lan-drop` / `~/.lan-drop` |
| `LANDROP_UPLOAD_DIR` | Folder buffer upload (khusus, kalau mau dipisah) | ikut data dir |
| `LANDROP_MAX_UPLOAD_MB` | Batas ukuran satu file | `2048` |
| `LANDROP_NO_BROWSER` | `1` = jangan buka dashboard di browser otomatis | (kosong) |
| `LANDROP_PEERS` | Peer manual (`Nama@ip:port@transferPort`, dipisah `,`) | auto-discovery |

## Catatan

- **Ikon tray** cuma ada kalau Electron terpasang — yaitu kalau dijalankan dari
  repo (`npm install` lalu `npm start`). Install global sengaja tidak membawa
  Electron (240 MB) karena mode global fokus jadi server CLI.
- **History & pengaturan** disimpan di luar folder install, jadi aman saat paket
  di-update: `%APPDATA%\lan-drop` (Windows) atau `~/.lan-drop` (Termux/Linux).

## Lisensi

ISC.
