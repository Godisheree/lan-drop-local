# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LAN DROP** is a peer-to-peer LAN file sharing app built with Node.js + Express. Users on the same WiFi share files browser-to-browser (mobile ↔ laptop). No cloud, no setup — both sides open the same URL.

Built across 7 days: server scaffolding → UDP discovery → TCP handshake → file streaming → UI → testing → Electron packaging. All day 1-5 code is implemented and proven end-to-end (laptop ↔ Android/Termux tested).

## Stack

- **Runtime:** Node.js (CommonJS)
- **Server:** Express 5.x (static + REST API)
- **Frontend:** Vanilla JS, HTML, CSS (no frameworks)
- **File upload (browser→server):** multer 2.x
- **Discovery:** UDP broadcast (dgram) port 41234
- **Transfer:** Raw TCP (net module) port 3001, custom length-prefixed frame protocol
- **Language:** UI in Bahasa Indonesia

## Running

```bash
npm install
node server/index.js
# => http://localhost:3000
# => http://<lan-ip>:3000  (for other LAN devices)
```

Single instance: `PORT=3000 TRANSFER_PORT=3001 node server/index.js`
Two instances locally for testing:
```bash
# Terminal 1
PORT=3000 TRANSFER_PORT=3001 node server/index.js
# Terminal 2
PORT=4000 TRANSFER_PORT=4001 node server/index.js
```

No test framework — all tests are manual flows documented in `picture/text/hari 4_SPEC.md` and `picture/text/hari 5_SPEC.md`.

## Architecture

### Server (`server/index.js`)
Express entry point. Serves `public/` statically, mounts discovery + transfer REST routes. Multer upload endpoint at `POST /transfer/upload` saves files to `./uploads-temp/`. On startup, finds LAN IPs via `os.networkInterfaces()` filtering out VM/Docker/vEthernet/WARP adapters. Initiates discovery broadcast + TCP transfer listener. Listens on `0.0.0.0:3000`.

### Discovery (`server/discovery.js`)
UDP broadcast on port 41234. Each device broadcasts a JSON `announce` packet every 2 seconds containing `{deviceId, deviceName, ip, port, transferPort}`. Listener populates a `knownDevices` Map; entries expire after 10s of no broadcast, cleaned every 3s. Exposes `GET /devices` via `getDevices()`.

### Transfer (`server/transfer.js`)
TCP-based transfer protocol over `net` module on port 3001. Custom **length-prefixed frame protocol**:

- **Frame format:** 4-byte big-endian uint32 length prefix + UTF-8 JSON payload
- `FrameParser` class: incremental buffer parser, handles partial reads
- `sendFramedMessage(socket, obj)`: serializes + writes framed message
- **Handshake:** sender opens TCP connection, sends `{type: "transfer-request", fileName, fileSize, senderName, senderId}`. Receiver responds `{type: "transfer-response", accepted: true/false}`.
- **Streaming (after accept):** frame parser is REMOVED from the socket, sender sends `{type: "file-start", fileName, fileSize}` frame then raw file bytes. Receiver writes to `./downloads/{filename}` tracking progress by byte count. Sender uses `readStream.pipe(socket, {end: false})` — receiver signals completion by closing the socket.
- **State:** `pendingRequests` (incoming), `outgoingRequests` (outgoing), `transferProgress` (current transfer state) — all in-memory Maps.

### Frontend (`public/`)
Single page app auto-updating device list (2.5s polling). **Upload flow:** drag file to device card → upload to own server via `/transfer/upload` (multer) → send request to target via `/transfer/request` → poll `/transfer/status/:id` until accepted → trigger `/transfer/send-file` → poll `/transfer/progress/:id`. Receiver side polls `/transfer/pending` (2s), shows modal on new request, accept/reject via `/transfer/respond`. Progress bars update every 800ms. File picker button (`<input type="file">`) as alternative to drag-and-drop, especially for mobile.

### Key Routing & Conventions

| Endpoint | Method | Purpose |
|---|---|---|
| `/devices` | GET | List discovered peers |
| `/me` | GET | Own hostname |
| `/transfer/pending` | GET | Incoming requests (receiver) |
| `/transfer/request` | POST | Send transfer request (sender) |
| `/transfer/respond` | POST | Accept/reject (receiver) |
| `/transfer/status/:id` | GET | Poll outgoing request status (sender) |
| `/transfer/send-file` | POST | Start streaming after accepted (sender) |
| `/transfer/progress/:id` | GET | Poll transfer progress (both sides) |
| `/transfer/upload` | POST | Browser file upload via multer (sender) |

## Important Implementation Notes

- **Frame parser must be removed** from socket before streaming raw bytes — `socket.removeListener('data', handler)` in `startRawReceive` and `startFileSend`. A stuck parser corrupts the file stream.
- **`{ end: false }` in `readStream.pipe(socket)`** — sender must not close the socket after piping finishes; receiver closes it to confirm completion.
- **Upload-then-send** (day 5): browser can't provide `filePath`, so frontend uploads to own server first via multer, then uses the server-side path for TCP streaming.
- **AP Isolation / Client Isolation** on WiFi routers blocks LAN traffic — not a code bug. Troubleshooting at `picture/TROUBLESHOOTING.md`.
- **UDP port 41234** and **TCP port 3001** must be accessible on the LAN (firewall rules).

## Common Development Tasks

```bash
# Install dependencies
npm install

# Run single instance (default ports 3000 / 3001)
node server/index.js

# Run two instances for local testing
# Terminal 1:
PORT=3000 TRANSFER_PORT=3001 node server/index.js
# Terminal 2:
PORT=4000 TRANSFER_PORT=4001 node server/index.js

# Manual test flow (after both instances running):
# 1. Upload file to sender:
curl -F "file=@test.txt" http://localhost:3000/transfer/upload

# 2. Send request:
curl -X POST http://localhost:3000/transfer/request \
  -H "Content-Type: application/json" \
  -d '{"targetIp":"localhost","targetPort":4001,"fileName":"test.txt","fileSize":100}'

# 3. Check pending on receiver:
curl http://localhost:4000/transfer/pending

# 4. Accept:
curl -X POST http://localhost:4000/transfer/respond \
  -H "Content-Type: application/json" \
  -d '{"requestId":"<id>","accept":true}'

# 5. Start file send:
curl -X POST http://localhost:3000/transfer/send-file \
  -H "Content-Type: application/json" \
  -d '{"requestId":"<id>","filePath":"D:/path/to/test.txt"}'

# 6. Poll progress:
curl http://localhost:3000/transfer/progress/<id>
```

## Roadmap & Specs

Day-by-day specs in `picture/text/`:
- `hari 2_SPEC.md` — UDP discovery
- `hari 3_SPEC.md` — TCP handshake
- `hari 4_SPEC.md` — File streaming + progress endpoint
- `hari 5_SPEC.md` — Web UI (drag-drop, upload flow, progress bars)
- `FEATURE_FILE_PICKER_SPEC.md` — File picker button for mobile ux

## Available Agent Types (`.claude/agents/`)

- `web-server` — Express setup, middleware, static serving, port config, LAN networking
- `auto-discovery` — UDP broadcast, mDNS/SSDP, manual peer discovery
- `core-transfer` — TCP streaming, multipart upload, progress tracking, frame protocol
- `Plan` — Multi-step implementation planning
- `Explore` — Read-only search for broad codebase exploration
