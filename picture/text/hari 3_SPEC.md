# Spek Hari 3 — TCP Handshake (LAN Drop)

## Konteks
Hari 1: server Express jalan, bisa diakses dari HP.
Hari 2: UDP discovery selesai — device bisa saling detect via `/devices` (broadcast tiap 2 detik, port UDP 41234, timeout 10 detik).

Sekarang Hari 3: bangun TCP handshake. Device A bisa kirim "permintaan transfer" (metadata file) ke Device B yang dipilih dari list `/devices`. Device B accept/reject. **belum ada file yang benar-benar ditransfer** — itu scope hari 4. Hari 3 cuma sampai negosiasi accept/reject.

## File yang Dibuat/Diedit
- `server/transfer.js` — logic TCP server + client + handshake (placeholder kosong dari hari 1, sekarang diisi)
- `server/index.js` — import & start TCP server, tambahin route buat trigger kirim request & buat respond accept/reject

## Spesifikasi Teknis

### 1. Konstanta
```js
const TRANSFER_PORT = 3001; // BEDA dari port Express (3000) dan port discovery UDP (41234)
```

### 2. Packet Framing (PENTING — dipakai di kedua arah komunikasi)
Karena TCP adalah stream byte tanpa batas pesan otomatis, gunakan **4-byte length-prefix**:
- Sebelum kirim JSON metadata, hitung panjang byte JSON-nya (`Buffer.byteLength(json)`), tulis sebagai 4-byte integer (`Buffer.alloc(4); buf.writeUInt32BE(length)`), kirim buffer itu duluan, baru kirim JSON-nya.
- Penerima: baca data masuk via socket `data` event, akumulasi ke buffer. Begitu udah punya minimal 4 byte pertama, baca `readUInt32BE(0)` buat tau panjang JSON yang ditunggu. Begitu total data yang masuk udah cukup (4 + panjang itu), parse bagian JSON-nya, sisa buffer (kalau ada) disimpan buat pesan berikutnya.
- Buat helper function reusable, misal `sendFramedMessage(socket, obj)` dan kelas/helper parser `FrameParser` yang nge-handle accumulate buffer ini — supaya nanti hari 4 bisa dipakai ulang pattern yang sama buat metadata sebelum streaming file.

### 3. TCP Server (penerima permintaan)
- Pakai modul `net`, buat `net.createServer()`, listen di `TRANSFER_PORT`, bind ke `0.0.0.0` (supaya device lain bisa connect, bukan cuma localhost — sama prinsipnya kayak hari 1).
- Tiap ada koneksi masuk (`connection` event):
  - Pasang frame parser ke socket itu.
  - Begitu metadata pertama diterima (`{ type: 'transfer-request', fileName, fileSize, senderName, senderId }`), simpan socket itu ke in-memory store sebagai "pending request", misal:
    ```js
    const pendingRequests = new Map();
    // key: requestId (generate uuid/random string), value: { socket, fileName, fileSize, senderName, senderId, status: 'pending' }
    ```
  - **Jangan langsung balas apa-apa** — nunggu user respond lewat endpoint (lihat poin 5).

### 4. TCP Client (pengirim permintaan)
- Fungsi `sendTransferRequest(targetIp, targetPort, metadata)`:
  - `net.createConnection({ host: targetIp, port: targetPort })`
  - Begitu connect, kirim metadata pakai `sendFramedMessage` dengan `type: 'transfer-request'`.
  - Simpan koneksi ini juga (di sisi pengirim) supaya nanti bisa nerima balasan ACCEPTED/REJECTED dari socket yang sama — JANGAN tutup koneksi setelah kirim metadata, harus tetap nunggu dan listen response.
  - Pasang frame parser juga di sisi ini buat baca respons balik `{ type: 'transfer-response', accepted: true/false }`.

### 5. Endpoint Express (buat dites manual sebelum ada UI di hari 5)

**Trigger kirim request:**
```js
// POST /transfer/request
// body: { targetIp, targetPort, fileName, fileSize }
// panggil sendTransferRequest(), balikin requestId ke caller supaya bisa di-track
```

