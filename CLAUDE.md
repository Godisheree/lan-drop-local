# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LAN DROP** is a peer-to-peer LAN file sharing app built with Node.js + Express. Users on the same WiFi can share files via browser (mobile-to-laptop, etc.). The project follows a 7-day roadmap documented in `picture/lan_drop_7day_roadmap.png` and `picture/text/Hari 1.txt`. Currently the project is scaffolded but all source files are empty stubs awaiting implementation.

## Tech Stack

- **Runtime:** Node.js (CommonJS)
- **Server:** Express 5.x
- **Frontend:** Vanilla JS, HTML, CSS (served statically)

## Running the App

```bash
node server/index.js
```

Server starts on port 3000 and logs local IP for cross-device access. Access via `http://localhost:3000` or `http://<local-ip>:3000` from other devices on the same LAN.

## Project Structure

```
lan-drop/
├── server/
│   ├── index.js       # Express entry point — start server, serve /public, listen on 0.0.0.0:3000
│   ├── discovery.js    # LAN device discovery (mDNS/SSDP or manual IP entry)
│   └── transfer.js     # File transfer logic (multipart upload, streaming download)
├── public/
│   ├── index.html      # Single-page app UI
│   ├── style.css       # Styles
│   └── client.js       # Client-side JS (WebSocket/fetch for transfers)
├── picture/            # Roadmap images and planning notes
├── package.json
└── CLAUDE.md
```

## Architecture

- **Server** (`server/`): Express 5 serves the SPA from `public/` and exposes transfer/discovery API endpoints. Must listen on `0.0.0.0` (not `127.0.0.1`) so other LAN devices can connect.
- **Discovery** (`server/discovery.js`): Responsible for finding other LAN DROP instances on the network (likely via UDP broadcast or mDNS).
- **Transfer** (`server/transfer.js`): Handles file upload (multipart) and download (streaming) endpoints.
- **Frontend** (`public/`): A single-page app that discovers peers, selects files, and shows transfer progress.
- All source files are currently empty stubs. The roadmap suggests building in order: server → discovery → transfer → UI.

## Key Implementation Notes

- Use `os.networkInterfaces()` to find the local LAN IP and display it on server start
- Bind to `0.0.0.0` so LAN peers can reach the server
- Express 5 has breaking changes from Express 4; check API compatibility
- Use BAHASA for native language
