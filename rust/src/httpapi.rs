//! Rute HTTP — padanan `server/index.js`.
//!
//! Urutan penjagaan sama dengan Node dan itu penting: header keamanan, host
//! guard, origin guard, lalu bootstrap pairing. Body baru diparse setelah itu,
//! supaya request rusak tidak pernah dibalas halaman debug yang membocorkan
//! path server.
//!
//! Api yang butuh kunci perangkat memakai `access::has_access` (kunci, cookie,
//! sesi PIN, atau loopback). Endpoint yang isinya data pribadi (log, riwayat
//! lengkap, ganti PIN) tetap butuh sesi PIN meskipun kuncinya benar.

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::multipart::Multipart;
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::extract::Request;
use serde_json::{json, Value};

use crate::access;
use crate::platform;
use crate::security;
use crate::state::AppState;
use crate::transfer::RequestMeta;

// ===================== Middleware =====================

fn security_headers(response: &mut Response) {
    for (name, value) in security::SECURITY_HEADERS {
        if let (Ok(n), Ok(v)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            response.headers_mut().insert(n, v);
        }
    }
}

pub async fn guard(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().as_str().to_string();
    let headers = req.headers().clone();
    let uri = req.uri().clone();

    if let Some(message) = security::host_guard(&headers) {
        let mut resp = (StatusCode::FORBIDDEN, axum::Json(json!({ "error": message }))).into_response();
        security_headers(&mut resp);
        return resp;
    }
    if let Some(message) = security::same_origin_guard(&method, &headers) {
        let mut resp = (StatusCode::FORBIDDEN, axum::Json(json!({ "error": message }))).into_response();
        security_headers(&mut resp);
        return resp;
    }

    let addr = peer.ip().to_string();
    let mut pending_cookie: Option<String> = None;
    if let Some(resp) = access::bootstrap(&state, &addr, &headers, &uri) {
        if resp.status() == StatusCode::OK {
            // Loopback: cookie dipasang, permintaan tetap dilayani.
            pending_cookie = resp
                .headers()
                .get(header::SET_COOKIE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
        } else {
            let mut resp = resp;
            security_headers(&mut resp);
            return resp;
        }
    }

    let mut response = next.run(req).await;
    if let Some(cookie) = pending_cookie {
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            // `append`, bukan `insert`: handler juga boleh memasang cookie
            // sendiri (sesi PIN saat login). `insert` menimpanya, dan akibatnya
            // login berhasil tapi sesinya tidak pernah tersimpan.
            response.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    security_headers(&mut response);
    response
}

// ===================== Helper =====================

fn client_addr(peer: SocketAddr) -> String {
    peer.ip().to_string()
}

fn require_access(
    state: &AppState,
    addr: &str,
    headers: &HeaderMap,
    uri: &Uri,
) -> Option<Response> {
    if access::has_access(state, addr, headers, uri) {
        None
    } else {
        Some(access::pairing_error())
    }
}

fn require_pin(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    if state.pin.is_authorized(headers) {
        None
    } else {
        Some(
            (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({ "error": "Perlu PIN dashboard" })),
            )
                .into_response(),
        )
    }
}

/// Gerbang untuk berkas pribadi (thumbnail): kunci perangkat atau sesi PIN,
/// tanpa pengecualian loopback. Node memakai `requireDeviceKey` di sini, dan
/// bedanya nyata: halaman mana pun yang terbuka di mesin ini bisa membaca
/// thumbnail tanpa itu.
fn require_device_key(state: &AppState, headers: &HeaderMap, uri: &Uri) -> Option<Response> {
    if state.pin.is_authorized(headers) {
        return None;
    }
    if access::has_key(state, headers, uri) {
        return None;
    }
    Some(access::device_key_error())
}

fn rate_limited(state: &AppState, limiter: &security::RateLimiter, addr: &str) -> Option<Response> {
    let _ = state;
    limiter.hit(addr).map(|(retry, message)| {
        let mut resp = (
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(json!({ "error": message })),
        )
            .into_response();
        if let Ok(v) = HeaderValue::from_str(&retry.to_string()) {
            resp.headers_mut().insert("retry-after", v);
        }
        resp
    })
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": message })),
    )
        .into_response()
}

fn not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": message })),
    )
        .into_response()
}

fn server_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(json!({ "error": message })),
    )
        .into_response()
}

async fn json_body(body: Bytes) -> Result<Value, Response> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice::<Value>(&body)
        .map_err(|_| bad_request("Invalid JSON"))
}

fn field_str<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(|v| v.as_str())
}

