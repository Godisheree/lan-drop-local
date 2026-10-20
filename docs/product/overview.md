# Overview Produk

## Satu kalimat

LAN DROP mengirim file, foto, video, dan teks antar perangkat di **WiFi yang sama**
tanpa akun, tanpa cloud, tanpa aplikasi — cukup buka URL yang sama di browser.

## Masalah yang diselesaikan

Berpindah file dari HP ke laptop (atau sebaliknya) biasanya berarti salah satu dari:

- Kirim lewat WhatsApp/Telegram → terpotong, terkompresi, atau terkirim ke server orang.
- Pakai kabel USB → tapi HP harus support USB-C-to-A yang sering tidak ada di tas.
- Pakai email/kolibri → ribet, file besar kena limit.
- Pakai aplikasi desktop → harus install dua kali, dan harus ada di kedua perangkat.

MASALAHNYA SAMA: **tidak ada jalur yang cepat, private, dan bebas install.**

LAN DROP menjawab dengan URL. Kalau dua perangkat di WiFi yang sama, keduanya buka
`http://<ip-laptop>:3000`, dan file langsung jalan. Tidak ada pairing, tidak ada
login, tidak ada data yang keluar dari jaringan lokal.

## Pengguna

| Persona | Kebutuhan utama | Titik gesekan yang dipecah |
|---|---|---|
| **Pemilik HP** | Kirim foto/video ke laptop tanpa kabel | Ketik URL manual, tidak tahu file-nya nyampe ke mana |
| **Pemilik laptop** | Terima file dari HP | Tidak tahu perangkat mana yang aktif, tidak ada indikator progres |
| **Keluarga di satu meja** | Sharing file & tautan antar HP | Tiap orang harus hafal IP, teks hilang kalau tab tidak terbuka |
| **Developer** | Jadi alat demo/internal di jaringan kantor | Butuh tahu URL berapa yang benar untuk dibagikan |

## Nilai inti (yang harus dipertahankan)

1. **Nol setup.** Tidak ada akun, tidak ada install, tidak ada pairing.
2. **100% lokal.** Tidak ada data keluar dari LAN. Tidak ada telemetri, tidak ada CDN.
3. **Cukup cepat untuk dipakai harian, bukan sekadar demo.**
4. **Bisa dipakai dua arah** — laptop→HP dan HP→laptop, tanpa mode berbeda.

## Batasan yang disadari

- **Hanya** jalan di jaringan yang sama. WiFi publik dengan *AP isolation* tidak bisa — ini bukan bug.
- Protokol HTTP tanpa TLS → **jangan** dipakai di jaringan tidak tepercaya. Nama file & teks terenkripsi di transit, tidak.
- Tablet/Termux punya jalur simpan berbeda (Android shared storage) dan butuh izin storage.

## Metrik "berhasil" (qualitative, product-level)

- Pengguna baru bisa mengirim file pertama **tanpa bertanya ke siapa pun** (< 60 detik).
- Setelah transfer selesai, pengguna tahu **file-nya ada di mana** tanpa perlu membuka File Explorer.
- Kalau ada perangkat yang hilang, pengguna paham itu "perangkat mati" — bukan "app error".

## Istilah

| Istilah | Arti |
|---|---|
| Peer | Perangkat lain yang terlihat di jaringan |
| Batch | Satu kiriman berisi beberapa file (dibgrupkan lewat `batchId`) |
| Part file | File sementara `<nama>.landrop-part` selama transfer berjalan |
| Save dir | Folder tujuan file diterima (`D:\LAN-DROP\<kategori>` di Windows) |
