Oke, Hari 1 — fokusnya bukan nulis fitur, tapi nyiapin pondasi biar hari 2-7 lancar. Ini breakdown-nya:

## Tujuan akhir hari 1
Server Node.js nyala, bisa diakses lewat browser (`localhost:3000`), nampilin halaman kosong/placeholder. Belum ada logic networking sama sekali — itu baru mulai hari 2.

## Langkah-langkah

**1. Init project**
```bash
mkdir lan-drop && cd lan-drop
npm init -y
npm install express
```

**2. Struktur folder** — biar nggak berantakan pas nambah fitur tiap hari:
```
lan-drop/
├── server/
│   ├── index.js          # entry point, start Express
│   ├── discovery.js       # (kosong, diisi hari 2)
│   └── transfer.js        # (kosong, diisi hari 3-4)
├── public/
│   ├── index.html         # UI (diisi hari 5)
│   ├── style.css
│   └── client.js
├── package.json
└── .gitignore
```

**3. Server Express minimal** (`server/index.js`):
- Serve folder `public/` sebagai static files
- Listen di port tertentu (misal 3000)
- Tampilkan IP lokal device di console pas server start (ini penting buat hari 6 — supaya lo tau IP apa yang harus diketik di HP)

**4. Konsep yang perlu lo paham di sini** (karena masih dari nol):
- **`os.networkInterfaces()`** — fungsi built-in Node buat dapetin IP lokal device (misal `192.168.1.5`). Ini beda dari `localhost` — `localhost` cuma bisa diakses dari device yang sama, sedangkan IP lokal bisa diakses device lain di jaringan yang sama (HP lo nantinya).
- Kenapa server harus listen di `0.0.0.0` bukan cuma `127.0.0.1`, biar device lain di jaringan bisa connect.

**5. Test "selesai"**
- Jalankan `node server/index.js`
- Buka `http://localhost:3000` di laptop → muncul halaman placeholder
- Coba juga buka `http://<IP-laptop-lo>:3000` dari HP yang nyambung WiFi sama → kalau muncul juga, berarti pondasi lintas-device-nya udah jalan, padahal belum ada fitur transfer apapun

**6. Git init** (opsional tapi disaranin) — biar progress tiap hari ke-track, gampang rollback kalau ada yang rusak hari 3-4 nanti.

---