**Cek pending request yang masuk (simulasi "notifikasi"):**
```js
// GET /transfer/pending
// balikin array semua pendingRequests yang statusnya masih 'pending'
```

**Respond accept/reject:**
```js
// POST /transfer/respond
// body: { requestId, accept: true/false }
// ambil socket dari pendingRequests pakai requestId
// kirim balik via sendFramedMessage: { type: 'transfer-response', accepted: true/false }
// update status di pendingRequests, kalau reject -> hapus dari Map & socket.end()
// kalau accept -> status jadi 'accepted', socket JANGAN ditutup (akan dipakai streaming file di hari 4)
```

**Cek status dari sisi pengirim:**
```js
// GET /transfer/status/:requestId
// balikin status terbaru (pending/accepted/rejected) dari request yang dikirim
```

### 6. Export
`transfer.js` export: fungsi untuk start TCP server, fungsi `sendTransferRequest`, dan akses ke `pendingRequests` Map — dipanggil dari `index.js`.

## Test "Selesai" (WAJIB dijalankan manual, bukan asumsi)
Karena belum ada UI, testing pakai `curl` atau Postman, idealnya pakai 2 device fisik (laptop + HP, atau 2 laptop) supaya representatif — tapi 2 proses Node beda port di 1 laptop juga valid buat tes hari 3 ini (TCP gak serewel UDP soal isolation/port conflict).

1. Jalankan instance A (port Express 3000, TRANSFER_PORT 3001) dan instance B (port Express 4000, TRANSFER_PORT 4001) — kalau di laptop yang sama, pastikan port-port ini gak bentrok.
2. Dari instance A, kirim request ke instance B:
   ```
   curl -X POST http://localhost:3000/transfer/request \
     -H "Content-Type: application/json" \
     -d '{"targetIp":"localhost","targetPort":4001,"fileName":"test.txt","fileSize":1024}'
   ```
   → harus balikin `requestId`.
3. Cek di instance B: `curl http://localhost:4000/transfer/pending` → harus muncul request yang barusan dikirim, status `pending`.
4. Accept dari instance B:
   ```
   curl -X POST http://localhost:4000/transfer/respond \
     -H "Content-Type: application/json" \
     -d '{"requestId":"<requestId dari langkah 2>","accept":true}'
   ```
5. Cek di instance A: `curl http://localhost:3000/transfer/status/<requestId>` → harus berubah jadi `accepted`.
6. Ulangi dari langkah 2 tapi kali ini di langkah 4 kirim `accept:false` → pastikan status di instance A berubah jadi `rejected`, dan koneksi socket di instance B ke-close (gak nyangkut).
7. Test edge case: requestId yang gak ada (asal-asalan) di `/transfer/respond` → harus return error yang jelas (4xx), bukan crash server.

## Potensi Masalah
- **Lupa bind `0.0.0.0`** — kalau cuma listen default, device lain gak akan bisa connect ke TCP server ini sama kasusnya kayak hari 1.
- **Socket leak** — kalau request di-reject atau timeout tapi socket gak di-`end()`/`destroy()`, lama-lama numpuk koneksi nganggur. Pastikan tiap path (reject, error, disconnect tiba-tiba) selalu nutup socket.
- **Partial data di frame parser** — TCP bisa kirim data kepotong-potong (gak selalu 1 event = 1 pesan utuh). Frame parser HARUS akumulasi buffer dengan benar, jangan asumsi 1 `data` event = 1 metadata lengkap. Ini bug paling umum kalau packet framing gak diimplementasi hati-hati.
- **Firewall TCP port baru** — kalau testing lintas device (bukan cuma localhost), mungkin perlu allow port 3001/4001 juga di firewall, sama kayak kasus hari 1.

## Yang BUKAN Scope Hari 3
- Streaming file beneran (`fs.createReadStream`/`createWriteStream`) → itu hari 4.
- UI prompt accept/reject yang user-friendly → itu hari 5. Hari 3 cukup sampai endpoint manual via curl.