// ===================== Statis =====================

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn is_unsafe_path(url_path: &str) -> bool {
    let rel = url_path.trim_start_matches('/');
    Path::new(rel).components().any(|c| {
        matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)
    })
}

fn resolve_public(public_dir: &Path, url_path: &str) -> Option<PathBuf> {
    let rel = url_path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if Path::new(rel).components().any(|c| {
        matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)
    }) {
        return None;
    }
    let candidate = public_dir.join(rel);
    let real = std::fs::canonicalize(&candidate).ok()?;
    let root = std::fs::canonicalize(public_dir).ok()?;
    if !real.starts_with(&root) {
        return None;
    }
    Some(real)
}

async fn serve_file(state: &AppState, rel: &str, extra: &[(&'static str, &'static str)]) -> Response {
    let Some(path) = resolve_public(&state.public_dir, rel) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    let path = if path.is_dir() {
        path.join("index.html")
    } else {
        path
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut resp = Response::new(Body::from(bytes));
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime_for(&path)));
            for (name, value) in extra {
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

pub async fn service_worker(State(state): State<Arc<AppState>>) -> Response {
    let mut resp = serve_file(
        &state,
        "/sw.js",
        &[
            ("cache-control", "no-cache"),
            ("service-worker-allowed", "/"),
        ],
    )
    .await;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"),
    );
    resp
}

pub async fn manifest(State(state): State<Arc<AppState>>) -> Response {
    let mut resp = serve_file(&state, "/manifest.webmanifest", &[("cache-control", "no-cache")]).await;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json"),
    );
    resp
}

pub async fn static_fallback(State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    if is_unsafe_path(uri.path()) {
        return (StatusCode::BAD_REQUEST, "Bad path").into_response();
    }
    serve_file(&state, uri.path(), &[]).await
}

// ===================== Dashboard & PIN =====================

pub async fn dashboard(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let page = if state.pin.is_authorized(&headers) {
        "/dashboard.html"
    } else {
        "/dashboard-login.html"
    };
    serve_file(&state, page, &[]).await
}

pub async fn dashboard_legacy() -> Response {
    let mut resp = (StatusCode::FOUND, "").into_response();
    resp.headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static("/dashboard"));
    resp
}

pub async fn pin_info(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> Response {
    let is_default = state.pin.is_default();
    let own_device = access::is_loopback(&client_addr(peer));
    axum::Json(json!({
        "default": is_default,
        "hint": if is_default && own_device { Some(state.pin.pin()) } else { None },
    }))
    .into_response()
}

pub async fn dashboard_login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = rate_limited(&state, &state.limiter_pin, &addr) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let pin = field_str(&body, "pin").unwrap_or("").to_string();
    if !state.pin.verify(&pin) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "ok": false, "error": "PIN salah" })),
        )
            .into_response();
    }
    let token = state.pin.create_session();
    let mut resp = axum::Json(json!({ "ok": true })).into_response();
    if let Ok(v) = HeaderValue::from_str(&state.pin.cookie_header(&token, None)) {
        resp.headers_mut().insert(header::SET_COOKIE, v);
    }
    resp
}

pub async fn dashboard_logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(token) = access::cookie_value(&headers, crate::pin::COOKIE_NAME) {
        state.pin.destroy_session(&token);
    }
    let mut resp = axum::Json(json!({ "ok": true })).into_response();
    if let Ok(v) = HeaderValue::from_str(&state.pin.cookie_header("", Some(0))) {
        resp.headers_mut().insert(header::SET_COOKIE, v);
    }
    resp
}

pub async fn dashboard_set_pin(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = rate_limited(&state, &state.limiter_pin, &addr) {
        return resp;
    }
    if let Some(resp) = require_pin(&state, &headers) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let next = field_str(&body, "pin").unwrap_or("").trim().to_string();
    let digits = next.chars().all(|c| c.is_ascii_digit());
    if !digits || !(4..=8).contains(&next.len()) {
        return bad_request("PIN must be 4-8 digits");
    }
    state.settings.set_dashboard_pin(&next);
    state.pin.revoke_all();
    axum::Json(json!({ "ok": true })).into_response()
}

// ===================== Status & discovery =====================

