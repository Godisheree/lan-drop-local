//! Inti LAN DROP versi Rust — potongan pertama, bukan pengganti penuh.
//!
//! Status: port bertahap (docs/adr/0013). Yang sudah ada di sini: server HTTP,
//! penyajian frontend yang sudah ada tanpa build step, `/status`, dan gerbang
//! kunci akses per perangkat dengan perilaku yang sama seperti Node.
//!
//! Yang BELUM diport: transfer TCP, discovery UDP, PIN dashboard, riwayat,
//! thumbnail, auto-approve. Selama itu belum ada dan belum lolos
//! `scripts/check-parity.js`, server Node tetap yang dipakai.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

const COOKIE_NAME: &str = "landrop_key";
const HEADER_NAME: &str = "x-landrop-key";
const COOKIE_MAX_AGE: u64 = 30 * 24 * 60 * 60;

struct Config {
    device_name: String,
    access_key: String,
    port: u16,
    transfer_port: u16,
    discovery_port: u16,
    save_dir: PathBuf,
    data_dir: PathBuf,
    public_dir: PathBuf,
    version: String,
}

struct AppState {
    cfg: Config,
    started: Instant,
    started_at_ms: u128,
}

fn env_or(name: &str, fallback: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

fn env_port(name: &str, fallback: u16) -> u16 {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<u16>().ok()).unwrap_or(fallback)
}

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn default_data_dir() -> PathBuf {
    home().join(".local/share/lan-drop")
}

fn default_save_dir() -> PathBuf {
    home().join("Downloads/LAN DROP")
}

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "LAN DROP".to_string())
}

fn repo_root() -> PathBuf {
    // Binary dibangun dari rust/, jadi akar repo dua tingkat di atas target/.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn public_dir() -> PathBuf {
    if let Ok(p) = std::env::var("LANDROP_PUBLIC_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    for candidate in [repo_root().join("public"), PathBuf::from("public")] {
        if candidate.join("index.html").exists() {
            return candidate;
        }
    }
    PathBuf::from("public")
}

/// Versi diambil dari package.json, bukan diketik ulang: dua implementasi yang
/// melaporkan versi berbeda akan langsung terlihat oleh klien.
fn read_version() -> String {
    let pkg = repo_root().join("package.json");
    if let Ok(text) = std::fs::read_to_string(pkg) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
                return v.to_string();
            }
        }
    }
    "0.0.0".to_string()
}

fn read_commit() -> Option<String> {
    let git = repo_root().join(".git");
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(rest) = head.strip_prefix("ref:") {
        let path = git.join(rest.trim());
        let sha = std::fs::read_to_string(path).ok()?;
        return Some(sha.trim().chars().take(7).collect());
    }
    Some(head.chars().take(7).collect())
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

/// Baca accessKey dari settings.json tanpa menulis apa pun.
///
/// Kunci TIDAK digenerate di sini: dua implementasi yang membuat kunci sendiri
/// akan saling menolak perangkat yang sama. Selama port belum lengkap, kunci
/// dibuat oleh server Node.
fn read_access_key(data_dir: &Path) -> String {
    if let Ok(text) = std::fs::read_to_string(settings_path(data_dir)) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(k) = json.get("accessKey").and_then(|v| v.as_str()) {
                if k.len() >= 32 {
                    return k.to_string();
                }
            }
        }
    }
    String::new()
}

