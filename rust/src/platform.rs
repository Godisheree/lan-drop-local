//! Env, direktori, dan identitas mesin — padanan `server/platform.js`.
//!
//! Aturan yang dipegang: nilai yang bisa diatur lewat env harus dibaca di satu
//! tempat ini saja, supaya dua implementasi (Node & Rust) tidak pernah
//! menafsirkan env yang sama dengan cara berbeda.

use std::path::{Path, PathBuf};

fn home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub fn is_windows() -> bool {
    cfg!(windows)
}

pub fn data_dir() -> PathBuf {
    if let Some(v) = env_nonempty("LANDROP_DATA_DIR") {
        return PathBuf::from(v);
    }
    if is_windows() {
        if let Some(appdata) = env_nonempty("APPDATA") {
            return PathBuf::from(appdata).join("lan-drop");
        }
        return home().join("AppData").join("Roaming").join("lan-drop");
    }
    home().join(".lan-drop")
}

pub fn upload_dir() -> PathBuf {
    if let Some(v) = env_nonempty("LANDROP_UPLOAD_DIR") {
        return PathBuf::from(v);
    }
    data_dir().join("uploads")
}

/// Folder simpan tingkat atas (tanpa subfolder kategori).
pub fn save_dir_root() -> PathBuf {
    if let Some(v) = env_nonempty("LANDROP_SAVE_DIR") {
        return PathBuf::from(v);
    }
    home().join("Downloads").join("LAN-DROP")
}

pub fn save_category(category: &str) -> Option<&'static str> {
    match category {
        "photo" => Some("Pictures"),
        "video" => Some("Videos"),
        "doc" => Some("Documents"),
        "audio" => Some("Music"),
        _ => None,
    }
}

pub fn classify_extension(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    const PHOTO: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"];
    const VIDEO: [&str; 8] = ["mp4", "mov", "mkv", "avi", "webm", "3gp", "mpeg", "mpg"];
    const AUDIO: [&str; 8] = ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus"];
    const DOC: [&str; 13] = [
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt", "",
    ];
    if PHOTO.contains(&ext.as_str()) {
        "photo"
    } else if VIDEO.contains(&ext.as_str()) {
        "video"
    } else if AUDIO.contains(&ext.as_str()) {
        "audio"
    } else if DOC[..12].contains(&ext.as_str()) {
        "doc"
    } else {
        "other"
    }
}

pub fn hostname() -> String {
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if !name.trim().is_empty() {
            return name;
        }
    }
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "LAN DROP".to_string())
}

/// Nama perangkat: `DEVICE_NAME` menang, lalu hostname, lalu "Android".
pub fn device_name() -> String {
    if let Some(v) = env_nonempty("DEVICE_NAME") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let host = hostname();
    let host = host.trim();
    if host.is_empty() || host.eq_ignore_ascii_case("localhost") || host == "localhost.localdomain"
    {
        "Android".to_string()
    } else {
        host.to_string()
    }
}

/// Semua alamat IP milik mesin ini (dipakai `isSelfTarget` dan `hostGuard`).
pub fn own_addresses() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            out.push(iface.ip().to_string());
        }
    }
    out
}

/// Interface LAN beserta alamat broadcast-nya: `(nama, ip, broadcast)`.
///
/// Broadcast dihitung dari prefix, bukan `255.255.255.255`: alamat terakhir
/// memakai default route, dan kalau VPN/Tailscale mengambil alih default route
/// paket announce tidak pernah sampai ke tetangga Wi-Fi.
/// Interface yang bukan jalur LAN sesungguhnya — nama di-lowercase, dicek
/// substring, sama persis dengan daftar di `server/platform.js`.
const VIRTUAL_IFACE_HINTS: &[&str] = &[
    "vmware",
    "virtualbox",
    "docker",
    "vethernet",
    "warp",
    "tailscale",
];
const WIFI_IFACE_HINTS: &[&str] = &["wl", "wifi", "wlan", "en0"];

fn is_virtual_iface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    VIRTUAL_IFACE_HINTS.iter().any(|hint| lower.contains(hint))
}

fn is_wifi_iface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    WIFI_IFACE_HINTS.iter().any(|hint| lower.contains(hint))
}

/// IPv4 yang layak dipakai sebagai alamat peer LAN: (nama, ip, broadcast).
///
/// Urutannya WiFi dulu, sama seperti Node — `/me` menampilkan daftar ini apa
/// adanya, dan QR pairing mengambil entri pertama. Aturan buangnya juga harus
/// sama: alamat point-to-point (`wg0`, netmask /32) bukan jalur LAN, dan
/// alamat Tailscale (100.64/10) ditampilkan terpisah di panel Sambung.
pub fn lan_interfaces() -> Vec<(String, String, String)> {
    use std::net::Ipv4Addr;

    let mut out: Vec<(String, String, String)> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            let name = iface.name.clone();
            if is_virtual_iface(&name) || name == "lo" {
                continue;
            }
            let if_addrs::IfAddr::V4(v4) = iface.addr else {
                continue;
            };
            if v4.ip.is_loopback() || v4.ip.is_link_local() {
                continue;
            }
            // Alamat Tailscale bukan alamat LAN — muncul terpisah sebagai
            // entri "Tailscale" di `/me`.
            if is_tailscale_ipv4(&v4.ip.to_string()) {
                continue;
            }
            let mask = u32::from(v4.netmask);
            if mask == u32::MAX {
                // Point-to-point (WireGuard): broadcast tidak berarti apa-apa.
                continue;
            }
            let broadcast = Ipv4Addr::from(u32::from(v4.ip) | !mask);
            out.push((name, v4.ip.to_string(), broadcast.to_string()));
        }
    }
    out.sort_by_key(|(name, _, _)| if is_wifi_iface(name) { 0 } else { 1 });
    out
}

/// Alamat CGNAT Tailscale (100.64.0.0/10).
pub fn is_tailscale_ipv4(address: &str) -> bool {
    let mut parts = address.split('.');
    let (Some(a), Some(b)) = (parts.next(), parts.next()) else {
        return false;
    };
    match (a.parse::<u16>(), b.parse::<u16>()) {
        (Ok(a), Ok(b)) => a == 100 && (64..128).contains(&b),
        _ => false,
    }
}

pub fn max_upload_mb() -> u64 {
    env_nonempty("LANDROP_MAX_UPLOAD_MB")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(2048)
}

/// Ruang bebas di folder simpan; `None` kalau tidak bisa diukur (sama seperti
/// Node: pemanggil lalu membalas 501).
pub fn free_space(target: &Path) -> Option<u64> {
    let mut probe = target.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => return None,
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(probe.as_os_str().as_bytes()).ok()?;
        // SAFETY: statvfs hanya menulis ke struct yang kita sediakan, dan path
        // dijamin NUL-terminated oleh CString.
        unsafe {
            let mut stat: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(c_path.as_ptr(), &mut stat) != 0 {
                return None;
            }
            Some((stat.f_bavail as u64).saturating_mul(stat.f_bsize as u64))
        }
    }
    #[cfg(not(unix))]
    {
        None
    }
}

pub fn version() -> String {
    crate::repo::read_package_version().unwrap_or_else(|| "0.0.0".to_string())
}

pub fn commit() -> Option<String> {
    crate::repo::read_commit()
}