pub async fn me(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    let key = state.access_key();
    let mut urls: Vec<Value> = platform::lan_interfaces()
        .into_iter()
        .map(|(name, ip, _)| {
            json!({
                "ip": ip,
                "url": format!("http://{ip}:{}/?k={key}", state.ports.http()),
                "label": name,
                "via": "lan",
            })
        })
        .collect();
    if let Some(ts) = platform::own_addresses()
        .into_iter()
        .find(|a| platform::is_tailscale_ipv4(a))
    {
        urls.push(json!({
            "ip": ts,
            "url": format!("http://{ts}:{}/?k={key}", state.ports.http()),
            "label": "Tailscale",
            "via": "tailscale",
        }));
    }
    axum::Json(json!({
        "deviceName": state.device_name,
        "urls": urls,
    }))
    .into_response()
}

pub async fn discovery_status(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    let mut body = state.discovery.diagnostics();
    body["deviceName"] = json!(state.device_name);
    axum::Json(body).into_response()
}

pub async fn status(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    axum::Json(json!({
        "deviceName": state.device_name,
        "version": state.version,
        "commit": state.commit,
        "pid": std::process::id(),
        "runtime": "rust",
        "platform": std::env::consts::OS,
        "uptimeSeconds": state.uptime_seconds(),
        "startedAt": state.started_at_ms,
        "port": state.ports.http(),
        "transferPort": state.ports.transfer(),
        "discoveryPort": state.discovery.discovery_port,
        "saveDir": state.save_dir.to_string_lossy(),
        "dataDir": state.data_dir.to_string_lossy(),
    }))
    .into_response()
}

pub async fn logs(State(state): State<Arc<AppState>>, headers: HeaderMap, uri: Uri) -> Response {
    if let Some(resp) = require_pin(&state, &headers) {
        return resp;
    }
    let since = uri
        .query()
        .and_then(|q| {
            q.split('&')
                .find_map(|pair| pair.strip_prefix("since=").map(str::to_string))
        })
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    axum::Json(state.logbus.tail(since)).into_response()
}

pub async fn devices(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    let via = params.get("via").map(|v| v.as_str());
    axum::Json(state.discovery.devices(via)).into_response()
}

// ===================== Transfer HTTP =====================

pub async fn transfer_active(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    axum::Json(state.transfers.active_list()).into_response()
}

pub async fn transfer_request(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target_ip) = field_str(&body, "targetIp").map(str::to_string) else {
        return bad_request("Missing fields: targetIp, targetPort, fileName, fileSize");
    };
    let target_port = body.get("targetPort").and_then(|v| v.as_u64()).unwrap_or(0);
    let Some(file_name) = field_str(&body, "fileName").map(str::to_string) else {
        return bad_request("Missing fields: targetIp, targetPort, fileName, fileSize");
    };
    let Some(file_size) = body.get("fileSize").and_then(|v| v.as_u64()) else {
        return bad_request("Missing fields: targetIp, targetPort, fileName, fileSize");
    };
    if target_port == 0 {
        return bad_request("Missing fields: targetIp, targetPort, fileName, fileSize");
    }
    if !security::is_allowed_target_ip(&target_ip) {
        return bad_request("Target IP rejected: only LAN/Tailscale addresses are allowed");
    }
    if security::is_self_target(&target_ip) {
        return bad_request("Target points at this device itself — peer not found?");
    }

    let meta = RequestMeta {
        target_ip,
        target_port: target_port as u16,
        file_name,
        file_size,
        resume_id: field_str(&body, "resumeId").map(str::to_string),
        batch_id: body.get("batchId").cloned(),
        peer_name: field_str(&body, "targetName").map(str::to_string),
        sender_name: state.device_name.clone(),
        sender_id: state.settings.device_id(),
        kind: "file".to_string(),
    };
    match crate::transfer::send_transfer_request(state.clone(), meta).await {
        Ok(request_id) => axum::Json(json!({ "requestId": request_id })).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": err })),
        )
            .into_response(),
    }
}

pub async fn transfer_request_text(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target_ip) = field_str(&body, "targetIp").map(str::to_string) else {
        return bad_request("Missing fields: targetIp, targetPort, fileName");
    };
    let target_port = body.get("targetPort").and_then(|v| v.as_u64()).unwrap_or(0);
    let Some(file_name) = field_str(&body, "fileName").map(str::to_string) else {
        return bad_request("Missing fields: targetIp, targetPort, fileName");
    };
    if target_port == 0 {
        return bad_request("Missing fields: targetIp, targetPort, fileName");
    }
    if !security::is_allowed_target_ip(&target_ip) {
        return bad_request("Target IP rejected: only LAN/Tailscale addresses are allowed");
    }
    if security::is_self_target(&target_ip) {
        return bad_request("Target points at this device itself — peer not found?");
    }

    let meta = RequestMeta {
        target_ip,
        target_port: target_port as u16,
        file_name,
        file_size: 0,
        resume_id: None,
        batch_id: None,
        peer_name: None,
        sender_name: state.device_name.clone(),
        sender_id: state.settings.device_id(),
        kind: "text".to_string(),
    };
    match crate::transfer::send_transfer_request(state.clone(), meta).await {
        Ok(request_id) => axum::Json(json!({ "requestId": request_id })).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": err })),
        )
            .into_response(),
    }
}