fn read_device_name(data_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(settings_path(data_dir)).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    json.get("deviceName").and_then(|v| v.as_str()).map(str::to_string)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn normalize_addr(addr: &str) -> String {
    let a = addr.strip_prefix("::ffff:").unwrap_or(addr);
    a.split('%').next().unwrap_or(a).to_string()
}

fn is_loopback(addr: &str) -> bool {
    let a = normalize_addr(addr);
    a == "::1" || a == "::" || a == "localhost" || a.starts_with("127.")
}

/// Bandingkan kunci dengan waktu konstan (sama seperti sisi Node).
fn key_matches(given: &str, expected: &str) -> bool {
    let a = given.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn cookie_value(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE).iter() {
        let raw = value.to_str().ok()?;
        for part in raw.split(';') {
            let part = part.trim();
            if let Some(rest) = part.strip_prefix(COOKIE_NAME) {
                if let Some(v) = rest.strip_prefix('=') {
                    // Cookie dari browser tidak pernah berisi ';' jadi ini aman.
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn query_param(uri: &Uri, want: &str) -> Option<String> {
    let q = uri.query()?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        if k == want {
            return Some(urldecode(it.next().unwrap_or("")));
        }
    }
    None
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn presented_key(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(h) = headers.get(HEADER_NAME).and_then(|v| v.to_str().ok()) {
        let h = h.trim();
        if !h.is_empty() {
            return Some(h.to_string());
        }
    }
    if let Some(q) = query_param(uri, "k") {
        return Some(q);
    }
    cookie_value(headers)
}

fn pairing_error() -> Response {
    let body = serde_json::json!({
        "error": "This device is not paired. Scan the QR code in the \"Connect\" panel \
                  of the device running LAN DROP.",
        "pairing": true,
    });
    (StatusCode::UNAUTHORIZED, axum::Json(body)).into_response()
}

fn has_access(state: &AppState, addr: &str, headers: &HeaderMap, uri: &Uri) -> bool {
    if let Some(k) = presented_key(headers, uri) {
        if key_matches(&k, &state.cfg.access_key) {
            return true;
        }
    }
    is_loopback(addr)
}

/// Alamat bersih: `?k=` ditukar jadi cookie lalu dialihkan, sama seperti Node.
fn bootstrap_pairing(state: &AppState, addr: &str, headers: &HeaderMap, uri: &Uri) -> Option<Response> {
    if let Some(q) = query_param(uri, "k") {
        if key_matches(&q, &state.cfg.access_key) {
            let mut rest: Vec<String> = Vec::new();
            if let Some(query) = uri.query() {
                for pair in query.split('&') {
                    if !pair.starts_with("k=") {
                        rest.push(pair.to_string());
                    }
                }
            }
            let path = uri.path().to_string();
            let target = if rest.is_empty() {
                path
            } else {
                format!("{}?{}", path, rest.join("&"))
            };
            let cookie = format!(
                "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
                COOKIE_NAME, state.cfg.access_key, COOKIE_MAX_AGE
            );
            let mut resp = (StatusCode::FOUND, "").into_response();
            if let Ok(v) = HeaderValue::from_str(&cookie) {
                resp.headers_mut().insert(header::SET_COOKIE, v);
            }
            if let Ok(v) = HeaderValue::from_str(&target) {
                resp.headers_mut().insert(header::LOCATION, v);
            }
            return Some(resp);
        }
    }

    // Browser di mesin ini sendiri dapat cookie otomatis supaya tidak perlu
    // memindai QR dari perangkat yang sama. Hanya loopback.
    if is_loopback(addr) && cookie_value(headers).is_none() {
        let cookie = format!(
            "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
            COOKIE_NAME, state.cfg.access_key, COOKIE_MAX_AGE
        );
        let mut resp = (StatusCode::OK, "").into_response();
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            resp.headers_mut().insert(header::SET_COOKIE, v);
        }
        return Some(resp);
    }

    // Kunci di URL tapi salah: jangan lanjut, beri tahu.
    if let Some(q) = query_param(uri, "k") {
        if !key_matches(&q, &state.cfg.access_key) {
            let body = serde_json::json!({
                "error": "Access key does not match. Scan the QR code again.",
                "pairing": true,
            });
            return Some((StatusCode::FORBIDDEN, axum::Json(body)).into_response());
        }
    }

    None
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Ubah URL jadi path di dalam public/, atau None kalau mencoba keluar.
fn resolve_public(public_dir: &Path, url_path: &str) -> Option<PathBuf> {
    let rel = url_path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    // Tolak komponen yang bisa keluar dari public/ sebelum menyentuh disk.
    if Path::new(rel).components().any(|c| {
        matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)
    }) {
        return None;
    }
    let candidate = public_dir.join(rel);
    // canonicalize() butuh file yang ada; untuk 404 kita kembalikan None saja.
    let real = std::fs::canonicalize(&candidate).ok()?;
    let _ = &real;
    let root = std::fs::canonicalize(public_dir).ok()?;
    if !real.starts_with(&root) {
        return None;
    }
    Some(real)
}

/// Kirim satu berkas dari public/ dengan header tambahan (kalau ada).
async fn serve_file(
    state: &AppState,
    rel: &str,
    headers: &[(&'static str, String)],
) -> Response {
    let Some(path) = resolve_public(&state.cfg.public_dir, rel) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut resp = Response::new(Body::from(bytes));
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime_for(&path)));
            for (name, value) in headers {
                if let (Ok(n), Ok(v)) = (
                    header::HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(value),
                ) {
                    resp.headers_mut().insert(n, v);
                }
            }
            resp
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

/// `/sw.js` dan manifest butuh header khusus; kalau tidak, browser memakai
/// versi service worker yang lama dan PWA tidak pernah ter-update.
async fn sw_js(state: State<Arc<AppState>>) -> Response {
    let mut resp = serve_file(
        &state,
        "/sw.js",
        &[
            ("cache-control", "no-cache".to_string()),
            ("service-worker-allowed", "/".to_string()),
        ],
    )
    .await;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"),
    );
    resp
}

async fn manifest(state: State<Arc<AppState>>) -> Response {
    let mut resp = serve_file(&state, "/manifest.webmanifest", &[("cache-control", "no-cache".to_string())]).await;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json"),
    );
    resp
}

/// `/dashboard` terkunci PIN. Sesi PIN belum diport, jadi selama fase ini yang
/// disajikan selalu halaman login — sama seperti Node untuk pengunjung yang
/// belum login.
async fn dashboard(state: State<Arc<AppState>>) -> Response {
    serve_file(&state, "/dashboard-login.html", &[]).await
}

async fn dashboard_legacy() -> Response {
    let mut resp = (StatusCode::FOUND, "").into_response();
    resp.headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static("/dashboard"));
    resp
}

/// Path yang jelas mencoba keluar dari public/ (bukan sekadar tidak ada).
fn is_unsafe_path(url_path: &str) -> bool {
    let rel = url_path.trim_start_matches('/');
    Path::new(rel).components().any(|c| {
        matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)
    })
}

async fn serve_static(state: Arc<AppState>, uri: Uri) -> Response {
    if is_unsafe_path(uri.path()) {
        return (StatusCode::BAD_REQUEST, "Bad path").into_response();
    }
    let Some(path) = resolve_public(&state.cfg.public_dir, uri.path()) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    // Folder tanpa index.html -> 404, bukan daftar isi.
    let path = if path.is_dir() { path.join("index.html") } else { path };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = mime_for(&path);
            let mut resp = Response::new(Body::from(bytes));
            resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            resp
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn index(state: State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, uri: Uri) -> Response {
    let addr = peer.ip().to_string();
    if let Some(resp) = bootstrap_pairing(&state, &addr, &headers, &uri) {
        if resp.status() == StatusCode::OK {
            // Bootstrap loopback hanya memasang cookie; permintaan tetap dilayani.
            let mut resp = serve_static(state.0.clone(), uri.clone()).await;
            if let Ok(v) = HeaderValue::from_str(&format!(
                "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
                COOKIE_NAME, state.cfg.access_key, COOKIE_MAX_AGE
            )) {
                resp.headers_mut().insert(header::SET_COOKIE, v);
            }
            return resp;
        }
        return resp;
    }
    serve_static(state.0.clone(), uri).await
}

async fn static_route(
    state: State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = peer.ip().to_string();
    if let Some(resp) = bootstrap_pairing(&state, &addr, &headers, &uri) {
        if resp.status() != StatusCode::OK {
            return resp;
        }
    }
    serve_static(state.0.clone(), uri).await
}

async fn status(
    state: State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = peer.ip().to_string();
    if !has_access(&state, &addr, &headers, &uri) {
        return pairing_error();
    }
    let uptime = state.started.elapsed().as_secs();
    let body = serde_json::json!({
        "deviceName": state.cfg.device_name,
        "version": state.cfg.version,
        "commit": read_commit(),
        "pid": std::process::id(),
        "runtime": "rust",
        "platform": std::env::consts::OS,
        "uptimeSeconds": uptime,
        "startedAt": state.started_at_ms,
        "port": state.cfg.port,
        "transferPort": state.cfg.transfer_port,
        "discoveryPort": state.cfg.discovery_port,
        "saveDir": state.cfg.save_dir.to_string_lossy(),
        "dataDir": state.cfg.data_dir.to_string_lossy(),
    });
    axum::Json(body).into_response()
}

#[tokio::main]
async fn main() {
    let data_dir = std::env::var("LANDROP_DATA_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir);
    let save_dir = std::env::var("LANDROP_SAVE_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_save_dir);

    let port = env_port("PORT", 3000);
    let transfer_port = env_port("TRANSFER_PORT", port + 1);
    let discovery_port = env_port("DISCOVERY_PORT", 3002);

    // Kunci bisa ditimpa env (dipakai skrip uji), sama seperti sisi Node.
    let mut access_key = std::env::var("LANDROP_ACCESS_KEY").unwrap_or_default();
    if access_key.is_empty() {
        access_key = read_access_key(&data_dir);
    }
    if access_key.is_empty() {
        eprintln!(
            "[Rust] settings.json di {} belum punya accessKey. Jalankan server Node sekali \
             supaya kunci dibuat, atau set LANDROP_ACCESS_KEY.",
            data_dir.display()
        );
        std::process::exit(2);
    }

    let device_name = env_or(
        "DEVICE_NAME",
        &read_device_name(&data_dir).unwrap_or_else(hostname),
    );

    let cfg = Config {
        device_name,
        access_key,
        port,
        transfer_port,
        discovery_port,
        save_dir,
        data_dir,
        public_dir: public_dir(),
        version: read_version(),
    };

    let bind: SocketAddr = ([0, 0, 0, 0], cfg.port).into();
    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(l) => l,
        Err(err) => {
            eprintln!("[Rust] tidak bisa bind {}: {}", bind, err);
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        started: Instant::now(),
        started_at_ms: now_ms(),
        cfg,
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/status", get(status))
        .route("/sw.js", get(sw_js))
        .route("/manifest.webmanifest", get(manifest))
        .route("/dashboard", get(dashboard))
        .route("/dashboard.html", get(dashboard_legacy))
        .fallback(get(static_route))
        .with_state(state.clone());

    // Info startup dibuat mirip Node supaya skrip yang menunggu baris ini tetap
    // jalan (check-* menunggu port terbuka, tapi e2e membaca log).
    let mut dns: HashMap<&str, String> = HashMap::new();
    dns.insert("http", state.cfg.port.to_string());
    println!(
        "[Rust] LAN DROP core siap di http://0.0.0.0:{} (device: {}, versi {})",
        state.cfg.port, state.cfg.device_name, state.cfg.version
    );

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        println!("[Rust] berhenti");
    };

    if let Err(err) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    {
        eprintln!("[Rust] server berhenti: {}", err);
        std::process::exit(1);
    }

    // Senyap tanpa peringatan: durasi startup dibiarkan untuk log berikutnya.
    let _ = Duration::from_secs(0);
    let _ = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
}