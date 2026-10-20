# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LAN DROP** is a peer-to-peer LAN file sharing app built with Node.js + Express. Users on the same WiFi share files browser-to-browser (mobile ↔ laptop). No cloud, no setup — both sides open the same URL.

## Stack

- **Runtime:** Node.js (CommonJS)
- **Server:** Express 5.x (static + REST API)
- **Frontend:** Vanilla JS (ES modules, no build step), HTML, CSS (no frameworks)
- **File upload (browser→server):** multer 2.x
- **Discovery:** UDP broadcast (dgram) port 41234 (override: `DISCOVERY_PORT`)
- **Transfer:** Raw TCP (net module) port 3001, custom length-prefixed frame protocol
- **UI language:** Bahasa Indonesia
- **Desktop packaging:** Electron + electron-builder (NSIS)

## Running

```bash
npm install
node server/index.js              # http://localhost:3000
PORT=4000 TRANSFER_PORT=4001 node server/index.js   # second instance for testing
npm run electron-dev               # desktop app via Electron
npm run build-win                  # build NSIS installer -> dist/*.exe
```

## Testing & QA

```bash
npm run check          # syntax check semua file JS (ESM-aware)
npm run audit          # deteksi karakter asing yang tidak disengaja
npm run smoke          # 3 viewport + cek error console (butuh server jalan)
npm run verify:qr      # decode QR dengan OpenCV, cocokkan dengan URL di UI
npm run e2e            # 2 instance, transfer file nyata dua arah
```

Detail tiap skrip ada di [docs/guides/qa-checklist.md](docs/guides/qa-checklist.md).

## Documentation

- [docs/README.md](docs/README.md) — peta dokumentasi
- [docs/product/overview.md](docs/product/overview.md) — produk & pengguna
- [docs/product/ux-principles.md](docs/product/ux-principles.md) — prinsip UI/UX yang mengikat
- [docs/adr/](docs/adr/) — Architecture Decision Records
- [docs/guides/frontend-architecture.md](docs/guides/frontend-architecture.md) — struktur frontend
- [docs/guides/qa-checklist.md](docs/guides/qa-checklist.md) — checklist rilis UI
- [CHANGELOG.md](CHANGELOG.md) — catatan perubahan per rilis
- [NOTES-OPERATOR.md](NOTES-OPERATOR.md) — permintaan berulang dari owner

**Aturan:** setiap perubahan UI menulis entri di CHANGELOG. Keputusan
arsitektur yang sulit dibalik ditulis sebagai ADR baru.

## Architecture

### Server entry (`server/index.js`)
Express app serving `public/` statically. Mounts REST routes for discovery and transfer. Multer upload saves to `./uploads-temp/` (or `$LANDROP_UPLOAD_DIR` for Electron ASAR compat). On startup, gets LAN IPs filtering out VM/Docker/vEthernet/WARP adapters, then starts UDP discovery + TCP transfer server.

### Discovery (`server/discovery.js`)
UDP broadcast on port 41234. Sends JSON `announce` packet every 2s `{deviceId, deviceName, ip, port, transferPort}`. Listener populates `knownDevices` Map; entries expire after 10s no broadcast, cleaned every 3s.

### Transfer (`server/transfer.js`)
TCP protocol over `net` module on port 3001. Custom **length-prefixed frame protocol**: 4-byte big-endian uint32 length prefix + UTF-8 JSON payload. Key states tracked in `pendingRequests` (incoming), `outgoingRequests` (outgoing), `transferProgress` (current transfer) — all in-memory Maps.

**File streaming:** after accept, sender sends `{type: "file-start", fileName, fileSize}` frame then raw bytes. Receiver streams **directly to the final save folder** (no intermediate `./downloads/`). Uses `readStream.pipe(socket, {end: false})` — receiver closes socket to confirm completion.

