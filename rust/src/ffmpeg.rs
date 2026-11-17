//! Pemanggilan ffmpeg/ffprobe — padanan `server/ffmpeg.js`.
//!
//! Video butuh ffmpeg untuk dua hal: mengambil satu frame sebagai thumbnail,
//! dan mengubah container/codec yang tidak bisa diputar perangkat tujuan.
//! Keduanya opsional: kalau ffmpeg tidak ada, aplikasi tetap jalan dan berkas
//! dikirim apa adanya. Yang tidak boleh terjadi adalah "janji lalu diam" —
//! setiap kegagalan ffmpeg jatuh ke jalur asli, bukan menggantung transfer.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

static FFMPEG: OnceLock<Option<String>> = OnceLock::new();

fn candidates() -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    if let Ok(custom) = std::env::var("LANDROP_FFMPEG") {
        if !custom.trim().is_empty() {
            list.push(custom);
        }
    }
    list.push("ffmpeg".to_string());
    if cfg!(windows) {
        // Pemasangan umum di Windows: winget, Program Files, atau folder rumah.
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            list.push(format!(
                "{local}\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe"
            ));
        }
        for root in ["ProgramFiles", "ProgramW6432"] {
            if let Ok(base) = std::env::var(root) {
                list.push(format!("{base}\\ffmpeg\\bin\\ffmpeg.exe"));
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            list.push(format!("{home}\\ffmpeg\\bin\\ffmpeg.exe"));
        }
    }
    list
}

/// Path ffmpeg, atau `None` kalau tidak ada di mesin ini. Di-cache: satu
/// pemanggilan `ffmpeg -version` per proses, bukan per thumbnail.
pub fn ffmpeg_path() -> Option<&'static str> {
    FFMPEG
        .get_or_init(|| {
            for candidate in candidates() {
                match std::process::Command::new(&candidate)
                    .arg("-version")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                {
                    Ok(status) if status.success() => return Some(candidate),
                    _ => continue,
                }
            }
            None
        })
        .as_deref()
}

/// ffprobe ditebak dari lokasi ffmpeg (satu paket), jatuh ke PATH.
fn ffprobe_path() -> String {
    match ffmpeg_path() {
        Some(path) => path
            .replace("ffmpeg.exe", "ffprobe.exe")
            .replace("ffmpeg", "ffprobe"),
        None => "ffprobe".to_string(),
    }
}

/// Jalankan ffmpeg dan tunggu hasilnya. `None` = gagal/timeout.
pub async fn run_ffmpeg(args: &[String], timeout: Duration) -> Option<String> {
    let bin = ffmpeg_path()?.to_string();
    let child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let pid = child.id();
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        _ => {
            // Timeout: proses ffmpeg yang menggantung harus dibunuh, kalau
            // tidak dia terus memakan CPU setelah transfernya dibatalkan.
            if let Some(pid) = pid {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .status();
            }
            return None;
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Some(stderr)
    } else {
        eprintln!("[ffmpeg] gagal ({}): {}", output.status, stderr.lines().next().unwrap_or(""));
        None
    }
}

pub struct StreamInfo {
    pub has_real_video: bool,
    pub has_audio: bool,
}

/// Baca daftar stream. `None` kalau ffprobe tidak ada atau file-nya rusak —
/// pemanggil lalu memakai jalur "kirim apa adanya".
pub async fn probe(path: &PathBuf) -> Option<StreamInfo> {
    let bin = ffprobe_path();
    let child = tokio::process::Command::new(bin)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            path.to_string_lossy().as_ref(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).ok()?;
    let streams = parsed.get("streams")?.as_array()?;
    let mut has_real_video = false;
    let mut has_audio = false;
    for stream in streams {
        match stream.get("codec_type").and_then(|v| v.as_str()) {
            Some("video") => {
                let attached = stream
                    .get("disposition")
                    .and_then(|d| d.get("attached_pic"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                if attached != 1 {
                    has_real_video = true;
                }
            }
            Some("audio") => has_audio = true,
            _ => {}
        }
    }
    Some(StreamInfo {
        has_real_video,
        has_audio,
    })
}
