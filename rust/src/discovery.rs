//! Discovery UDP — padanan `server/discovery.js`.
//!
//! Dua jalur dipakai untuk saling menemukan:
//!   1. Broadcast per interface LAN (192.168.x.255), tiap 2 detik.
//!   2. Peer statis dari env `LANDROP_PEERS`, untuk jaringan yang memblokir
//!      broadcast dan untuk pengujian dua instance di satu host.
//!
//! Aturan anti-pengambilalihan sama dengan Node: alamat peer diambil dari
//! ALAMAT SUMBER paket, bukan dari field `ip` di payload. Selama peer masih
//! hidup, announce dari alamat lain dengan deviceId yang sama ditolak — satu
//! paket palsu tidak boleh memindahkan kartu perangkat ke alamat penyerang.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use crate::platform;
use crate::ports::Ports;
use crate::state::now_ms;

const BROADCAST_INTERVAL: Duration = Duration::from_secs(2);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(5);
const DEVICE_TIMEOUT_MS: u128 = 10_000;
const CLEANUP_INTERVAL: Duration = Duration::from_secs(3);
const REJECT_LOG_TTL_MS: u128 = 60_000;

/// Bind UDP dengan SO_REUSEADDR, seperti `reuseAddr: true` di Node.
///
/// Paket broadcast dikirim ke semua socket yang memegang port itu, jadi dua
/// instance di satu mesin sama-sama mendengar announce. Tanpa ini instance
/// kedua gagal bind dan kehilangan discovery seluruhnya.
fn bind_shared(addr: SocketAddr) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    sock.set_nonblocking(true)?;
    sock.bind(&addr.into())?;
    UdpSocket::from_std(sock.into())
}

#[derive(Clone, Debug)]
pub struct Address {
    pub ip: String,
    pub port: u16,
    pub transfer_port: u16,
    pub source: String,
}

/// Batas atas peer yang disimpan. `/devices` mengirim seluruh isinya ke
/// dashboard, jadi jumlah entri ikut menentukan biaya render.
const MAX_PEERS: usize = 256;
/// Batas per alamat sumber: satu mesin tidak boleh memenuhi daftar sendirian.
const MAX_PEERS_PER_SOURCE: usize = 32;

#[derive(Clone, Debug)]
pub struct Peer {
    pub device_name: String,
    pub lan: Option<Address>,
    pub tailscale: Option<Address>,
    pub last_seen: u128,
    pub is_static: bool,
}

struct Broadcaster {
    address: String,
    broadcast: String,
    bound: bool,
    last_sent_at: u128,
    last_error: Option<String>,
    handle: JoinHandle<()>,
}

pub struct Discovery {
    pub device_id: String,
    pub device_name: String,
    pub ports: Arc<Ports>,
    pub discovery_port: u16,

    peers: Mutex<HashMap<String, Peer>>,
    broadcasters: Mutex<Vec<Broadcaster>>,
    listener_bound: AtomicBool,
    listener_error: Mutex<Option<String>>,
    last_announce_at: AtomicU64,
    rejected: Mutex<HashMap<String, u128>>,
}

fn normalize_address(address: &str) -> String {
    let value = address.trim();
    match value.strip_prefix("::ffff:") {
        Some(rest) => rest.split('%').next().unwrap_or(rest).to_string(),
        None => value.split('%').next().unwrap_or(value).to_string(),
    }
}

fn is_loopback_address(address: &str) -> bool {
    let value = normalize_address(address).to_ascii_lowercase();
    value == "::1" || value == "::" || value == "127.0.0.1" || value.starts_with("127.")
}

fn to_port(value: &Value) -> Option<u16> {
    let n = value.as_u64()?;
    if (1..=65535).contains(&n) {
        Some(n as u16)
    } else {
        None
    }
}

