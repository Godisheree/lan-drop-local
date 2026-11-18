//! Thumbnail foto/video — padanan `server/thumbnail.js`.
//!
//! Aturan yang dipertahankan:
//!   * id = `sha1(path)` 16 hex pertama, dihitung server. Path file TIDAK pernah
//!     datang dari URL, jadi tidak ada jalur untuk membaca berkas sembarang.
//!   * Hasil disimpan sebagai JPEG 480 px di cache; file asli tidak pernah
//!     dikirim utuh ke grid (dulu video 1 GB ikut dialirkan sebagai "thumbnail").
//!   * Tanpa ffmpeg: gambar yang didukung browser dikirim apa adanya (dengan
//!     batas 12 MB), video tidak punya thumbnail — UI jatuh ke ikon.
//!
//! Semua pembuatan thumbnail terjadi di `spawn_blocking`: ffmpeg bisa makan
//! detik, dan menahannya di runtime async berarti endpoint lain ikut diam.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sha1::{Digest, Sha1};

use crate::ffmpeg;
use crate::platform;

const THUMB_WIDTH: u32 = 480;
const MAX_ORIGINAL_BYTES: u64 = 12 * 1024 * 1024;
const CACHE_MAX_FILES: usize = 300;

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "webm", "3gp", "mpeg", "mpg", "ts", "flv",
];
const BROWSER_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Batas waktu satu pemanggilan ffmpeg — sama dengan `timeout: 20000` di
/// `server/thumbnail.js`.
const THUMBNAIL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub fn is_thumbnailable(name: &str) -> bool {
    matches!(platform::classify_extension(name), "photo" | "video")
}

fn is_video(path: &Path) -> bool {
    VIDEO_EXTENSIONS.contains(&ext_of(path).as_str())
}

fn is_browser_image(path: &Path) -> bool {
    BROWSER_IMAGE_EXTENSIONS.contains(&ext_of(path).as_str())
}

pub fn id_for_path(path: &Path) -> String {
    let mut hasher = Sha1::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..16].to_string()
}

fn original_content_type(path: &Path) -> &'static str {
    match ext_of(path).as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

pub struct Thumbnails {
    files: Mutex<HashMap<String, PathBuf>>,
    cache_dir: PathBuf,
}

impl Thumbnails {
    pub fn new(cache_dir: PathBuf) -> Thumbnails {
        let _ = std::fs::create_dir_all(&cache_dir);
        Thumbnails {
            files: Mutex::new(HashMap::new()),
            cache_dir,
        }
    }

    /// Daftarkan file yang baru diterima supaya bisa diambil lewat
    /// `GET /thumbnail/:id`. Kalau proses mati, thumbnail berikutnya dibuat
    /// ulang dari path yang sama saat file itu diterima lagi.
    pub fn register(&self, path: &Path) -> String {
        let id = id_for_path(path);
        if let Ok(mut files) = self.files.lock() {
            files.insert(id.clone(), path.to_path_buf());
        }
        id
    }

    fn cached(&self, id: &str) -> PathBuf {
        self.cache_dir.join(format!("{id}.jpg"))
    }

    /// `None` = id tidak dikenal atau thumbnail tidak bisa dibuat (404).
    pub async fn get(self: &Arc<Self>, id: &str) -> Option<(Vec<u8>, &'static str)> {
        let path = {
            let files = self.files.lock().ok()?;
            files.get(id)?.clone()
        };
        if !path.exists() {
            return None;
        }

        let cached = self.cached(id);
        if let Ok(bytes) = tokio::fs::read(&cached).await {
            if !bytes.is_empty() {
                return Some((bytes, "image/jpeg"));
            }
        }

        let me = self.clone();
        let job_path = path.clone();
        let job_out = cached.clone();
        let produced = tokio::task::spawn_blocking(move || me.render(&job_path, &job_out))
            .await
            .ok()?;

        match produced {
            Rendered::Jpeg => {
                let bytes = tokio::fs::read(&cached).await.ok()?;
                if bytes.is_empty() {
                    return None;
                }
                self.prune(&cached);
                Some((bytes, "image/jpeg"))
            }
            Rendered::Original(content_type) => {
                let meta = std::fs::metadata(&path).ok()?;
                if meta.len() > MAX_ORIGINAL_BYTES {
                    return None;
                }
                let bytes = tokio::fs::read(&path).await.ok()?;
                Some((bytes, content_type))
            }
            Rendered::None => None,
        }
    }

    /// Jalankan ffmpeg (blocking). Video: satu frame di detik ke-1. Gambar:
    /// diperkecil kalau ffmpeg ada, kalau tidak dikirim aslinya.
    fn render(&self, input: &Path, output: &Path) -> Rendered {
        let video = is_video(input);
        let browser_image = is_browser_image(input);

        if self.render_with_ffmpeg(input, output, video).is_some() {
            return Rendered::Jpeg;
        }

        if browser_image {
            return Rendered::Original(original_content_type(input));
        }
        Rendered::None
    }

    fn render_with_ffmpeg(&self, input: &Path, output: &Path, video: bool) -> Option<()> {
        let bin = ffmpeg::ffmpeg_path()?;
        let _ = bin;

        let mut args: Vec<String> = vec![
            "-nostdin".into(),
            "-loglevel".into(),
            "error".into(),
            // Batasi demuxer ke berkas lokal: file dari peer tidak boleh
            // menarik sumber jaringan (playlist m3u8, URL di dalam container).
            "-protocol_whitelist".into(),
            "file".into(),
        ];
        if video {
            args.push("-ss".into());
            args.push("1".into());
        }
        args.extend([
            "-i".into(),
            input.to_string_lossy().to_string(),
            "-vf".into(),
            format!("scale={THUMB_WIDTH}:-2:flags=lanczos"),
            "-frames:v".into(),
            "1".into(),
            "-q:v".into(),
            "5".into(),
            "-y".into(),
            output.to_string_lossy().to_string(),
        ]);

        // Tanpa batas waktu, ffmpeg yang menggantung menahan satu thread
        // `spawn_blocking` selamanya; beberapa berkas aneh dari peer lalu
        // `/thumbnail` berulang sudah cukup mematikan seluruh jalur thumbnail.
        let mut child = std::process::Command::new(ffmpeg::ffmpeg_path()?)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let deadline = std::time::Instant::now() + THUMBNAIL_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => {
                    let _ = child.kill();
                    return None;
                }
            }
        };
        if !status.success() {
            return None;
        }
        let meta = std::fs::metadata(output).ok()?;
        if meta.len() == 0 {
            return None;
        }
        Some(())
    }

    /// Buang thumbnail paling tua kalau cache melewati batas. Tanpa ini cache
    /// tumbuh selamanya di folder data pengguna.
    fn prune(&self, keep: &Path) {
        let Ok(entries) = std::fs::read_dir(&self.cache_dir) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if path == keep {
                    return None;
                }
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, path))
            })
            .collect();
        if files.len() < CACHE_MAX_FILES {
            return;
        }
        files.sort_by_key(|(modified, _)| *modified);
        for (_, path) in files.iter().take(files.len() - CACHE_MAX_FILES + 1) {
            let _ = std::fs::remove_file(path);
        }
    }
}

enum Rendered {
    Jpeg,
    Original(&'static str),
    None,
}
