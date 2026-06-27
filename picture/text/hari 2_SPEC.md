# Spek Hari 2 — UDP Discovery (LAN Drop)

## Konteks
Hari 1 udah selesai: server Express jalan di port 3000, bisa diakses dari HP via IP lokal (`http://192.168.1.12:3000`). Sekarang lanjut bikin fitur **auto-discovery** pakai UDP broadcast, supaya device-device di jaringan yang sama otomatis "ketemu" satu sama lain tanpa perlu ketik IP manual.

## Tujuan Akhir Hari 2
- Tiap device yang jalanin LAN Drop otomatis broadcast keberadaannya ke jaringan.
- Tiap device juga listen broadcast dari device lain, dan nyimpen list device yang lagi online.
- Ada endpoint `GET /devices` yang balikin list device online (buat dipakai UI nanti di hari 5).
- Device yang udah nggak aktif (nggak broadcast lagi dalam waktu tertentu) otomatis dianggap offline dan dihapus dari list.

## File yang Dibuat/Diedit
- `server/discovery.js` — logic UDP broadcaster + listener (file ini udah ada placeholder kosong dari hari 1, sekarang diisi)
- `server/index.js` — import & jalankan discovery, tambahin route `/devices`

## Spesifikasi Teknis

### 1. Konstanta
```js
const DISCOVERY_PORT = 41234;       // port khusus discovery, BEDA dari port server (3000)
const BROADCAST_INTERVAL = 2000;    // broadcast tiap 2 detik
const DEVICE_TIMEOUT = 10000;       // device dianggap offline kalau gak broadcast 10 detik
```

### 2. Identitas Device
Tiap device butuh ID unik biar bisa filter diri sendiri dari list. Generate sekali pas server start, bisa pakai kombinasi hostname + random string:
```js
const os = require('os');
const deviceId = `${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`;
const deviceName = os.hostname(); // nama yang ditampilin di UI nanti
```

### 3. Broadcaster
- Pakai modul `dgram`, buat socket UDP.
- **Wajib** panggil `socket.setBroadcast(true)` sebelum kirim — kalau lupa ini, broadcast nggak akan terkirim sama sekali.
- Kirim pesan JSON berisi: `deviceId`, `deviceName`, `ip` (ambil dari `os.networkInterfaces()`, filter yang `family === 'IPv4'` dan `!internal`), `port` (port server Express, 3000).
- Kirim ke alamat `255.255.255.255` di `DISCOVERY_PORT`, ulang tiap `BROADCAST_INTERVAL` pakai `setInterval`.

### 4. Listener
- Buka socket UDP terpisah, bind ke `DISCOVERY_PORT`.
- Tiap terima pesan: parse JSON, **filter kalau `deviceId` sama dengan diri sendiri (skip, jangan masukin ke list)**.
- Simpan/update ke in-memory store, misal `Map`:
```js
const knownDevices = new Map();
// key: deviceId, value: { deviceName, ip, port, lastSeen: Date.now() }
```
- Tiap terima broadcast valid dari device lain, update `lastSeen` ke waktu sekarang.

### 5. Cleanup Stale Devices
- Pakai `setInterval` terpisah (misal jalan tiap 3 detik), loop semua entry di `knownDevices`.
- Kalau `Date.now() - lastSeen > DEVICE_TIMEOUT`, hapus device itu dari Map (dianggap offline).

### 6. Endpoint
Di `server/index.js`, tambahin route:
```js
app.get('/devices', (req, res) => {
  const devices = Array.from(knownDevices.values());
  res.json(devices);
});
```

### 7. Export
`discovery.js` harus export fungsi untuk start discovery (broadcaster + listener + cleanup) dan akses ke `knownDevices`, dipanggil dari `index.js` pas server start.

## Test "Selesai" (WAJIB dijalankan, jangan cuma asumsi compile sukses)
1. Jalankan server di laptop.
2. Jalankan **instance kedua** server (di port beda, misal 3001, atau di device kedua/HP kalau ada Node di HP) — atau kalau cuma punya 1 device buat dites, jalankan 2 proses Node di laptop yang sama dengan port server berbeda tapi discovery port boleh konflik (catat kalau ini jadi masalah, port UDP listen di port sama dari 2 proses di 1 device kadang error `EADDRINUSE`, kalau kejadian gunakan `socket.bind({port, exclusive: false})` atau test discovery cuma bisa divalidasi penuh dengan 2 device fisik beda).
3. Buka `http://localhost:3000/devices` (atau dari HP `http://<IP-laptop>:3000/devices`) — harus muncul JSON array berisi device LAIN yang lagi nyala (bukan device yang lagi dipakai buat ngakses, karena device sendiri di-filter).
4. Matikan salah satu instance, tunggu ~10 detik, refresh `/devices` — device yang dimatikan harus udah hilang dari list.

## Potensi Masalah (sudah diketahui dari Hari 1, kemungkinan muncul lagi)
- **AP/Client Isolation di router** — kalau ini belum di-fix permanen dari hari 1, UDP broadcast kemungkinan besar KENA JUGA (bahkan lebih sensitif dari TCP biasa). Kalau `/devices` selalu kosong padahal device lain udah jalan, ini kemungkinan besar penyebabnya, bukan bug kode. Cek `TROUBLESHOOTING.md` punya solusi: pakai hotspot HP, atau matiin isolation di setting router.
- **Windows Firewall untuk UDP** — beda rule dari TCP kemarin. Kalau perlu, tambahkan:
  ```
  netsh advfirewall firewall add rule name="LAN DROP UDP" dir=in action=allow protocol=UDP localport=41234
  ```
- **Lupa `setBroadcast(true)`** — penyebab paling umum broadcast "diam-diam gagal" tanpa error jelas.

## Yang BUKAN Scope Hari 2
- TCP handshake / transfer file → itu hari 3-4.
- UI buat nampilin list device → itu hari 5. Hari 2 cukup sampai endpoint JSON `/devices` aja.
