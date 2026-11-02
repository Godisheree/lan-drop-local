# Fitur: Tombol "Batal" untuk File yang Lagi Dikirim

Mencakup 2 kondisi: masih nunggu diterima ATAU udah lagi jalan transfer-nya.

## Konteks Penting (baca dulu sebelum ngoding)

1. `requestId` **TIDAK sama** antara pengirim & penerima. Pengirim generate `requestId` sendiri buat `outgoingRequests`, dan frame `"transfer-request"` yang dikirim ke penerima **TIDAK menyertakan** `requestId` itu — penerima generate `requestId` sendiri lagi buat `pendingRequests` pas nerima frame itu. Jadi jangan coba sinkronin `requestId` lintas device. Cara cancel yang benar: masing-masing sisi cukup destroy koneksi TCP lokalnya sendiri (via referensi socket yang udah disimpan di `outgoingRequests`/`pendingRequests`) — sisi lain otomatis bakal ngerasain socket close/error di listener yang udah ada, dan react pake `requestId` versi dia sendiri.

2. Ada bug existing yang **harus** dibenerin bareng fitur ini, kalau nggak fitur cancel bakal keliatan "berhasil" padahal file kepotong: di `server/transfer.js` fungsi `startFileSend()`, `socket.on('close')` (~baris 712) nganggep semua close pas status `'transferring'` = `'completed'`, tanpa cek `bytesTransferred` vs `fileSize`. Sama juga di `server/transfer.js` `startRawReceive()` — gak ada listener socket `'close'` sama sekali di fase nerima raw bytes (cuma ada `writeStream 'finish'` dan `'error'`), jadi kalau koneksi diputus paksa di tengah nerima file, gak ada cleanup partial file sama sekali.

## Backend (`server/transfer.js`)

**A.** Simpan referensi `readStream` di `outgoingRequests` supaya bisa di-destroy nanti: di `startFileSend()`, setelah `const readStream = fs.createReadStream(sendFilePath);` tambahin `req.readStream = readStream;` (`req` = `outgoingRequests.get(requestId)`)

**B.** Fungsi baru: `cancelOutgoingTransfer(requestId)`
- Ambil `req` dari `outgoingRequests`
- Kalau gak ketemu → throw error `"Request not found"`
- Kalau `req.readStream` ada → `req.readStream.destroy()`
- `req.socket.destroy()`
- Update `transferProgress.get(requestId).status = 'cancelled'` (kalau entry-nya ada)
- `outgoingRequests.delete(requestId)`
- Export fungsi ini

**C.** Fix `socket.on('close')` di `startFileSend` (~baris 712-719):

Sebelum set status `'completed'`, cek dulu:

```js
socket.on('close', () => {
  const p = transferProgress.get(requestId);
  if (p && p.status === 'transferring') {
    p.status = (p.bytesTransferred >= p.fileSize) ? 'completed' : 'cancelled';
  }
  req.status = p ? p.status : 'disconnected';
});
```

**D.** Tambahin `socket.on('close')` di `startRawReceive()`, di dalam branch `meta.type === 'file-start'` (taruh sejajar sama `writeStream.on('finish')` dan `writeStream.on('error')` yang udah ada):

```js
socket.on('close', () => {
  if (written < totalSize) {
    // Transfer keputus di tengah jalan — bukan selesai normal (itu udah dihandle di writeStream 'finish')
    writeStream.destroy();
    fs.unlink(savePath, () => {}); // hapus file partial, abaikan error kalau udah kehapus/gak ada
    const p = transferProgress.get(requestId);
    if (p && p.status === 'transferring') p.status = 'cancelled';
    req.status = 'cancelled';
  }
});
```

> **Penting:** pastiin listener ini gak nabrak sama `writeStream 'finish'` yang udah jalan normal (kalau `writeStream` udah `'finish'` duluan baru socket close, `written` harusnya udah >= `totalSize`, jadi kondisi `written < totalSize` otomatis `false`, aman).

**E.** Fungsi baru: `cancelIncomingTransfer(requestId)` — buat kasus penerima mau batalin transfer yang lagi dia terima (bonus, kalau sempat):
- Ambil `req` dari `pendingRequests`
- `req.socket.destroy()` (bakal ke-trigger listener di poin D di sisi ini, dan bikin sender ngerasain close juga)
- `pendingRequests.delete(requestId)`

**F.** Export `cancelOutgoingTransfer` dan `cancelIncomingTransfer` dari `module.exports`

## Backend (`server/index.js`)

Endpoint baru:

```js
app.post('/transfer/cancel/:requestId', (req, res) => {
  const { requestId } = req.params;
  const { role } = req.body; // 'send' atau 'receive'
  try {
    if (role === 'receive') {
      transfer.cancelIncomingTransfer(requestId);
    } else {
      transfer.cancelOutgoingTransfer(requestId);
    }
    res.json({ requestId, status: 'cancelled' });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});
```

## Frontend (`public/client.js`)

**A.** Tombol "✕ Batal" di `addTransferItem()` — cuma muncul kalau `data.status` `'waiting'` atau `'transferring'`, DAN `direction === 'send'` (fokus ke pengirim dulu). Tambahin di template HTML-nya (dalam `div.tf-header` atau bikin row baru), contoh:

