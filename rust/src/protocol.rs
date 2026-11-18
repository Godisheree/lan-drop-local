//! Kontrak kabel TCP — 4 byte panjang big-endian + JSON UTF-8.
//!
//! Batas-batas ini yang membuat port transfer tidak bisa dipakai untuk
//! menghabiskan memori server: frame maksimal 64 KiB, teks maksimal 1 MiB,
//! koneksi menganggur diputus setelah 120 detik, dan jumlah koneksi bersamaan
//! dibatasi. Angka-angkanya sengaja sama dengan `server/transfer.js` — peer
//! Node dan Rust harus menolak hal yang sama.

use serde_json::Value;
use sha1::{Digest, Sha1};

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const CONNECTION_IDLE_TIMEOUT_SECS: u64 = 120;
pub const MAX_TCP_CONNECTIONS: usize = 64;

/// Bungkus satu pesan JSON jadi frame: panjang (BE u32) + payload.
pub fn framed(value: &Value) -> Vec<u8> {
    let payload = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    out
}

/// Kunci resume satu file: `sha1(senderId|resumeId|fileName|fileSize)` → 16 hex.
///
/// Identitas pengirim dan resumeId ikut masuk supaya dua file berbeda yang
/// kebetulan bernama dan berukuran sama tidak pernah disambung jadi satu.
pub fn make_transfer_key(
    sender_id: &str,
    resume_id: &str,
    file_name: &str,
    file_size: u64,
) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{sender_id}|{resume_id}|{file_name}|{file_size}").as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..16].to_string()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_prefix_is_big_endian_length() {
        let bytes = framed(&serde_json::json!({"type": "halo"}));
        let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        assert_eq!(len, bytes.len() - 4);
        let parsed: Value = serde_json::from_slice(&bytes[4..]).unwrap();
        assert_eq!(parsed["type"], "halo");
    }

    #[test]
    fn frame_stays_under_wire_limit_for_small_payload() {
        let bytes = framed(&serde_json::json!({"type": "text", "text": "x".repeat(1024)}));
        assert!(bytes.len() <= MAX_FRAME_BYTES);
    }

    #[test]
    fn transfer_key_is_stable_and_sixteen_hex() {
        let a = make_transfer_key("sender1", "resume1", "film.mp4", 1024);
        let b = make_transfer_key("sender1", "resume1", "film.mp4", 1024);
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn transfer_key_changes_with_identity_name_and_size() {
        let base = make_transfer_key("sender1", "resume1", "film.mp4", 1024);
        assert_ne!(
            base,
            make_transfer_key("sender2", "resume1", "film.mp4", 1024)
        );
        assert_ne!(
            base,
            make_transfer_key("sender1", "resume2", "film.mp4", 1024)
        );
        assert_ne!(
            base,
            make_transfer_key("sender1", "resume1", "film2.mp4", 1024)
        );
        assert_ne!(
            base,
            make_transfer_key("sender1", "resume1", "film.mp4", 2048)
        );
    }
}
