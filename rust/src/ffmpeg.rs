//! Pemanggilan ffmpeg/ffprobe — padanan `server/ffmpeg.js`.
//!
//! Video butuh ffmpeg untuk dua hal: mengambil satu frame sebagai thumbnail,
//! dan mengubah container/codec yang tidak bisa diputar perangkat tujuan.
//! Keduanya opsional: kalau ffmpeg tidak ada, aplikasi tetap jalan dan berkas
//! dikirim apa adanya. Yang tidak boleh terjadi adalah "janji lalu diam" —
//! setiap kegagalan ffmpeg jatuh ke jalur asli, bukan menggantung transfer.

use std::path::Path;
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
    // `kill_on_drop`: dua jalur berakhir tanpa `wait` — timeout, dan request
    // HTTP yang dibatalkan klien (future-nya di-drop). Tanpa ini ffmpeg terus
    // berjalan memakan CPU. Sekaligus menghapus ketergantungan pada binary
    // `kill` yang tidak ada di Windows.
    let child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .ok()?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        // Future `wait_with_output` memegang child; drop di sini memicunya.
        _ => return None,
    };
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Some(stderr)
    } else {
        eprintln!(
            "[ffmpeg] gagal ({}): {}",
            output.status,
            stderr.lines().next().unwrap_or("")
        );
        None
    }
}

pub struct StreamInfo {
    pub has_real_video: bool,
    pub has_audio: bool,
}

/// Baca daftar stream. `None` kalau ffprobe tidak ada atau file-nya rusak —
/// pemanggil lalu memakai jalur "kirim apa adanya".
pub async fn probe(path: &Path) -> Option<StreamInfo> {
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
        .kill_on_drop(true)
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    /// ffmpeg palsu: menjawab `-version` (supaya dianggap ada), selain itu
    /// menulis pid-nya lalu tidur lama.
    fn fake_ffmpeg(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let script = dir.join("ffmpeg-palsu.sh");
        let pidfile = dir.join("pid.txt");
        let mut file = std::fs::File::create(&script).unwrap();
        write!(
            file,
            "#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo 'ffmpeg version 0'; exit 0; fi\necho $$ > {}\nexec sleep 30\n",
            pidfile.display()
        )
        .unwrap();
        drop(file);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (script, pidfile)
    }

    /// Klien membatalkan request HTTP sebelum ffmpeg selesai: future-nya
    /// di-drop. Tanpa `kill_on_drop`, ffmpeg terus berjalan memakan CPU sampai
    /// selesai sendiri — dan pemanggilan `kill` lewat binary tidak ada di
    /// Windows, jadi jalur timeout di sana tidak membunuh apa pun.
    #[tokio::test]
    async fn ffmpeg_dibunuh_saat_future_dibatalkan() {
        let dir = std::env::temp_dir().join(format!("lan-drop-ffmpeg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (script, pidfile) = fake_ffmpeg(&dir);
        std::env::set_var("LANDROP_FFMPEG", &script);

        let args = ["-i".to_string(), "masukan.mkv".to_string()];
        let cancelled = tokio::time::timeout(
            Duration::from_millis(400),
            run_ffmpeg(&args, Duration::from_secs(30)),
        )
        .await;
        assert!(cancelled.is_err(), "ffmpeg palsu seharusnya masih berjalan");

        let mut pid: Option<i32> = None;
        for _ in 0..40 {
            if let Ok(text) = std::fs::read_to_string(&pidfile) {
                if let Ok(value) = text.trim().parse::<i32>() {
                    pid = Some(value);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let pid = pid.expect("ffmpeg palsu tidak sempat menulis pid");

        let mut still_alive = true;
        for _ in 0..60 {
            if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                still_alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !still_alive,
            "ffmpeg (pid {pid}) masih hidup setelah future-nya di-drop"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
