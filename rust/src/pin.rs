//! Sesi PIN dashboard — padanan `server/pin.js`.
//!
//! Sesi disimpan di memori, bukan di disk: restart server = semua browser
//! diminta memasukkan PIN lagi. Kalau sesi ikut ke disk, "logout" jadi tidak
//! ada artinya karena token bisa hidup lebih lama dari niat user mencabutnya.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::http::HeaderMap;

use crate::settings::{Settings, DEFAULT_PIN};

pub const COOKIE_NAME: &str = "landrop_dash";
const TTL_SECONDS: u64 = 24 * 60 * 60;

pub struct Pin {
    settings: std::sync::Arc<Settings>,
    sessions: Mutex<HashMap<String, u64>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

impl Pin {
    pub fn new(settings: std::sync::Arc<Settings>) -> Pin {
        Pin {
            settings,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn pin(&self) -> String {
        self.settings.dashboard_pin()
    }

    pub fn is_default(&self) -> bool {
        self.pin() == DEFAULT_PIN
    }

    /// Bandingkan dengan waktu konstan supaya panjang/isi PIN tidak bocor.
    pub fn verify(&self, input: &str) -> bool {
        constant_time_eq(input.trim().as_bytes(), self.pin().as_bytes())
    }

    pub fn create_session(&self) -> String {
        let token = crate::settings::hex_random_public(24);
        let now = now_ms();
        if let Ok(mut sessions) = self.sessions.lock() {
            // Entri mati hanya dibuang saat tokennya dipakai lagi. Tanpa
            // sapuan di sini, setiap login menambah satu entri yang tidak
            // pernah dibaca dan map tumbuh sampai proses restart.
            sessions.retain(|_, expires| *expires > now);
            sessions.insert(token.clone(), now + TTL_SECONDS * 1000);
        }
        token
    }

    pub fn destroy_session(&self, token: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(token);
        }
    }

    pub fn revoke_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }

    fn valid_token(&self, token: Option<&str>) -> bool {
        let Some(token) = token else { return false };
        let Ok(mut sessions) = self.sessions.lock() else {
            return false;
        };
        match sessions.get(token) {
            None => false,
            Some(&expires) if expires <= now_ms() => {
                sessions.remove(token);
                false
            }
            Some(_) => true,
        }
    }

    pub fn is_authorized(&self, headers: &HeaderMap) -> bool {
        let token = crate::access::cookie_value(headers, COOKIE_NAME);
        self.valid_token(token.as_deref())
    }

    /// `max_age_seconds = Some(0)` dipakai logout untuk menyuruh browser
    /// menghapus cookie-nya. Tanpa `Secure` karena LAN DROP jalan di http polos.
    pub fn cookie_header(&self, token: &str, max_age_seconds: Option<u64>) -> String {
        let base = format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax");
        match max_age_seconds {
            Some(age) => format!("{base}; Max-Age={age}"),
            None => base,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sesi_kedaluwarsa_dibuang_saat_sesi_baru_dibuat() {
        let dir = std::env::temp_dir().join(format!("lan-drop-pin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pin = Pin::new(std::sync::Arc::new(Settings::load(&dir)));

        for _ in 0..5 {
            pin.create_session();
        }
        // Semua sesi lama dianggap kedaluwarsa (lewat 24 jam).
        if let Ok(mut sessions) = pin.sessions.lock() {
            for expires in sessions.values_mut() {
                *expires = 0;
            }
        }
        pin.create_session();

        let count = pin.sessions.lock().map(|s| s.len()).unwrap_or(0);
        assert_eq!(count, 1, "sesi mati harus dibuang, tersisa {count} entri");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