pub async fn transfer_pending(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    axum::Json(state.transfers.pending_list()).into_response()
}

pub async fn transfer_respond(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(request_id) = field_str(&body, "requestId").map(str::to_string) else {
        return bad_request("Missing fields: requestId, accept");
    };
    let Some(accept) = body.get("accept").and_then(|v| v.as_bool()) else {
        return bad_request("Missing fields: requestId, accept");
    };
    match state
        .transfers
        .respond(&state, &request_id, accept, None)
    {
        Ok(result) => axum::Json(result).into_response(),
        Err(err) => not_found(&err),
    }
}

pub async fn transfer_status(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    AxumPath(request_id): AxumPath<String>,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    match state.transfers.status_json(&request_id) {
        Some(value) => axum::Json(value).into_response(),
        None => not_found("Request not found"),
    }
}

pub async fn transfer_cancel(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    AxumPath(request_id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let role = field_str(&body, "role").unwrap_or("send");
    let result = if role == "receive" {
        state.transfers.cancel_incoming(&request_id)
    } else {
        state.transfers.cancel_outgoing(&request_id)
    };
    match result {
        Ok(_) => axum::Json(json!({ "requestId": request_id, "status": "cancelled" })).into_response(),
        Err(err) => not_found(&err),
    }
}

pub async fn transfer_send_text(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(request_id) = field_str(&body, "requestId").map(str::to_string) else {
        return bad_request("Missing fields: requestId, text");
    };
    let Some(text) = field_str(&body, "text").map(str::to_string) else {
        return bad_request("Missing fields: requestId, text");
    };
    match crate::transfer::start_text_send(state.clone(), &request_id, &text).await {
        Ok(_) => axum::Json(json!({ "requestId": request_id })).into_response(),
        Err(err) => bad_request(&err),
    }
}

pub async fn transfer_text_list(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    axum::Json(state.transfers.texts_list()).into_response()
}

pub async fn transfer_text_ack(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if state.transfers.consume_text(&id) {
        axum::Json(json!({ "ok": true })).into_response()
    } else {
        not_found("Text not found")
    }
}

pub async fn transfer_send_file(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(request_id) = field_str(&body, "requestId").map(str::to_string) else {
        return bad_request("Missing fields: requestId, filePath");
    };
    let Some(file_path) = field_str(&body, "filePath").map(str::to_string) else {
        return bad_request("Missing fields: requestId, filePath");
    };
    match crate::transfer::start_file_send(state.clone(), &request_id, &file_path).await {
        Ok(file_size) => axum::Json(json!({ "requestId": request_id, "fileSize": file_size }))
            .into_response(),
        Err(err) => bad_request(&err),
    }
}

pub async fn transfer_progress(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    AxumPath(request_id): AxumPath<String>,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    match state.transfers.progress_json(&request_id) {
        Some(value) => axum::Json(value).into_response(),
        None => not_found("Progress not found"),
    }
}

pub async fn thumbnail(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let _ = peer;
    if let Some(resp) = require_device_key(&state, &headers, &uri) {
        return resp;
    }
    if id.len() != 16 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return bad_request("Invalid thumbnail id");
    }
    match state.thumbnails.get(&id.to_ascii_lowercase()).await {
        Some((bytes, content_type)) => {
            let mut resp = Response::new(Body::from(bytes));
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=86400"),
            );
            resp
        }
        None => not_found("Thumbnail not found"),
    }
}

pub async fn system_disk(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    match platform::free_space(&state.save_dir) {
        Some(free) => axum::Json(json!({
            "free": free,
            "total": Value::Null,
            "path": state.save_dir.to_string_lossy(),
        }))
        .into_response(),
        None => (
            StatusCode::NOT_IMPLEMENTED,
            axum::Json(json!({ "error": "Disk space unavailable" })),
        )
            .into_response(),
    }
}