```html
<button class="btn-cancel" data-rid="${requestId}">✕ Batal</button>
```

**B.** Event delegation buat tombol cancel (taruh di bagian "Button Listeners" paling bawah):

```js
document.getElementById('transferList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-cancel');
  if (!btn) return;
  const requestId = btn.dataset.rid;
  btn.disabled = true;
  try {
    await api(`/transfer/cancel/${requestId}`, {
      method: 'POST',
      body: JSON.stringify({ role: 'send' })
    });
    if (progressTimers.has(requestId)) {
      clearInterval(progressTimers.get(requestId));
      progressTimers.delete(requestId);
    }
    updateTransferItem(requestId, { status: 'cancelled', statusText: '🚫 Dibatalkan' });
  } catch (err) {
    showToast('❌ Gagal membatalkan: ' + err.message, 'error');
    btn.disabled = false;
  }
});
```

**C. FIX WAJIB:** `pollSendStatus()` (~baris 366) dan `pollProgress()` (~baris 618) nge-wrap semua logic dalam try/catch kosong (`catch (_) {}`) — kalau request udah kebatalin/kehapus dari `outgoingRequests`, endpoint `/transfer/status` atau `/transfer/progress` bakal 404, `api()` throw error, ke-catch diem-diem, TAPI `setInterval`-nya jalan terus selamanya nembak endpoint yang udah gak ada.

Tambahin: kalau status code 404 DAN item itu statusnya udah `'cancelled'` di `activeTransfers`, `clearInterval` dan stop. Simple fix: cek `activeTransfers.get(requestId)` di awal callback interval — kalau udah gak ada di Map (udah dihapus `updateTransferItem`) atau statusnya `'cancelled'`, langsung `clearInterval` dan return.

**D.** Update `pollProgress()` buat handle status `'cancelled'` dari backend (mirip handling `'completed'`/`'failed'` yang udah ada):

```js
if (prog.status === 'cancelled') {
  clearInterval(timer);
  progressTimers.delete(requestId);
  updateTransferItem(requestId, { status: 'cancelled', statusText: '🚫 Dibatalkan', percent, transferred, total });
  return;
}
```

**E. Bonus** (kalau sempat): di `fetchPending()` (~baris 409), deteksi kalau item yang lagi tampil di modal (`currentGroup`) ternyata hilang dari hasil polling `/transfer/pending` (berarti dibatalkan sender) → auto `hideModal()` + toast "Pengirim membatalkan kiriman".

## Self-Testing (wajib dilakuin sendiri sebelum lapor selesai)

Jalanin 2 instance server lokal buat simulasi 2 device tanpa perlu device fisik:

```bash
# Terminal 1 (device A / "pengirim")
PORT=3000 TRANSFER_PORT=3001 DEVICE_NAME=DeviceA node server/index.js

# Terminal 2 (device B / "penerima")
PORT=3010 TRANSFER_PORT=3011 DEVICE_NAME=DeviceB node server/index.js
```

Buka dua tab browser: `localhost:3000` dan `localhost:3010`.

Test case yang **wajib** disimulasiin sendiri dan dilaporin hasilnya satu-satu:

1. **Cancel saat status "waiting"** (belum di-*accept* penerima): kirim file dari device A, jangan *accept* di device B, langsung klik Batal di device A.
   Cek: item hilang/berubah jadi "Dibatalkan" di A, dan permintaan di B (kalau modal masih kebuka) idealnya ke-*dismiss* juga.

2. **Cancel di tengah transfer** (file besar, misal generate dummy file ~200MB+ pake `dd if=/dev/zero of=test-large.bin bs=1M count=200` biar transfer-nya kelamaan buat sempat diklik cancel): *accept* di B, pas progress bar udah jalan (misal di 20-30%), klik Batal di A.
   Cek:
   - Socket beneran keputus (liat log di kedua terminal)
   - File partial di folder `downloads/` sisi B ke-hapus (gak nyisa file setengah jadi)
   - Status di UI kedua sisi jadi "Dibatalkan"/`cancelled`, BUKAN `completed`
   - Polling interval beneran berhenti (buka DevTools Network tab, pastiin gak ada request `/transfer/progress` atau `/transfer/status` yang masih jalan tiap detik ke request yang udah dibatalin)

3. **Transfer normal tanpa cancel** (regression test) — pastiin fitur cancel yang baru ditambah gak ngerusak flow normal: kirim file kecil, terima normal sampai selesai, pastiin status akhirnya tetep `completed` bukan ke-*flag* salah jadi `cancelled` gara-gara fix di poin C/D backend.

4. **Cancel yang telat** (race condition): coba klik Batal PAS BARENGAN file udah selesai terkirim (klik pas progress di 99-100%) — pastiin gak crash/error, dan status akhir yang menang salah satu aja (`completed` ATAU `cancelled`), gak dobel-status atau UI nyangkut di "loading".

Laporin hasil 4 test case ini + summary bug apa aja yang ketemu pas testing (kalau ada) dan udah difix atau belum.
