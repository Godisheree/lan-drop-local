//! `settings.json` — padanan `server/settings.js`.
//!
//! Dua hal yang harus sama persis dengan Node:
//!  1. Kunci pairing yang belum ada dibuat SEKALI lalu disimpan. Kalau tiap
//!     start membuat kunci baru, semua perangkat yang sudah dipasangkan
//!     mendadak ditolak.
//!  2. Tulis hanya kunci yang benar-benar diubah proses ini, dimulai dari isi
//!     disk — bukan dari cache memori. Dua instance di satu data dir kalau
//!     tidak begini saling menimpa (gejalanya: "PIN balik ke bawaan").

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

pub const DEFAULT_PIN: &str = "123456";

pub struct Settings {
    path: PathBuf,
    inner: Mutex<Inner>,
}

struct Inner {
    auto_approve_enabled: bool,
    auto_approve_peers: Vec<String>,
    dashboard_pin: String,
    access_key: String,
    device_id: String,
    changed: BTreeSet<&'static str>,
}

/// Token acak hex — dipakai kunci akses, deviceId, dan sesi PIN.
pub fn hex_random_public(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if getrandom::getrandom(&mut buf).is_err() {
        // Sumber acak sistem tidak tersedia: jangan diam-diam memakai nilai
        // lemah yang sama di semua mesin.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((now >> ((i % 16) * 8)) ^ (i as u128 * 37)) as u8;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn normalize_pin(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    if (4..=8).contains(&text.len()) && text.chars().all(|c| c.is_ascii_digit()) {
        text
    } else {
        DEFAULT_PIN.to_string()
    }
}

fn normalize_access_key(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(s)) => s.trim().to_ascii_lowercase(),
        _ => String::new(),
    };
    if (32..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit()) {
        text
    } else {
        String::new()
    }
}

fn normalize_device_id(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(s)) => s.trim().to_string(),
        _ => String::new(),
    };
    if (4..=80).contains(&text.len())
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        text
    } else {
        String::new()
    }
}

fn normalize_peers(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(50)
            .collect(),
        _ => Vec::new(),
    }
}

/// Batasi izin berkas/folder ke pemilik. Di Windows mode POSIX tidak dipakai:
/// ACL default sudah membatasi ke pengguna yang membuat berkasnya.
fn restrict_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

