# Prinsip UI/UX LAN DROP

Prinsip ini mengikat semua perubahan antarmuka. Setiap PR UI harus bisa dikembalikan
ke prinsip ini kalau ada perdebatan.

## 1. Gawai dulu, desktop menyusul — dan sebaliknya

Sebagian besar transfer terjadi di HP, tapi banyak yang berpasangan dengan laptop. Aturan konsekuensi:

- **Target sentuh minimal 44×44 px** di semua kontrol interaktif.
- **Tidak ada fitur yang hanya bisa desktop** (drag-drop) tanpa padanan mobile yang setara
  (tombol pilih file). Hint drag-drop **dihidden** di perangkat sentuh, bukan ditampilkan
  sebagai saran yang tak bisa diikuti.
- **Layout mobile boleh berbeda secara struktur** (tab), bukan cuma susun ulang.

## 2. Status selalu bisa dibaca tanpa bijaksana

> "Kalau pengguna harus berpikir untuk tahu apa yang terjadi, itu keliru."

Setiap state punya **label teks + warna + bentuk**, tidak warna saja (buta warna).
Contoh: kartu device punya titik hijau (online) + teks status; progress punya angka
persen, **bukan** cuma bar.

## 3. Kehilangan konteks lebih buruk daripada verbose

- Penerima wajib tahu **file disimpan di folder mana** — tanpa itu, "✅ Selesai" tidak
  berarti apa-apa secara praktis.
- Transfer gagal harus menyebut **penyebab** dan **jalan keluar**, bukan "Gagal".
- Timeout harus menjelaskan: "Penerima tidak merespons dalam 60 detik" — bukan spinner
  yang berputar selamanya.

## 4. Kontrol kecil harus terasa besar

Target sentuh, kontras, dan state fokus adalah **infrastruktur**, bukan polish. Semua
tombol ikon-only wajib punya `aria-label`. Semua status dinamis wajib punya live region.

## 5. Jangan pernah menyalahartikan

Teks dan atribut HTML **tidak boleh** dibangun dari string mentah data jaringan. Data
dari peer (nama perangkat, IP) adalah input yang tidak tepercaya.

## 6. Ringkas, tapi tidak boleh menyembunyikan

Riwayat boleh di-collapse, transfer aktif tidak boleh hilang. Transfer aktif selalu
tersedia di layar (sticky bar di mobile).

## 7. Gelap dan terang adalah dua wajah yang sama

Semua warna berasal dari token. Dark mode bukan "nanti kalau ada waktu" — token
didefinisikan dua wajah sejak awal.

## 8. Aksesibilitas bukan checklist akhir

If a UI change would fail WCAG 2.2 AA, it does not ship. Uji keyboard + reader,
bukan hanya "kelihatan oke".

## Arah bahasa & istilah

- Bahasa Indonesia, casual tapi presisi. "Coba Lagi", "Batal", "Tersimpan ke …".
- Emoji dipakai sebagai ikon affordance, selalu **disuayati label teks** — emoji
  sendirian tidak boleh jadi satu-satunya penanda aksi.
- Angka & ukuran file selalu pakai format yang manusiawi (`12,4 MB`, bukan `12403200`).
