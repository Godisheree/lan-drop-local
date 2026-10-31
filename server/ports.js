// Port aktif LAN DROP — satu sumber kebenaran, dimutasi saat bind berhasil.
//
// Dulu angka 3000 (HTTP) dan 3001 (transfer) ditulis ulang di index.js,
// transfer.js, discovery.js, main.js, dan tui.js. Begitu portnya bergeser
// karena sudah dipakai aplikasi lain, tiap salinan masih menunjuk angka lama:
// announce ke peer mengarahkan device lain ke port mati, dan jendela Electron
// memuat alamat kosong. Karena modul ini di-require (bukan disalin), pembaca
// selalu dapat angka terbaru.
//
// Angka awalnya dari env PORT / TRANSFER_PORT, sama seperti sebelumnya.
module.exports = {
  http: parseInt(process.env.PORT, 10) || 3000,
  transfer: parseInt(process.env.TRANSFER_PORT, 10) || 3001,
};