fn sanitize_peer_name(value: &Value) -> String {
    let text: String = value
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        "Perangkat".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

impl Discovery {
    pub fn new(
        device_id: String,
        device_name: String,
        ports: Arc<Ports>,
        discovery_port: u16,
    ) -> Discovery {
        Discovery {
            device_id,
            device_name,
            ports,
            discovery_port,
            peers: Mutex::new(HashMap::new()),
            broadcasters: Mutex::new(Vec::new()),
            listener_bound: AtomicBool::new(false),
            listener_error: Mutex::new(None),
            last_announce_at: AtomicU64::new(0),
            rejected: Mutex::new(HashMap::new()),
        }
    }

    fn announce_payload(&self) -> Vec<u8> {
        let ip = platform::lan_interfaces()
            .first()
            .map(|(_, ip, _)| ip.clone())
            .unwrap_or_else(|| "127.0.0.1".to_string());
        serde_json::to_vec(&json!({
            "type": "announce",
            "deviceId": self.device_id,
            "deviceName": self.device_name,
            "ip": ip,
            "port": self.ports.http(),
            "transferPort": self.ports.transfer(),
        }))
        .unwrap_or_default()
    }

    /// Daftarkan peer statis dari `LANDROP_PEERS`:
    /// `Nama@ip:port@transferPort,Nama2@ip:port@transferPort`.
    pub fn seed_static_peers(&self) {
        let Ok(raw) = std::env::var("LANDROP_PEERS") else {
            return;
        };
        for entry in raw.split(',') {
            let trimmed = entry.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parts: Vec<&str> = trimmed.split('@').collect();
            let (Some(name), Some(addr)) = (parts.first(), parts.get(1)) else {
                continue;
            };
            if name.is_empty() || addr.is_empty() {
                continue;
            }
            let Some(colon) = addr.rfind(':') else {
                continue;
            };
            let ip = &addr[..colon];
            if ip.is_empty() {
                continue;
            }
            let port = addr[colon + 1..].parse::<u16>().unwrap_or(3000);
            let transfer_port = parts
                .get(2)
                .and_then(|v| v.parse::<u16>().ok())
                .unwrap_or(port + 1);
            let id = format!("static-{ip}-{port}");
            let peer = Peer {
                device_name: name.to_string(),
                lan: Some(Address {
                    ip: ip.to_string(),
                    port,
                    transfer_port,
                    source: ip.to_string(),
                }),
                tailscale: None,
                last_seen: now_ms(),
                is_static: true,
            };
            if let Ok(mut peers) = self.peers.lock() {
                peers.insert(id, peer);
            }
            println!(
                "[Discovery] Peer statis terdaftar: {name} ({ip}:{port}, transfer {transfer_port})"
            );
        }
    }

    pub fn start(self: &Arc<Self>) {
        self.start_listener();
        self.start_supervisor();
        self.start_cleanup();
        self.seed_static_peers();
    }

    fn start_listener(self: &Arc<Self>) {
        let this = self.clone();
        let port = self.discovery_port;
        tokio::spawn(async move {
            let bind = SocketAddr::from(([0, 0, 0, 0], port));
            // SO_REUSEADDR seperti `server/discovery.js` (reuseAddr: true).
            // Tanpa ini instance kedua di mesin yang sama gagal bind dan
            // kehilangan discovery sama sekali — padahal dua instance di satu
            // mesin justru kasus paling sering saat mengembangkan.
            let socket = match bind_shared(bind) {
                Ok(s) => s,
                Err(err) => {
                    if let Ok(mut guard) = this.listener_error.lock() {
                        *guard = Some(format!("{err}"));
                    }
                    println!(
                        "[Discovery] Port {port} is already used by another instance — discovery listener SKIPPED. \
                         Peers are only found through LANDROP_PEERS."
                    );
                    return;
                }
            };
            this.listener_bound.store(true, Ordering::SeqCst);
            println!("[Discovery] Listening for peers on port {port}");

            let mut buf = vec![0u8; 4096];
            loop {
                let Ok((len, from)) = socket.recv_from(&mut buf).await else {
                    continue;
                };
                this.handle_packet(&buf[..len], &from).await;
            }
        });
    }

    async fn handle_packet(self: &Arc<Self>, data: &[u8], from: &SocketAddr) {
        let Ok(msg) = serde_json::from_slice::<Value>(data) else {
            return;
        };
        if msg.get("type").and_then(|v| v.as_str()) != Some("announce") {
            return;
        }
        if msg.get("deviceId").and_then(|v| v.as_str()) == Some(self.device_id.as_str()) {
            return;
        }

        let source = normalize_address(&from.ip().to_string());
        let payload_via = match msg.get("via").and_then(|v| v.as_str()) {
            Some("tailscale") => "tailscale",
            _ => "lan",
        };
        let via = if platform::is_tailscale_ipv4(&source) {
            "tailscale"
        } else if is_loopback_address(&source) {
            payload_via
        } else {
            "lan"
        };

        // Alamat peer = alamat sumber paket. Satu-satunya pengecualian:
        // loopback (dua instance di satu host), di situ alamat sumber tidak
        // berarti apa-apa sehingga `ip` dari payload dipakai.
        let payload_ip = msg.get("ip").and_then(|v| v.as_str()).unwrap_or("");
        let ip = if is_loopback_address(&source)
            && !payload_ip.is_empty()
            && payload_ip != "localhost"
        {
            payload_ip.to_string()
        } else {
            source.clone()
        };

        let Some(http_port) = msg.get("port").and_then(to_port) else {
            return;
        };
        let Some(transfer_port) = msg.get("transferPort").and_then(to_port) else {
            return;
        };

        let device_id = msg
            .get("deviceId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let device_name = sanitize_peer_name(msg.get("deviceName").unwrap_or(&Value::Null));

        if self.upsert_peer(
            &device_id,
            &device_name,
            &ip,
            http_port,
            transfer_port,
            via,
            &source,
        ) {
            self.last_announce_at
                .store(now_ms().min(u64::MAX as u128) as u64, Ordering::SeqCst);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_peer(
        &self,
        device_id: &str,
        device_name: &str,
        ip: &str,
        port: u16,
        transfer_port: u16,
        via: &str,
        source: &str,
    ) -> bool {
        if device_id.is_empty() {
            return false;
        }
        let now = now_ms();
        let source = normalize_address(source);

        let mut peers = match self.peers.lock() {
            Ok(p) => p,
            Err(_) => return false,
        };
        // Satu host di LAN bisa mengirim announce dengan deviceId acak ribuan
        // per detik; entri baru hidup 10 detik, jadi tanpa batas `/devices`
        // membengkak puluhan ribu dan respons dashboard ikut membengkak.
        if !peers.contains_key(device_id) {
            if peers.len() >= MAX_PEERS {
                return false;
            }
            let from_source = peers
                .values()
                .filter(|peer| {
                    peer.lan.as_ref().is_some_and(|a| a.source == source)
                        || peer.tailscale.as_ref().is_some_and(|a| a.source == source)
                })
                .count();
            if from_source >= MAX_PEERS_PER_SOURCE {
                return false;
            }
        }
        let entry = peers.entry(device_id.to_string()).or_insert_with(|| Peer {
            device_name: device_name.to_string(),
            lan: None,
            tailscale: None,
            last_seen: now,
            is_static: false,
        });
        if !device_name.is_empty() {
            entry.device_name = device_name.to_string();
        }

        let current = if via == "tailscale" {
            entry.tailscale.clone()
        } else {
            entry.lan.clone()
        };
        if let Some(current) = current {
            if !current.source.is_empty()
                && current.source != source
                && now.saturating_sub(entry.last_seen) < DEVICE_TIMEOUT_MS
            {
                let key = format!(
                    "{device_id}|{}",
                    if via == "tailscale" {
                        "tailscale"
                    } else {
                        "lan"
                    }
                );
                let should_log = match self.rejected.lock() {
                    Ok(mut rejected) => match rejected.get(&key) {
                        Some(last) if now.saturating_sub(*last) < REJECT_LOG_TTL_MS => false,
                        _ => {
                            rejected.insert(key, now);
                            true
                        }
                    },
                    Err(_) => false,
                };
                if should_log {
                    println!(
                        "[Discovery] Announce for \"{}\" from {} ignored — that device is still active at {}. \
                         If it really moved, wait a few seconds for the lease to expire.",
                        entry.device_name, source, current.source
                    );
                }
                return false;
            }
        }

        let address = Address {
            ip: ip.to_string(),
            port,
            transfer_port,
            source,
        };
        if via == "tailscale" {
            entry.tailscale = Some(address);
        } else {
            entry.lan = Some(address);
        }
        entry.last_seen = now;
        true
    }

    fn start_supervisor(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                this.sync_broadcasters();
                tokio::time::sleep(RECONCILE_INTERVAL).await;
            }
        });
    }

    /// Samakan broadcaster dengan interface yang benar-benar ada SEKARANG.
    ///
    /// Tanpa ini socket tetap menempel di alamat lama: HP yang pindah dari
    /// data seluler ke Wi-Fi terus menyiarkan ke alamat yang sudah mati.
    fn sync_broadcasters(self: &Arc<Self>) {
        let wanted = platform::lan_interfaces();
        let wanted_key: Vec<String> = {
            let mut v: Vec<String> = wanted.iter().map(|(_, ip, _)| ip.clone()).collect();
            v.sort();
            v
        };

        let mut keep: Vec<Broadcaster> = Vec::new();
        let mut existing: Vec<Broadcaster> = match self.broadcasters.lock() {
            Ok(mut guard) => guard.drain(..).collect(),
            Err(_) => Vec::new(),
        };
        for b in existing.drain(..) {
            if wanted_key.contains(&b.address) {
                keep.push(b);
            } else {
                b.handle.abort();
            }
        }

        for (_, ip, broadcast) in wanted {
            if keep.iter().any(|b| b.address == ip) {
                continue;
            }
            let payload = self.announce_payload();
            let target = format!("{broadcast}:{}", self.discovery_port);
            let bind = format!("{ip}:0");
            let this = self.clone();
            let address = ip.clone();
            let broadcast_copy = broadcast.clone();
            let handle = tokio::spawn(async move {
                let socket = match UdpSocket::bind(&bind).await {
                    Ok(s) => s,
                    Err(err) => {
                        eprintln!("[Discovery] Broadcaster bind {bind} failed: {err}");
                        return;
                    }
                };
                if socket.set_broadcast(true).is_err() {
                    eprintln!("[Discovery] set_broadcast gagal di {bind}");
                }
                println!(
                    "[Discovery] Broadcasting as \"{}\" ({}) → {target}",
                    this.device_name, this.device_id
                );
                let _ = &address;
                let mut last_error: Option<String> = None;
                loop {
                    this.mark_sent(&address, last_error.clone());
                    match socket.send_to(&payload, &target).await {
                        Ok(_) => last_error = None,
                        Err(err) => {
                            let code = err.to_string();
                            if last_error.as_deref() != Some(code.as_str()) {
                                eprintln!("[Discovery] Broadcast to {target} failed: {code}");
                            }
                            last_error = Some(code);
                        }
                    }
                    tokio::time::sleep(BROADCAST_INTERVAL).await;
                }
            });
            keep.push(Broadcaster {
                address: ip,
                broadcast: broadcast_copy,
                bound: true,
                last_sent_at: 0,
                last_error: None,
                handle,
            });
        }

        if let Ok(mut guard) = self.broadcasters.lock() {
            *guard = keep;
        }
    }

    fn mark_sent(&self, address: &str, last_error: Option<String>) {
        let now = now_ms();
        if let Ok(mut guard) = self.broadcasters.lock() {
            if let Some(b) = guard.iter_mut().find(|b| b.address == address) {
                b.last_sent_at = now;
                b.last_error = last_error;
            }
        }
    }

    fn start_cleanup(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(CLEANUP_INTERVAL).await;
                let now = now_ms();
                let mut expired: Vec<String> = Vec::new();
                if let Ok(mut peers) = this.peers.lock() {
                    peers.retain(|id, peer| {
                        if peer.is_static {
                            return true;
                        }
                        if now.saturating_sub(peer.last_seen) > DEVICE_TIMEOUT_MS {
                            expired.push(format!("{} ({id})", peer.device_name));
                            return false;
                        }
                        true
                    });
                }
                for name in expired {
                    println!("[Discovery] Device offline: {name}");
                }
            }
        });
    }

    /// Semua alamat yang diumumkan peer dengan nama tertentu.
    pub fn known_ips_for_name(&self, name: &str) -> Vec<String> {
        let wanted = name.trim();
        if wanted.is_empty() {
            return Vec::new();
        }
        let Ok(peers) = self.peers.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for peer in peers.values() {
            if peer.device_name != wanted {
                continue;
            }
            if let Some(a) = &peer.lan {
                out.push(a.ip.clone());
            }
            if let Some(a) = &peer.tailscale {
                out.push(a.ip.clone());
            }
        }
        out
    }

    /// Apakah alamat ini milik peer yang sedang terlihat lewat discovery?
    pub fn is_known_peer_address(&self, ip: &str) -> bool {
        let want = normalize_address(ip);
        if want.is_empty() {
            return false;
        }
        if is_loopback_address(&want) {
            return true;
        }
        let Ok(peers) = self.peers.lock() else {
            return false;
        };
        peers.values().any(|peer| {
            [peer.lan.as_ref(), peer.tailscale.as_ref()]
                .into_iter()
                .flatten()
                .any(|a| normalize_address(&a.ip) == want)
        })
    }

    /// Daftar peer untuk `/devices`.
    pub fn devices(&self, prefer_via: Option<&str>) -> Vec<Value> {
        let order: [&str; 2] = match prefer_via {
            Some("tailscale") | Some("local") => ["tailscale", "lan"],
            _ => ["lan", "tailscale"],
        };

        let Ok(peers) = self.peers.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for peer in peers.values() {
            for (idx, bucket) in order.iter().enumerate() {
                let addr = if *bucket == "tailscale" {
                    peer.tailscale.as_ref()
                } else {
                    peer.lan.as_ref()
                };
                let Some(addr) = addr else { continue };
                out.push(json!({
                    "deviceName": peer.device_name,
                    "ip": addr.ip,
                    "port": addr.port,
                    "transferPort": addr.transfer_port,
                    "via": bucket,
                    "fallback": idx != 0,
                    "lastSeen": peer.last_seen,
                }));
                break;
            }
        }
        out
    }

    pub fn diagnostics(&self) -> Value {
        let interfaces: Vec<Value> = match self.broadcasters.lock() {
            Ok(list) => list
                .iter()
                .map(|b| {
                    json!({
                        "address": b.address,
                        "broadcast": b.broadcast,
                        "bound": b.bound,
                        "lastSentAt": b.last_sent_at,
                        "lastError": b.last_error,
                    })
                })
                .collect(),
            Err(_) => Vec::new(),
        };

        let peer_count = self.peers.lock().map(|p| p.len()).unwrap_or(0);
        let listener_bound = self.listener_bound.load(Ordering::SeqCst);
        let listener_error = self.listener_error.lock().ok().and_then(|e| e.clone());
        let ready = interfaces
            .iter()
            .any(|i| i["bound"].as_bool() == Some(true) && i["lastError"].is_null())
            && (listener_bound || peer_count > 0);

        let self_tailscale = platform::own_addresses()
            .into_iter()
            .find(|a| platform::is_tailscale_ipv4(a));

        json!({
            "ready": ready,
            "interfaces": interfaces,
            "listener": {
                "port": self.discovery_port,
                "bound": listener_bound,
                "error": listener_error,
            },
            "peers": {
                "count": peer_count,
                "lastAnnounceAt": self.last_announce_at.load(Ordering::SeqCst),
            },
            "tailscale": {
                "selfIp": self_tailscale,
                "cliFound": false,
                "peerCount": 0,
            },
        })
    }
}