impl Settings {
    pub fn load(data_dir: &Path) -> Settings {
        let path = data_dir.join("settings.json");
        let raw: Value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}));

        let auto = raw.get("autoApprove").cloned().unwrap_or(Value::Null);
        let mut inner = Inner {
            auto_approve_enabled: auto
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            auto_approve_peers: normalize_peers(auto.get("peers")),
            dashboard_pin: normalize_pin(raw.get("dashboardPin")),
            access_key: normalize_access_key(raw.get("accessKey")),
            device_id: normalize_device_id(raw.get("deviceId")),
            changed: BTreeSet::new(),
        };

        // `LANDROP_ACCESS_KEY` menimpa kunci supaya skrip uji punya nilai yang
        // diketahui tanpa membaca berkas — sama seperti sisi Node.
        if let Ok(env_key) = std::env::var("LANDROP_ACCESS_KEY") {
            if inner.access_key.is_empty() {
                let normalized = normalize_access_key(Some(&Value::String(env_key)));
                if !normalized.is_empty() {
                    inner.access_key = normalized;
                    inner.changed.insert("accessKey");
                }
            }
        }
        if inner.access_key.is_empty() {
            inner.access_key = hex_random_public(24);
            inner.changed.insert("accessKey");
        }
        if inner.device_id.is_empty() {
            inner.device_id = hex_random_public(6);
            inner.changed.insert("deviceId");
        }

        let settings = Settings {
            path,
            inner: Mutex::new(inner),
        };
        if !settings.write_now() {
            // Gagal menulis bukan alasan mematikan server: nilai tetap hidup di
            // memori sampai proses berhenti (perilaku yang sama di Node).
        }
        settings
    }

    fn read_disk(&self) -> Value {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}))
    }

    fn write_now(&self) -> bool {
        let inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return false,
        };
        if inner.changed.is_empty() {
            return true;
        }
        let mut merged = self.read_disk();
        if !merged.is_object() {
            merged = json!({});
        }
        let obj = match merged.as_object_mut() {
            Some(o) => o,
            None => return false,
        };
        for key in inner.changed.iter() {
            let value = match *key {
                "accessKey" => Value::String(inner.access_key.clone()),
                "deviceId" => Value::String(inner.device_id.clone()),
                "dashboardPin" => Value::String(inner.dashboard_pin.clone()),
                "autoApprove" => json!({
                    "enabled": inner.auto_approve_enabled,
                    "peers": inner.auto_approve_peers,
                }),
                _ => continue,
            };
            obj.insert((*key).to_string(), value);
        }
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
            // Folder data memuat kunci pairing dan PIN: pemilik saja.
            restrict_mode(parent, 0o700);
        }
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string(&merged).unwrap_or_else(|_| "{}".to_string());
        if std::fs::write(&tmp, text).is_err() {
            return false;
        }
        // Kunci harus dipasang SEBELUM rename: kalau sesudah, ada jendela
        // singkat saat berkas sudah ada di namanya yang sebenarnya tapi masih
        // 0644 — dan `accessKey` di dalamnya sudah bisa dibaca.
        restrict_mode(&tmp, 0o600);
        std::fs::rename(&tmp, &self.path).is_ok()
    }

    pub fn access_key(&self) -> String {
        self.inner
            .lock()
            .map(|i| i.access_key.clone())
            .unwrap_or_default()
    }

    pub fn device_id(&self) -> String {
        self.inner
            .lock()
            .map(|i| i.device_id.clone())
            .unwrap_or_default()
    }

    pub fn dashboard_pin(&self) -> String {
        self.inner
            .lock()
            .map(|i| i.dashboard_pin.clone())
            .unwrap_or_else(|_| DEFAULT_PIN.to_string())
    }

    pub fn set_dashboard_pin(&self, value: &str) -> String {
        let next = normalize_pin(Some(&Value::String(value.to_string())));
        if let Ok(mut inner) = self.inner.lock() {
            inner.dashboard_pin = next.clone();
            inner.changed.insert("dashboardPin");
        }
        self.write_now();
        next
    }

    pub fn auto_approve(&self) -> (bool, Vec<String>) {
        self.inner
            .lock()
            .map(|i| (i.auto_approve_enabled, i.auto_approve_peers.clone()))
            .unwrap_or((false, Vec::new()))
    }

    pub fn set_auto_approve(
        &self,
        enabled: Option<bool>,
        peers: Option<Vec<String>>,
    ) -> (bool, Vec<String>) {
        let mut result = (false, Vec::new());
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(v) = enabled {
                inner.auto_approve_enabled = v;
            }
            if let Some(list) = peers {
                inner.auto_approve_peers = list
                    .into_iter()
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .take(50)
                    .collect();
            }
            inner.changed.insert("autoApprove");
            result = (inner.auto_approve_enabled, inner.auto_approve_peers.clone());
        }
        self.write_now();
        result
    }

    /// Boleh diterima otomatis dari pengirim ini?
    ///
    /// `known_ips` = alamat yang benar-benar diumumkan perangkat bernama itu
    /// lewat discovery. Nama saja tidak cukup: siapa pun bisa menyamar.
    pub fn is_auto_approve_peer<F>(
        &self,
        sender_name: &str,
        sender_ip: Option<&str>,
        known_ips: F,
    ) -> bool
    where
        F: Fn(&str) -> Vec<String>,
    {
        let (enabled, peers) = self.auto_approve();
        if !enabled {
            return false;
        }
        let name = sender_name.trim();
        let ip = sender_ip
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .trim_start_matches("::ffff:")
            .to_string();
        if peers.is_empty() {
            return true;
        }

        let normalize = |v: &str| {
            v.trim()
                .to_ascii_lowercase()
                .trim_start_matches("::ffff:")
                .to_string()
        };
        let advertised: Vec<String> = if name.is_empty() {
            Vec::new()
        } else {
            known_ips(name).into_iter().map(|a| normalize(&a)).collect()
        };

        peers.iter().any(|entry| {
            let text = entry.trim();
            match text.rfind('@') {
                None => {
                    if text != name {
                        return false;
                    }
                    if ip.is_empty() {
                        return false;
                    }
                    advertised.contains(&ip)
                }
                Some(at) => {
                    if &text[..at] != name {
                        return false;
                    }
                    normalize(&text[at + 1..]) == ip
                }
            }
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lan-drop-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `settings.json` menyimpan `accessKey` dan PIN. Dengan umask biasa (022)
    /// berkasnya 0644 — tetangga satu mesin bisa membacanya dan memakai kunci
    /// pairing itu untuk menyamar sebagai peer tepercaya.
    #[test]
    fn settings_json_tidak_bisa_dibaca_pengguna_lain() {
        let dir = temp_dir("perm");
        let settings = Settings::load(&dir);
        settings.set_dashboard_pin("4321");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("settings.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "settings.json harus 0600, bukan {mode:o}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
