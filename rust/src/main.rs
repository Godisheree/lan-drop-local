//! Inti LAN DROP versi Rust — server lengkap, bukan potongan.
//!
//! Status port: lihat `docs/adr/0013-port-inti-ke-rust.md` dan
//! `docs/prd-port-rust.md`. Yang diport di sini adalah seluruh inti Node:
//! HTTP + gerbang akses, discovery UDP, transfer TCP, riwayat, PIN dashboard,
//! dan thumbnail. Frontend di `public/` dipakai apa adanya tanpa build step.
//!
//! Kontrak yang dipertahankan (diuji `scripts/check-parity.js`):
//!   * frame TCP: 4 byte panjang big-endian + JSON UTF-8
//!   * announce UDP: `{type:"announce", deviceId, deviceName, ip, port, transferPort}`
//!   * kunci resume: sha1(`senderId|resumeId|fileName|fileSize`) → 16 hex
//!   * cookie `landrop_key`, header `X-Landrop-Key`, `?k=` → cookie + redirect

mod access;
mod discovery;
mod ffmpeg;
mod history;
mod httpapi;
mod logbus;
mod pin;
mod platform;
mod ports;
mod protocol;
mod repo;
mod security;
mod settings;
mod state;
mod thumbnail;
mod transfer;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware;
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;

use crate::discovery::Discovery;
use crate::history::History;
use crate::logbus::LogBus;
use crate::pin::Pin;
use crate::ports::Ports;
use crate::settings::Settings;
use crate::state::AppState;
use crate::thumbnail::Thumbnails;
use crate::transfer::Transfers;

const MAX_PORT_TRIES: u16 = 10;

