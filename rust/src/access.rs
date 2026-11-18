//! Kunci akses per perangkat — padanan `server/access.js`.
//!
//! Alur nol-setup: QR di panel "Sambung" memuat `?k=<kunci>`. Membukanya
//! menukar kunci itu jadi cookie lalu mengalihkan ke alamat bersih, jadi kunci
//! tidak tertinggal di address bar dan semua API berikutnya memakai cookie.
//!
//! Loopback dapat cookie otomatis: proses di mesin ini sendiri sudah bisa
//! membaca `settings.json` dan folder simpan, jadi menolaknya tidak menambah
//! keamanan — yang rusak cuma TUI, skrip e2e, dan curl dari mesin sendiri.

use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::state::AppState;

pub const COOKIE_NAME: &str = "landrop_key";
pub const HEADER_NAME: &str = "x-landrop-key";
const COOKIE_MAX_AGE: u64 = 30 * 24 * 60 * 60;

pub fn normalize_addr(addr: &str) -> String {
    let a = addr.trim_start_matches("::ffff:");
    a.split('%').next().unwrap_or(a).to_string()
}

pub fn is_loopback(addr: &str) -> bool {
    let a = normalize_addr(addr);
    a == "::1" || a == "::" || a == "localhost" || a.starts_with("127.")
}

pub fn key_matches(given: &str, expected: &str) -> bool {
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

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    for value in headers.get_all(header::COOKIE).iter() {
        let Ok(raw) = value.to_str() else { continue };
        for part in raw.split(';') {
            let part = part.trim();
            if let Some(rest) = part.strip_prefix(name) {
                if let Some(v) = rest.strip_prefix('=') {
                    return Some(urldecode(v));
                }
            }
        }
    }
    None
}

pub fn urldecode(s: &str) -> String {
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

pub fn query_param(uri: &Uri, want: &str) -> Option<String> {
    let q = uri.query()?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next().unwrap_or("") == want {
            return Some(urldecode(it.next().unwrap_or("")));
        }
    }
    None
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
    cookie_value(headers, COOKIE_NAME)
}

pub fn has_key(state: &AppState, headers: &HeaderMap, uri: &Uri) -> bool {
    match presented_key(headers, uri) {
        Some(k) => key_matches(&k, &state.settings.access_key()),
        None => false,
    }
}

/// Boleh memakai API? Kunci perangkat, ATAU sesi PIN dashboard, ATAU loopback.
pub fn has_access(state: &AppState, addr: &str, headers: &HeaderMap, uri: &Uri) -> bool {
    if has_key(state, headers, uri) {
        return true;
    }
    if is_loopback(addr) {
        return true;
    }
    state.pin.is_authorized(headers)
}

pub fn pairing_error() -> Response {
    let body = serde_json::json!({
        "error": "This device is not paired. Scan the QR code in the \"Connect\" panel \
                  of the device running LAN DROP.",
        "pairing": true,
    });
    (StatusCode::UNAUTHORIZED, axum::Json(body)).into_response()
}

pub fn device_key_error() -> Response {
    let body = serde_json::json!({
        "error": "Device key or dashboard PIN required",
        "pairing": true,
    });
    (StatusCode::UNAUTHORIZED, axum::Json(body)).into_response()
}

fn cookie_header(key: &str) -> String {
    format!("{COOKIE_NAME}={key}; Path=/; HttpOnly; SameSite=Lax; Max-Age={COOKIE_MAX_AGE}")
}

/// Bootstrap pairing: tukar `?k=` jadi cookie, beri cookie otomatis ke
/// loopback, dan tolak kunci yang salah sebelum menyentuh route mana pun.
///
/// `None` = lanjutkan ke handler. `Some(resp)` = balas ini dan berhenti.
pub fn bootstrap(state: &AppState, addr: &str, headers: &HeaderMap, uri: &Uri) -> Option<Response> {
    let expected = state.settings.access_key();

    if let Some(q) = query_param(uri, "k") {
        if key_matches(&q, &expected) {
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
            let mut resp = (StatusCode::FOUND, "").into_response();
            if let Ok(v) = HeaderValue::from_str(&cookie_header(&expected)) {
                resp.headers_mut().insert(header::SET_COOKIE, v);
            }
            if let Ok(v) = HeaderValue::from_str(&target) {
                resp.headers_mut().insert(header::LOCATION, v);
            }
            return Some(resp);
        }
        // Kunci di URL tapi salah: berhenti di sini, jangan buka UI.
        let body = serde_json::json!({
            "error": "Access key does not match. Scan the QR code again.",
            "pairing": true,
        });
        return Some((StatusCode::FORBIDDEN, axum::Json(body)).into_response());
    }

    // Browser di mesin ini sendiri: cookie otomatis, tanpa memindai QR sendiri.
    if is_loopback(addr) && cookie_value(headers, COOKIE_NAME).is_none() {
        let mut resp = (StatusCode::OK, "").into_response();
        resp.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&cookie_header(&expected)).unwrap(),
        );
        return Some(resp);
    }

    None
}