**Auto-save (direct streaming):** file is written as <name>.landrop-part in the target folder, then atomically renamed on completion - no cross-filesystem copy, no `EXDEV`. Targets: Windows → `D:\LAN-DROP` with subfolders by type (`Pictures`, `Videos`, `Documents`, `Music`; other file types go to the root; override everything with `\$LANDROP_SAVE_DIR\` = flat folder), Termux → Android shared storage (`~/storage/pictures|movies|music|downloads` (+ `shared/Documents` for docs)) - requires `termux-setup-storage` permission first. All Windows subfolders are pre-created at server startup (`ensureSaveDirExists()`); if the drive is unavailable, falls back to `\$LANDROP_DATA_DIR/downloads`. Files with colliding names get ` (1)`, ` (2)` suffix - never overwrite.

**Resume transfer:** resume key = `sha1(senderName|batchId|fileName|fileSize)` — stable across retries because the frontend reuses the same `batchId`. Receiver checks `parts/` meta in data dir; if a partial exists, `transfer-response` frame carries `resumeOffset`, and sender's read stream starts at that offset. On unexpected disconnect the partial file + meta are kept (retry via "Coba Lagi" button); on explicit cancel both are deleted. Partial/meta older than 7 days cleaned on startup (`cleanupStale()`), same for stale uploads.

**History (`server/history.js`):** completed/failed/cancelled transfers recorded to `history.json` in data dir (debounced atomic write, max 200 entries). Endpoints `GET /history`, `POST /history/clear`. Rendered in UI "Riwayat" panel.

**Data dir:** `%APPDATA%/lan-drop` (Windows) or `~/.lan-drop` (Termux/Linux), override with `$LANDROP_DATA_DIR`. Never write data inside the install dir — Program Files is read-only for non-admin users.

**Auto-transcode:** formats that Android may not natively support (.mpeg, .mpg, .avi, .mkv, .webm, .mov, .3gp, .flv, .ts) → H.264 .mp4 via ffmpeg. Audio-only files with cover art → MP3 container remux. Requires ffmpeg installed (auto-detected from common Windows paths + PATH). Non-fatal: fallback to original file if ffmpeg unavailable or conversion fails. Upload files are kept after a failed/interrupted transfer so resume can work; deleted only on completion or explicit cancel.

### Platform (`server/platform.js`)
Detects Termux via `process.env.PREFIX` (more reliable than `os.platform()` on Android) and Windows via `process.platform === 'win32'`.

### Frontend (`public/`)

Single-page app, **ES modules tanpa build step** (`<script type="module">`).
Struktur lengkap: [docs/guides/frontend-architecture.md](docs/guides/frontend-architecture.md).

- `public/js/core/` — `api.js` (fetch wrapper), `state.js` (store tunggal),
  `format.js` (format angka/waktu), `dom.js` (helper `el()`).
- `public/js/features/` — satu berkas per fitur: `devices`, `transfers`, `send`,
  `receive`, `text`, `history`, `connect` (panel Sambung/QR), `notify`, `theme`, `a11y`.
- `public/css/` — `tokens.css` (design token + dark mode), `base.css`,
  `components.css`, `views.css`.
- `public/js/vendor/qrcode.js` — MIT, vendored untuk QR offline (ADR-0002).

**Aturan penting:**
- **Jangan** membangun HTML dari string berisi data dinamis. Render via `el()`
  di `core/dom.js` — data peer (nama perangkat, IP) adalah input tak tepercaya.
- Semua warna dari `tokens.css`. Warna literal di luar file itu = dark mode rusak.
- Polling: devices 2,5s · pending 2s · texts 2s · history 5s · progress 800ms.
  Berhenti saat tab disembunyikan.

**Upload flow:** drag file ke device card (atau tombol file picker) → upload via
multer `/transfer/upload` (XHR, ada progres) → request `/transfer/request` → poll
`/transfer/status/:id` sampai accepted → trigger `/transfer/send-file` → poll
`/transfer/progress/:id`. Receiver polls `/transfer/pending`, shows modal on new
request, accept/reject via `/transfer/respond`.

**Panel Sambung:** `GET /me` mengembalikan `{ deviceName, urls[] }`. Frontend
merender QR di browser (tanpa CDN) supaya perangkat kedua tinggal scan.

### Electron Wrapper (`main.js` + `preload.js`)
`main.js` requires Express server directly in the main process (not child process). Sets `LANDROP_UPLOAD_DIR` to `app.getPath('temp')/landrop-uploads/` before requiring server — critical for ASAR compatibility. `preload.js` is intentionally empty (UI communicates via HTTP fetch, same as browser). On close, `app.quit()` prevents orphan node.exe.

### Routing

| Endpoint | Method | Purpose |
|---|---|---|
| `/devices` | GET | List discovered peers |
| `/me` | GET | Own hostname + LAN URLs (untuk panel Sambung/QR) |
| `/transfer/upload` | POST | Browser file upload via multer |
| `/transfer/request` | POST | Send transfer request (sender) |
| `/transfer/pending` | GET | Incoming requests (receiver) |
| `/transfer/respond` | POST | Accept/reject (receiver) |
| `/transfer/status/:id` | GET | Poll outgoing request status |
| `/transfer/send-file` | POST | Start streaming after accepted |
| `/transfer/progress/:id` | GET | Poll transfer progress (both sides) |
| `/history` | GET | Transfer history (newest first) |
| `/history/clear` | POST | Delete all history |

## Critical Implementation Details

- **Frame parser must be removed** from socket before raw streaming — `socket.removeListener('data', handler)` in both `startRawReceive` and `startFileSend`. A stuck parser corrupts the file stream.
- **`{ end: false }` in `readStream.pipe(socket)`** — sender must not close the socket after piping; receiver closes it to confirm completion.
- **Upload-then-send:** browser can't provide `filePath`, so frontend uploads to own server first via multer, then uses the returned server-side path for TCP streaming.
- **Cached ffmpeg detection:** `checkFfmpeg()` runs once, caches result in `_ffmpegPath` module variable (undefined=unchecked, false=not found, string=path).
- **Hardlink/symlink fallback:** multer saves files without extension, so transcoding creates temp link with correct extension before passing to ffmpeg.
- **requestId is per-side:** sender and receiver generate their own requestIds for the same transfer — never sync them across devices. Match incoming requests on the receiver via `batchId` + `fileName`.
- **`{ end: false }`** pipe + resume: on resume, sender pipes a partial read stream (`{start: offset}`) of the full-size file; receiver appends to `.landrop-part` at the same offset.
- **Progress 404 is transient, not fatal.** Entri `transferProgress` baru dibuat saat frame `file-start` tiba. Di sisi penerima ada jendela antara "diterima" dan "file mulai mengalir" yang progresnya belum ada. Frontend membedakan lewat `state.sawProgress`: 404 sebelum progres pernah terlihat = tunggu; 404 sesudahnya = transfer benar-benar hilang.
- **Discovery port bisa diubah** lewat `DISCOVERY_PORT` (default 41234), dan peer bisa didaftarkan manual lewat `LANDROP_PEERS` (format `Nama@ip:port@transferPort` dipisah koma). Dipakai untuk uji dua instance di satu host, dan untuk jaringan yang memblokir UDP broadcast.

## Common Issues

- **WiFi AP Isolation / Client Isolation** blocks LAN traffic — not a code bug. Troubleshooting at `picture/TROUBLESHOOTING.md`.
- **UDP port 41234** and **TCP port 3001** must be accessible on LAN (firewall rules).
