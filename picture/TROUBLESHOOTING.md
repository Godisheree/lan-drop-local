# Troubleshooting — LAN Drop

Catatan masalah yang udah ketemu selama development, biar nggak ngulang debug yang sama.

---

## 1. Device lain (HP) nggak bisa akses server, padahal localhost normal

**Gejala:**
- `http://localhost:3000` di laptop → jalan normal
- `http://<IP-laptop>:3000` dari HP (WiFi sama) → gagal connect / timeout
- Firewall udah di-allow, server udah listen di `0.0.0.0`, tapi tetap gagal

**Kemungkinan #1 — Windows Firewall block port**
Cek apakah port belum di-allow:

# sudah di allow

netsh advfirewall firewall add rule name="LAN DROP" dir=in action=allow protocol=TCP localport=3000 

Atau lewat GUI: Windows Security → Firewall → Allow an app → tambahin `node.exe`.

**Kemungkinan #2 — AP Isolation / Client Isolation di router**
Ini setting di **router**, bukan di laptop/HP/kode. Tujuannya mencegah device-device di WiFi yang sama saling ngomong (alasan security). Sering default ON di WiFi publik, kos-kosan, atau router ISP tertentu.

Cara konfirmasi — ping dari laptop ke IP HP:
```
ping 172.16.0.x   # ganti dengan IP HP
```
- **Request timeout** → confirmed ini client isolation, bukan bug kode.
- **Reply normal** tapi browser tetap gagal connect → bukan ini masalahnya, cek ulang firewall/port.

**Solusi:**
1. **Tercepat:** laptop connect ke hotspot HP (bukan WiFi rumah). Laptop & HP jadi di jaringan yang sama tanpa lewat router rumah. Sekaligus simulasi kondisi real kalau LAN Drop dipakai di luar rumah tanpa akses ke router.
2. **Kalau mau tetap pakai WiFi rumah:** masuk setting router (`192.168.0.1` atau `192.168.1.1`), cari opsi "AP Isolation" / "Client Isolation" / "Wireless Isolation" / "Access Point Isolation" → matikan.

**Catatan penting:** Ini **bukan bug LAN Drop** — ini limitasi jaringan di luar kontrol aplikasi. Perlu dimasukin ke troubleshooting guide untuk end user juga, karena user yang transfer gagal di WiFi publik/kos kemungkinan besar kena ini.

---

<!-- Tambahin masalah baru di bawah sini dengan format yang sama -->