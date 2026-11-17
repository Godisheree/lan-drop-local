//! Lapisan keamanan HTTP — padanan `server/security.js`.
//!
//! Isinya bukan autentikasi: LAN DROP memang tanpa autentikasi di jaringan
//! lokal. Yang ditutup di sini adalah jalur abuse paling murah: header yang
//! hilang, request yang di-flood, POST lintas-origin, dan DNS rebinding.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;

pub const SECURITY_HEADERS: [(&str, &str); 4] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    (
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; \
         base-uri 'none'; frame-ancestors 'none'",
    ),
];

fn env_is_one(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1"))
}

// ===================== Validasi alamat tujuan =====================

fn is_allowed_ipv4(addr: &str) -> bool {
    let Ok(ip) = addr.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let o = ip.octets();
    if o[0] == 169 && o[1] == 254 {
        return false; // link-local: metadata cloud, selalu tolak
    }
    ip.is_loopback()
        || ip.is_private()
        || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT Tailscale
}

fn is_allowed_ipv6(addr: &str) -> bool {
    let Ok(ip) = addr.parse::<std::net::Ipv6Addr>() else {
        return false;
    };
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_allowed_ipv4(&v4.to_string());
    }
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let seg = ip.segments();
    (seg[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local (termasuk fd7a = Tailscale)
        || (seg[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
}

fn trusted_peer_hostnames() -> Vec<String> {
    let Ok(raw) = std::env::var("LANDROP_PEERS") else {
        return Vec::new();
    };
    raw.split(',')
        .filter_map(|entry| {
            let addr_part = entry.trim().split('@').nth(1)?;
            let host = match addr_part.rfind(':') {
                Some(idx) => &addr_part[..idx],
                None => addr_part,
            };
            if host.is_empty() || host.parse::<IpAddr>().is_ok() {
                None
            } else {
                Some(host.to_ascii_lowercase())
            }
        })
        .collect()
}

/// Target boleh dihubungi? Default hanya LAN/Tailscale; ini yang menutup SSRF
/// ke metadata cloud dan ke host publik sembarang.
pub fn is_allowed_target_ip(target: &str) -> bool {
    if env_is_one("LANDROP_ALLOW_PUBLIC_TARGETS") {
        return true;
    }
    let value = target.trim();
    if value.is_empty() {
        return false;
    }
    let addr = value.trim_start_matches('[').trim_end_matches(']');
    match addr.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) => is_allowed_ipv4(addr),
        Ok(IpAddr::V6(_)) => is_allowed_ipv6(addr),
        Err(_) => trusted_peer_hostnames()
            .iter()
            .any(|h| h == &addr.to_ascii_lowercase()),
    }
}

/// Target menunjuk mesin ini sendiri? Kirimannya akan mendarat di pengirim,
/// bukan di peer — lebih baik ditolak dengan pesan jelas.
pub fn is_self_target(target: &str) -> bool {
    if env_is_one("LANDROP_ALLOW_SELF_TARGET") {
        return false;
    }
    let value = target.trim().to_ascii_lowercase();
    if value.is_empty() {
        return false;
    }
    if value == "localhost" || value == "localhost.localdomain" {
        return true;
    }
    let bare = value.trim_start_matches('[').trim_end_matches(']').to_string();
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if ip.is_loopback() {
            return true;
        }
    }
    crate::platform::own_addresses()
        .iter()
        .any(|a| a.to_ascii_lowercase() == bare)
}

// ===================== Host guard (anti DNS rebinding) =====================

fn own_hostnames() -> Vec<String> {
    let mut names = Vec::new();
    let mut add = |value: &str| {
        let text = value.trim().to_ascii_lowercase();
        if text.is_empty() {
            return;
        }
        let short = text.split('.').next().unwrap_or("").to_string();
        names.push(text);
        if !short.is_empty() {
            names.push(short.clone());
            names.push(format!("{short}.local"));
        }
    };
    add(&crate::platform::hostname());
    if let Ok(list) = std::env::var("LANDROP_ALLOWED_HOSTS") {
        for entry in list.split(',') {
            add(entry);
        }
    }
    names
}

/// `host` dari header Host, tanpa port, huruf kecil, tanpa titik di ujung.
fn normalize_host(raw: &str) -> String {
    let mut host = raw.trim().to_string();
    if host.starts_with('[') {
        host = match host.find(']') {
            Some(end) => host[1..end].to_string(),
            None => String::new(),
        };
    } else if let Some(colon) = host.rfind(':') {
        host.truncate(colon);
    }
    host.to_ascii_lowercase().trim_end_matches('.').to_string()
}

/// `None` = boleh. `Some(pesan)` = tolak 403.
pub fn host_guard(headers: &HeaderMap) -> Option<String> {
    if env_is_one("LANDROP_ALLOW_ANY_HOST") {
        return None;
    }
    let raw = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let host = normalize_host(raw);
    if host.is_empty() {
        return Some("Forbidden: missing Host header".to_string());
    }
    if host == "localhost" || host == "localhost.localdomain" {
        return None;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) if is_allowed_ipv4(&host) => return None,
        Ok(IpAddr::V6(_)) if is_allowed_ipv6(&host) => return None,
        _ => {}
    }
    if own_hostnames().iter().any(|n| *n == host) {
        return None;
    }
    Some(
        "Forbidden: unknown Host. Use the LAN/Tailscale IP address, \
         or register the name in LANDROP_ALLOWED_HOSTS."
            .to_string(),
    )
}

/// Tolak POST dari origin lain (anti-CSRF sederhana). Request tanpa Origin
/// (curl, aplikasi native, skrip) tetap lewat.
pub fn same_origin_guard(method: &str, headers: &HeaderMap) -> Option<&'static str> {
    let method = method.to_ascii_uppercase();
    if method == "GET" || method == "HEAD" || method == "OPTIONS" {
        return None;
    }
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return None;
    };
    let origin_host = origin
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    if origin_host.is_empty() {
        return Some("Forbidden: invalid origin");
    }
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    if origin_host != host {
        return Some("Forbidden: cross-origin request rejected");
    }
    None
}

// ===================== Rate limit (fixed window per IP) =====================

pub struct RateLimiter {
    window: Duration,
    max: u32,
    message: String,
    hits: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimiter {
    pub fn new(window: Duration, max: u32, message: &str) -> RateLimiter {
        RateLimiter {
            window,
            max,
            message: message.to_string(),
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// `Some((retry_after_seconds, pesan))` kalau kena limit.
    pub fn hit(&self, ip: &str) -> Option<(u64, String)> {
        let mut hits = self.hits.lock().ok()?;
        let now = Instant::now();
        // Bersihin entry kedaluwarsa supaya Map tidak tumbuh tanpa batas.
        if hits.len() > 1024 {
            hits.retain(|_, (_, reset)| *reset > now);
        }
        let entry = hits
            .entry(ip.to_string())
            .or_insert((0, now + self.window));
        if entry.1 <= now {
            *entry = (0, now + self.window);
        }
        entry.0 += 1;
        if entry.0 > self.max {
            let retry = entry.1.saturating_duration_since(now).as_secs().max(1);
            return Some((retry, self.message.clone()));
        }
        None
    }
}