fn env_port(name: &str, fallback: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(fallback)
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(httpapi::static_fallback))
        .route("/manifest.webmanifest", get(httpapi::manifest))
        .route("/sw.js", get(httpapi::service_worker))
        .route("/dashboard", get(httpapi::dashboard))
        .route("/dashboard.html", get(httpapi::dashboard_legacy))
        .route("/dashboard/pin-info", get(httpapi::pin_info))
        .route("/dashboard/login", post(httpapi::dashboard_login))
        .route("/dashboard/logout", post(httpapi::dashboard_logout))
        .route("/dashboard/pin", post(httpapi::dashboard_set_pin))
        .route("/me", get(httpapi::me))
        .route("/status", get(httpapi::status))
        .route("/logs", get(httpapi::logs))
        .route("/devices", get(httpapi::devices))
        .route("/discovery/status", get(httpapi::discovery_status))
        .route("/transfer/active", get(httpapi::transfer_active))
        .route("/transfer/request", post(httpapi::transfer_request))
        .route("/transfer/request-text", post(httpapi::transfer_request_text))
        .route("/transfer/pending", get(httpapi::transfer_pending))
        .route("/transfer/respond", post(httpapi::transfer_respond))
        .route("/transfer/status/{request_id}", get(httpapi::transfer_status))
        .route("/transfer/cancel/{request_id}", post(httpapi::transfer_cancel))
        .route("/transfer/send-text", post(httpapi::transfer_send_text))
        .route("/transfer/send-file", post(httpapi::transfer_send_file))
        .route("/transfer/text", get(httpapi::transfer_text_list))
        .route("/transfer/text/{id}/ack", post(httpapi::transfer_text_ack))
        .route("/transfer/progress/{request_id}", get(httpapi::transfer_progress))
        .route("/transfer/upload", post(httpapi::transfer_upload))
        .route("/thumbnail/{id}", get(httpapi::thumbnail))
        .route("/system/disk", get(httpapi::system_disk))
        .route("/settings/auto-approve", get(httpapi::auto_approve_get).post(httpapi::auto_approve_set))
        .route("/history", get(httpapi::history_list))
        .route("/history/clear", post(httpapi::history_clear))
        .fallback(get(httpapi::static_fallback))
        .layer(middleware::from_fn_with_state(state.clone(), httpapi::guard))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let data_dir = platform::data_dir();
    let settings = Arc::new(Settings::load(&data_dir));
    if settings.access_key().is_empty() {
        eprintln!("[Rust] settings.json di {} belum punya accessKey.", data_dir.display());
        std::process::exit(2);
    }

    let logbus = Arc::new(LogBus::new());
    let history = Arc::new(History::load(&data_dir));
    let pin = Arc::new(Pin::new(settings.clone()));
    // Cache thumbnail di folder data: bertahan antar restart, dan ikut hilang
    // kalau pengguna menghapus folder data (bukan folder simpan filenya).
    let thumbnails = Arc::new(Thumbnails::new(data_dir.join("thumbnails")));
    let transfers = Arc::new(Transfers::new());

    let http_port = env_port("PORT", 3000);
    let transfer_port = env_port("TRANSFER_PORT", http_port.saturating_add(1));
    // Port discovery default sama dengan Node; env dipakai supaya dua instance
    // bisa hidup berdampingan di satu host (pengujian, dua akun).
    let discovery_port = env_port("DISCOVERY_PORT", 41234);

    let ports = Arc::new(Ports::new(http_port, transfer_port));
    let discovery = Arc::new(Discovery::new(
        settings.device_id(),
        platform::device_name(),
        ports.clone(),
        discovery_port,
    ));

    let state = Arc::new(AppState::new(
        settings.clone(),
        pin.clone(),
        logbus.clone(),
        history,
        thumbnails,
        transfers,
        discovery.clone(),
        ports.clone(),
    ));

    // Bind HTTP dengan retry: `EADDRINUSE` tanpa handler = proses mati dengan
    // stack trace, dan user cuma tahu "gak jalan".
    let mut port = http_port;
    let mut listener: Option<TcpListener> = None;
    for _ in 0..=MAX_PORT_TRIES {
        let bind = SocketAddr::from(([0, 0, 0, 0], port));
        match TcpListener::bind(bind).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(err) => {
                eprintln!("⚠️ Port {port} is already taken by another app — LAN DROP moved to {}", port + 1);
                let _ = err;
                port += 1;
            }
        }
    }
    let Some(listener) = listener else {
        eprintln!("[Server] Port {} sampai +{} semuanya terpakai — jalankan dengan PORT=<angka lain>.", http_port, MAX_PORT_TRIES);
        std::process::exit(1);
    };
    ports.set_http(port);

    // Listener HTTP sudah hidup sebelum discovery/transfer: halaman yang dibuka
    // langsung setelah baris ini keluar tidak pernah kena "connection refused".
    discovery.start();
    transfer::start_server(state.clone());

    let ips = platform::lan_interfaces();
    println!("LAN DROP server — Rust on http://localhost:{port}");
    println!("[Server] Device name: {}", state.device_name);
    if ips.is_empty() {
        println!("⚠️  No LAN IP found — check your WiFi connection");
    } else {
        for (name, ip, _) in &ips {
            println!("📡 {name} → http://{ip}:{port}");
        }
    }
    if pin.is_default() {
        println!(
            "🔑 Dashboard PIN is still the default: {} — change it in the dashboard so Wi-Fi neighbours cannot open your transfer history.",
            pin.pin()
        );
    }
    println!(
        "[Server] Port {port} (HTTP) & {} (transfer) listening on 0.0.0.0 — other devices on the same network can reach it",
        state.ports.transfer()
    );
    let other = ips.first().map(|(_, ip, _)| ip.clone());
    println!(
        "✅ LAN DROP is running — dashboard: http://localhost:{port}/dashboard{}",
        other
            .map(|ip| format!("  •  from another device: http://{ip}:{port}/dashboard"))
            .unwrap_or_default()
    );

    let app = router(state.clone());
    if let Err(err) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
        println!("[Server] Shutting down...");
    })
    .await
    {
        eprintln!("[Server] berhenti: {err}");
        std::process::exit(1);
    }
}
