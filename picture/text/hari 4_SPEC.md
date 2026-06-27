# Spek Hari 4 — Data Streaming (LAN Drop)

## Konteks
- Hari 1: server Express jalan, akses lintas device oke.
- Hari 2: UDP discovery — device saling detect via `/devices`.
- Hari 3: TCP handshake selesai — Device A bisa kirim transfer request ke Device B, B accept/reject via endpoint manual (`/transfer/request`, `/transfer/pending`, `/transfer/respond`, `/transfer/status/:requestId`). Begitu `accepted`, socket TCP di kedua sisi **TETAP TERBUKA** (sengaja, biar bisa dipakai streaming).

Sekarang Hari 4: begitu status `accepted`, alirkan file beneran dari A ke B lewat socket itu. Ini PEMBUKTIAN inti aplikasi — sebelumnya cuma negosiasi, sekarang data sungguhan jalan.

## File yang Diedit
- `server/transfer.js` — tambahin logic streaming di atas struktur yang udah ada dari hari 3
- `server/index.js` — tambahin endpoint progress & endpoint upload (lihat poin 5)

## Spesifikasi Teknis

### 1. Constraint Penting dari Hari 3 yang HARUS Dipertahankan
- Jangan ubah packet framing (4-byte length-prefix) yang udah dipakai buat metadata handshake. Reuse helper `sendFramedMessage` / frame parser yang sudah ada.
- Socket yang sudah `accepted` di `pendingRequests` (dari hari 3) adalah socket yang dipakai streaming — JANGAN buat koneksi TCP baru buat transfer file. Satu koneksi dipakai dari awal (metadata) sampai akhir (file selesai).

### 2. Sisi Pengirim (setelah dapat konfirmasi `accepted`)
- Pengirim butuh tau path file asli di disk. Karena ini app desktop (Electron nanti), asumsikan untuk hari 4 user kasih path file lewat endpoint (lihat poin 5), BUKAN lewat file picker dulu (file picker UI itu hari 5).
- Begitu terima sinyal `accepted` dari Device B (lewat response hari 3):
  ```js
  const readStream = fs.createReadStream(filePath);
  readStream.pipe(socket, { end: false }); // end:false -> jangan auto-close socket, masih perlu baca confirmasi dari penerima
  ```
- **Progress tracking pengirim** — pasang listener di `readStream` event `data`, akumulasi `bytesSent += chunk.length`, simpan ke struktur yang bisa diakses endpoint progress (lihat poin 4).
- Tangani event `error` di `readStream` (misal file gak ketemu / permission error) — JANGAN biarkan crash, kirim sinyal error ke penerima kalau bisa, dan update status request jadi `failed`.

### 3. Sisi Penerima
- Tentukan folder simpan default, misal `./downloads/` (buat folder ini kalau belum ada, pakai `fs.mkdirSync(path, { recursive: true })`).
- Begitu socket yang statusnya `accepted` mulai nerima data **setelah** metadata handshake (bukan JSON lagi, ini raw file bytes):
  ```js
  const writeStream = fs.createWriteStream(savePath);
  socket.pipe(writeStream);
  ```
  **PENTING — potensi bug paling umum di hari ini:** socket yang sama dipakai buat JSON metadata (hari 3, lewat frame parser) DAN raw file bytes (hari 4). Pastikan frame parser BERHENTI dipasang/listening ke socket itu setelah metadata handshake selesai diproses, supaya byte file mentah gak ketelan/parsing-error oleh frame parser yang masih nyangkut. Kalau pakai `socket.on('data', ...)` manual buat frame parser, lepas listener itu (`socket.removeListener` atau pakai flag state) sebelum mulai `socket.pipe(writeStream)`.
- **Progress tracking penerima** — pasang listener `data` di socket (sebelum di-pipe, atau lewat event yang tetap terpantau), akumulasi `bytesReceived`, bandingkan ke `fileSize` dari metadata hari 3.
- Begitu `writeStream` emit event `finish` (semua data sudah ditulis ke disk), berarti transfer selesai. Update status request jadi `completed`. Kirim balik sinyal selesai ke pengirim — bisa pakai cara simpel: tutup socket dengan `socket.end()` (pengirim deteksi lewat event `close`/`end` di socketnya sebagai tanda "penerima sudah selesai nulis").

