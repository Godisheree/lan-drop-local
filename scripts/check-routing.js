#!/usr/bin/env node
/**
 * Regression check routing peer.
 *
 * Bug yang pernah terjadi: satu peer menyiarkan DUA alamat (LAN 192.168.x.x
 * dan Tailscale 100.x.x.x) lewat deviceId yang sama. Kalau alamatnya disimpan
 * di satu field, yang terakhir datang menimpa yang sebelumnya — IP peer
 * "berganti-ganti" tiap detik, dan kiriman bisa lewat jalur yang tidak
 *_expected (user pilih Tailscale, tapi terkirim lewat IP LAN).
 *
 * Sekarang alamat disimpan terpisah per jalur, dan frontend memilih jalurnya
 * sesuai link yang dipakai (`GET /devices?via=lan|tailscale`).
 *
 * Usage: node scripts/check-routing.js
 */
const dgram = require('dgram');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Port acak supaya tidak bentrok dengan server yang sedang jalan.
const DISCOVERY_PORT = 41000 + Math.floor(Math.random() * 1000);

process.env.DISCOVERY_PORT = String(DISCOVERY_PORT);
process.env.PORT = '0'; // tidak dipakai oleh test ini

const discovery = require(path.join(ROOT, 'server', 'discovery.js'));

let failures = 0;

function ok(label) {
  console.log(`  OK   ${label}`);
}

function fail(label, detail) {
  failures++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(`       ${detail}`);
}

function expectTrue(condition, label, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}

/**
 * Kirim paket announce ke listener discovery.
 */
function announce(payload) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const buffer = Buffer.from(JSON.stringify(payload));
    sock.send(buffer, DISCOVERY_PORT, '127.0.0.1', (err) => {
      sock.close();
      resolve(err ? null : true);
    });
  });
}

const PEER_ID = 'test-peer-1';

async function main() {
  console.log('\n[Routing] peer LAN + Tailscale');

  discovery.startDiscovery();
  // Beri waktu listener siap bind.
  await new Promise((r) => setTimeout(r, 500));

  // Peer yang sama, dua jalur.
  await announce({
    type: 'announce',
    deviceId: PEER_ID,
    deviceName: 'OPPO A38',
    ip: '192.168.1.3',
    port: 3000,
    transferPort: 3001,
    via: 'lan',
  });
  await announce({
    type: 'announce',
    deviceId: PEER_ID,
    deviceName: 'OPPO A38',
    ip: '100.100.131.65',
    port: 3000,
    transferPort: 3001,
    via: 'tailscale',
  });
  await new Promise((r) => setTimeout(r, 400));

  const lan = discovery.getDevices('lan');
  const ts = discovery.getDevices('tailscale');
  const defaultView = discovery.getDevices();

  expectTrue(lan.length === 1, 'peer terdaftar sekali (bukan dua)', `ditemukan ${lan.length}`);
  expectTrue(lan[0] && lan[0].ip === '192.168.1.3', 'jalur LAN memakai IP LAN',
    lan[0] ? `dapat ${lan[0].ip}` : 'tidak ada peer');
  expectTrue(ts[0] && ts[0].ip === '100.100.131.65', 'jalur Tailscale memakai IP Tailscale',
    ts[0] ? `dapat ${ts[0].ip}` : 'tidak ada peer');
  expectTrue(ts[0] && ts[0].via === 'tailscale', 'penanda via ikut sesuai jalur',
    ts[0] ? `dapat ${ts[0].via}` : 'tidak ada peer');
  expectTrue(lan[0] && lan[0].transferPort === 3001, 'transferPort ikut benar');
  expectTrue(defaultView[0] && defaultView[0].ip === '192.168.1.3', 'tanpa parameter → LAN');

  // Peer yang CUMA punya satu jalur harus tetap muncul di jalur lain
  // (fallback), supaya tidak hilang dari daftar.
  await announce({
    type: 'announce',
    deviceId: 'test-peer-2',
    deviceName: 'HP-Lama',
    ip: '100.100.9.9',
    port: 3000,
    transferPort: 3001,
    via: 'tailscale',
  });
  await new Promise((r) => setTimeout(r, 300));

  const lan2 = discovery.getDevices('lan');
  const fallback = lan2.find((d) => d.deviceName === 'HP-Lama');
  expectTrue(!!fallback, 'peer tanpa alamat LAN tetap muncul (fallback ke Tailscale)');
  expectTrue(fallback && fallback.ip === '100.100.9.9', 'fallback memakai IP yang ada',
    fallback ? `dapat ${fallback.ip}` : 'tidak ada');

  // ===== Kasus "localhost" (bug nyata) =====
  // Peer tanpa interface LAN pernah menyiarkan ip:'localhost'. Kalau itu
  // disimpan, kartu peer menampilkan localhost:3000 dan kiriman mendarat
  // di server pengirim sendiri.
  await announce({
    type: 'announce',
    deviceId: 'test-peer-3',
    deviceName: 'HP-Data-Seluler',
    ip: 'localhost',
    port: 3000,
    transferPort: 3001,
    via: 'lan',
  });
  await new Promise((r) => setTimeout(r, 300));

  const all = discovery.getDevices('lan');
  const hp = all.find((d) => d.deviceName === 'HP-Data-Seluler');
  expectTrue(!!hp, 'peer dengan ip localhost tetap terdaftar');
  expectTrue(hp && hp.ip !== 'localhost', 'alamat "localhost" TIDAK pernah jadi alamat peer',
    hp ? `dapat ${hp.ip}` : 'tidak ada peer');
  expectTrue(hp && hp.ip && hp.ip !== '0.0.0.0',
    'alamat peer tidak pernah kosong/unspecified', hp ? `dapat ${hp.ip}` : '');

  // Jalur "local" (aplikasi dibuka lewat localhost) → peer lewat Tailscale dulu.
  const localView = discovery.getDevices('local');
  const peerViaLocal = localView.find((d) => d.deviceName === 'OPPO A38');
  expectTrue(peerViaLocal && peerViaLocal.ip === '100.100.131.65',
    'jalur "local" pakai alamat Tailscale peer',
    peerViaLocal ? `dapat ${peerViaLocal.ip}` : 'tidak ada peer');

  discovery.stopDiscovery();

  console.log(
    failures === 0
      ? '\n✅ Routing peer konsisten.'
      : `\n❌ ${failures} pemeriksaan routing gagal.`
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