pub async fn transfer_upload(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    mut multipart: Multipart,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    if let Err(err) = tokio::fs::create_dir_all(&state.upload_dir).await {
        return server_error(&format!("Upload folder unavailable: {err}"));
    }

    let max_bytes = platform::max_upload_mb() * 1024 * 1024;
    let mut files: Vec<Value> = Vec::new();
    let mut total_bytes: u64 = 0;

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(err) => return bad_request(&format!("Invalid multipart body: {err}")),
        };
        if field.name() != Some("file") {
            continue;
        }
        // Nama asli hanya dipakai sebagai metadata; file disimpan dengan nama
        // acak supaya nama dari klien tidak pernah jadi path di disk.
        let original = field
            .file_name()
            .map(str::to_string)
            .unwrap_or_else(|| "file".to_string());
        let stored = state.upload_dir.join(crate::settings::hex_random_public(16));
        let mut file = match tokio::fs::File::create(&stored).await {
            Ok(f) => f,
            Err(err) => return server_error(&format!("Cannot write upload: {err}")),
        };
        let mut size: u64 = 0;
        let mut stream = field;
        loop {
            match stream.chunk().await {
                Ok(Some(chunk)) => {
                    size += chunk.len() as u64;
                    total_bytes += chunk.len() as u64;
                    if size > max_bytes || total_bytes > max_bytes {
                        let _ = tokio::fs::remove_file(&stored).await;
                        return (
                            StatusCode::PAYLOAD_TOO_LARGE,
                            axum::Json(json!({
                                "error": format!(
                                    "File exceeds the {} MB limit",
                                    platform::max_upload_mb()
                                )
                            })),
                        )
                            .into_response();
                    }
                    if let Err(err) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
                        return server_error(&format!("Cannot write upload: {err}"));
                    }
                }
                Ok(None) => break,
                Err(err) => return bad_request(&format!("Upload interrupted: {err}")),
            }
        }
        if size == 0 {
            let _ = tokio::fs::remove_file(&stored).await;
            continue;
        }
        files.push(json!({
            "filePath": stored.to_string_lossy(),
            "fileName": original,
            "fileSize": size,
        }));
        if files.len() >= 50 {
            break;
        }
    }

    if files.is_empty() {
        return bad_request("No file uploaded");
    }
    axum::Json(json!({ "files": files })).into_response()
}

// ===================== Settings & history =====================

pub async fn auto_approve_get(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    let (enabled, peers) = state.settings.auto_approve();
    if state.pin.is_authorized(&headers) {
        return axum::Json(json!({ "enabled": enabled, "peers": peers })).into_response();
    }
    // Nama peer yang boleh masuk tanpa dialog bukan informasi publik: itu peta
    // buat penyerang yang mau menyamar jadi salah satunya.
    axum::Json(json!({ "enabled": enabled, "peers": [] })).into_response()
}

pub async fn auto_approve_set(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_transfer, &addr) {
        return resp;
    }
    if let Some(resp) = require_pin(&state, &headers) {
        return resp;
    }
    let body = match json_body(body).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let enabled = match body.get("enabled") {
        Some(Value::Bool(v)) => Some(*v),
        Some(_) => return bad_request("Field \"enabled\" must be a boolean"),
        None => None,
    };
    let peers = match body.get("peers") {
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect::<Vec<String>>(),
        ),
        Some(_) => return bad_request("Field \"peers\" must be an array of device names"),
        None => None,
    };
    let (enabled, peers) = state.settings.set_auto_approve(enabled, peers);
    axum::Json(json!({ "enabled": enabled, "peers": peers })).into_response()
}

pub async fn history_list(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    let items = state.history.list();
    if state.pin.is_authorized(&headers) {
        return axum::Json(items).into_response();
    }
    // Tanpa sesi PIN: `savedTo` (path di disk) dan `thumbnailId` (kunci
    // /thumbnail/<id>) dibuang — pemanggil tanpa login tidak perlu peta itu.
    let redacted: Vec<Value> = items
        .into_iter()
        .map(|item| {
            let mut obj = item.as_object().cloned().unwrap_or_default();
            obj.remove("savedTo");
            obj.remove("thumbnailId");
            Value::Object(obj)
        })
        .collect();
    axum::Json(redacted).into_response()
}

pub async fn history_clear(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let addr = client_addr(peer);
    if let Some(resp) = require_access(&state, &addr, &headers, &uri) {
        return resp;
    }
    if let Some(resp) = rate_limited(&state, &state.limiter_destructive, &addr) {
        return resp;
    }
    // Terbuka = penyerang bisa menghapus jejak file yang baru dia selundupkan.
    if let Some(resp) = require_pin(&state, &headers) {
        return resp;
    }
    state.history.clear();
    axum::Json(json!({ "ok": true })).into_response()
}