### 4. Endpoint Progress
```js
// GET /transfer/progress/:requestId
// balikin: { requestId, fileName, fileSize, bytesTransferred, percent, status }
// status salah satu dari: 'transferring' | 'completed' | 'failed'
```
Ini dipakai polling dari UI hari 5 buat nampilin progress bar — desain response-nya supaya gampang langsung dipakai (jangan ubah lagi strukturnya di hari 5 kalau bisa dihindari).

### 5. Endpoint Trigger Kirim File (pelengkap, dipanggil SETELAH status accepted)
Karena belum ada file picker UI, hari 4 butuh cara kasih path file manual:
```js
// POST /transfer/send-file
// body: { requestId, filePath }
// validasi: requestId harus ada di pendingRequests DAN statusnya 'accepted'
// validasi: filePath harus ada di disk (fs.existsSync) sebelum mulai streaming, return 400 kalau tidak ada
// mulai proses streaming dari poin 2
```
Catatan: di hari 5, alur ini bakal diganti supaya `fileName`+`fileSize` di metadata request (hari 3) diambil otomatis dari file yang di-drag user, dan `filePath` dikirim otomatis setelah accept — tapi untuk hari 4, manual lewat endpoint ini dulu cukup.

## Test "Selesai" (WAJIB dijalankan, bukan asumsi)
Gunakan 2 instance (laptop+HP idealnya, atau 2 proses port beda di 1 laptop kayak hari 3) dan ulangi flow hari 3 sampai `accepted`, lalu:

1. Siapkan file kecil dulu buat tes awal, misal `test.txt` isi beberapa kalimat (bukan file kosong).
2. Jalankan ulang flow hari 3 (request → accept) sampai dapat `requestId` dengan status `accepted`.
3. Trigger kirim file:
   ```
   curl -X POST http://localhost:3000/transfer/send-file \
     -H "Content-Type: application/json" \
     -d '{"requestId":"<requestId>","filePath":"/path/ke/test.txt"}'
   ```
4. Poll progress dari sisi penerima: `curl http://localhost:4000/transfer/progress/<requestId>` berulang kali → `bytesTransferred` harus naik, akhirnya `status` jadi `completed`, `percent` jadi 100.
5. Cek file beneran ada dan ISINYA SAMA di folder `downloads/` milik instance penerima (`diff test.txt downloads/test.txt` harus kosong/identik, jangan cuma cek ukuran file).
6. Ulangi dengan file yang lebih besar (misal video/zip beberapa puluh MB) — pastikan app TIDAK freeze selama proses, dan progress naik bertahap (bukan loncat 0% ke 100% — kalau itu yang kejadian, mungkin streaming-nya gak benar dan malah baca seluruh file ke memori dulu).
7. Test error case: `filePath` yang gak ada → harus return error jelas (400), bukan crash server atau hang selamanya.

## Potensi Masalah
- **Frame parser nyangkut ke socket pas fase file streaming** — ini bug paling mungkin terjadi, sudah dijelaskan di poin 3. Kalau penerima nerima file yang isinya korup/aneh di awal beberapa byte, ini kemungkinan besar penyebabnya.
- **Lupa `{ end: false }` di `.pipe()` sisi pengirim** — defaultnya `pipe()` otomatis `end()` socket tujuan begitu read stream selesai, padahal mungkin masih perlu socket itu buat terima sinyal balik dari penerima.
- **Path file tidak valid / relative path membingungkan** — pastikan testing pakai absolute path biar gak ambigu file dibaca dari folder mana.
- **Disk penuh / permission folder `downloads/`** — tangani error `writeStream.on('error', ...)`, jangan biarkan proses nyangkut diam-diam.

## Yang BUKAN Scope Hari 4
- File picker / drag-and-drop UI → hari 5.
- Progress bar visual → hari 5 (hari 4 cukup endpoint JSON progress).
- Resume transfer, multi-file, enkripsi → fitur opsional di luar 7 hari MVP.
