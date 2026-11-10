/**
 * Broadcaster harus ikut pindah saat interface LAN berubah.
 *
 * Kasus nyata: HP start LAN DROP di data seluler (rmnet0 10.14.19.195), lalu
 * masuk WiFi. Socket HTTP-nya hidup di wlan0 dan /me menampilkan alamat WiFi
 * yang benar, tapi broadcaster tetap menembak 10.255.255.255 — peer di WiFi
 * yang sama tidak pernah melihat HP itu. Skrip ini meniru perpindahan tersebut
 * dengan mengganti daftar interface, tanpa menyentuh jaringan asli.
 *
 * Jalankan: node scripts/check-discovery-rebind.js
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Port sendiri supaya tidak berebut listener dengan instance yang sedang jalan.
process.env.DISCOVERY_PORT = process.env.DISCOVERY_PORT || '41999';
process.env.LANDROP_PEERS = '';

const platform = require(path.join(ROOT, 'server', 'platform'));

let current = [
  { name: 'rmnet0', address: '10.14.19.195', netmask: '255.255.0.0', broadcast: '10.255.255.255' },
];
platform.listLANInterfaces = () => current;

const discovery = require(path.join(ROOT, 'server', 'discovery'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function expect(name, ok, detail) {
  if (ok) {
    console.log('OK   ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fails += 1;
    console.log('GAGAL ' + name + (detail ? ' — ' + detail : ''));
  }
}

(async () => {
  discovery.startDiscovery();
  await sleep(300);

  let d = discovery.getDiagnostics();
  expect('broadcaster awal ikut interface seluler', d.interfaces.length === 1 && d.interfaces[0].address === '10.14.19.195',
    JSON.stringify(d.interfaces.map((i) => i.address)));

  // HP masuk WiFi: interface seluler hilang, wlan0 muncul.
  current = [{ name: 'wlan0', address: '192.168.1.4', netmask: '255.255.255.0', broadcast: '192.168.1.255' }];
  await sleep(6000);

  d = discovery.getDiagnostics();
  expect('broadcaster pindah ke wlan0 tanpa restart', d.interfaces.length === 1 && d.interfaces[0].address === '192.168.1.4',
    JSON.stringify(d.interfaces.map((i) => i.address)));
  expect('alamat broadcast ikut alamat baru', d.interfaces[0] && d.interfaces[0].broadcast === '192.168.1.255',
    d.interfaces[0] && d.interfaces[0].broadcast);
  expect('broadcaster masih hidup (mengirim)', d.interfaces[0] && d.interfaces[0].bound === true);

  // WiFi hilang total (HP kembali ke data seluler): tidak boleh ada socket zombie.
  current = [];
  await sleep(6000);
  d = discovery.getDiagnostics();
  expect('tanpa interface LAN, broadcaster dikosongkan', d.interfaces.length === 0,
    JSON.stringify(d.interfaces.map((i) => i.address)));

  discovery.stopDiscovery();
  await sleep(200);

  if (fails) {
    console.log(`\n${fails} pemeriksaan GAGAL`);
    process.exit(1);
  }
  console.log('\nOK  Broadcaster mengikuti perubahan interface LAN.');
})();
