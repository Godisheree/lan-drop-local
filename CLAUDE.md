# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LAN DROP** is a peer-to-peer LAN file sharing app built with Node.js + Express. Users on the same WiFi share files browser-to-browser (mobile ↔ laptop). No cloud, no setup — both sides open the same URL.

## Stack

- **Runtime:** Node.js (CommonJS)
- **Server:** Express 5.x (static + REST API)
- **Frontend:** Vanilla JS, HTML, CSS (no frameworks)
- **File upload (browser→server):** multer 2.x
- **Discovery:** UDP broadcast (dgram) port 41234
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

## Architecture

### Server entry (`server/index.js`)
Express app serving `public/` statically. Mounts REST routes for discovery and transfer. Multer upload saves to `./uploads-temp/` (or `$LANDROP_UPLOAD_DIR` for Electron ASAR compat). On startup, gets LAN IPs filtering out VM/Docker/vEthernet/WARP adapters, then starts UDP discovery + TCP transfer server.

### Discovery (`server/discovery.js`)
UDP broadcast on port 41234. Sends JSON `announce` packet every 2s `{deviceId, deviceName, ip, port, transferPort}`. Listener populates `knownDevices` Map; entries expire after 10s no broadcast, cleaned every 3s.

### Transfer (`server/transfer.js`)
TCP protocol over `net` module on port 3001. Custom **length-prefixed frame protocol**: 4-byte big-endian uint32 length prefix + UTF-8 JSON payload. Key states tracked in `pendingRequests` (incoming), `outgoingRequests` (outgoing), `transferProgress` (current transfer) — all in-memory Maps.

**File streaming:** after accept, sender sends `{type: "file-start", fileName, fileSize}` frame then raw bytes. Receiver writes to `./downloads/`. Uses `readStream.pipe(socket, {end: false})` — receiver closes socket to confirm completion.

**Auto-save:** after write completes, moves file to platform folder. Windows → `D:\Downloads\Download - Lan Drop\` (falls back to `<home>\Downloads\Download - Lan Drop\`). Termux → `~/storage/pictures/|movies/|downloads/`. File classification by extension. Cross-filesystem `fs.rename()` fallback to copy+unlink.

**Auto-transcode:** formats that Android may not natively support (.mpeg, .mpg, .avi, .mkv, .webm, .mov, .3gp, .flv, .ts) → H.264 .mp4 via ffmpeg. Audio-only files with cover art → MP3 container remux. Requires ffmpeg installed (auto-detected from common Windows paths + PATH). Non-fatal: fallback to original file if ffmpeg unavailable or conversion fails.

### Platform (`server/platform.js`)
Detects Termux via `process.env.PREFIX` (more reliable than `os.platform()` on Android) and Windows via `process.platform === 'win32'`.

### Frontend (`public/`)
Single-page app: polls devices every 2.5s, polls pending requests every 2s, polls transfer progress every 800ms. **Upload flow:** drag file to device card (or file picker button) → upload via multer `/transfer/upload` → request `/transfer/request` → poll `/transfer/status/:id` until accepted → trigger `/transfer/send-file` → poll `/transfer/progress/:id`. Receiver polls `/transfer/pending`, shows modal on new request, accept/reject via `/transfer/respond`.

### Electron Wrapper (`main.js` + `preload.js`)
`main.js` requires Express server directly in the main process (not child process). Sets `LANDROP_UPLOAD_DIR` to `app.getPath('temp')/landrop-uploads/` before requiring server — critical for ASAR compatibility. `preload.js` is intentionally empty (UI communicates via HTTP fetch, same as browser). On close, `app.quit()` prevents orphan node.exe.

### Routing

| Endpoint | Method | Purpose |
|---|---|---|
| `/devices` | GET | List discovered peers |
| `/me` | GET | Own hostname |
| `/transfer/upload` | POST | Browser file upload via multer |
| `/transfer/request` | POST | Send transfer request (sender) |
| `/transfer/pending` | GET | Incoming requests (receiver) |
| `/transfer/respond` | POST | Accept/reject (receiver) |
| `/transfer/status/:id` | GET | Poll outgoing request status |
| `/transfer/send-file` | POST | Start streaming after accepted |
| `/transfer/progress/:id` | GET | Poll transfer progress (both sides) |

## Critical Implementation Details

- **Frame parser must be removed** from socket before raw streaming — `socket.removeListener('data', handler)` in both `startRawReceive` and `startFileSend`. A stuck parser corrupts the file stream.
- **`{ end: false }` in `readStream.pipe(socket)`** — sender must not close the socket after piping; receiver closes it to confirm completion.
- **Upload-then-send:** browser can't provide `filePath`, so frontend uploads to own server first via multer, then uses the returned server-side path for TCP streaming.
- **Cached ffmpeg detection:** `checkFfmpeg()` runs once, caches result in `_ffmpegPath` module variable (undefined=unchecked, false=not found, string=path).
- **Hardlink/symlink fallback:** multer saves files without extension, so transcoding creates temp link with correct extension before passing to ffmpeg.

## Common Issues

- **WiFi AP Isolation / Client Isolation** blocks LAN traffic — not a code bug. Troubleshooting at `picture/TROUBLESHOOTING.md`.
- **UDP port 41234** and **TCP port 3001** must be accessible on LAN (firewall rules).
