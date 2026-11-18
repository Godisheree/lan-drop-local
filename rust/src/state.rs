//! State bersama. Semua modul memegang `Arc<AppState>`; tidak ada variabel
//! global yang bisa ditulis dari mana saja.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::discovery::Discovery;
use crate::history::History;
use crate::logbus::LogBus;
use crate::pin::Pin;
use crate::ports::Ports;
use crate::security::RateLimiter;
use crate::settings::Settings;
use crate::thumbnail::Thumbnails;
use crate::transfer::Transfers;

pub struct AppState {
    pub settings: Arc<Settings>,
    pub pin: Arc<Pin>,
    pub logbus: Arc<LogBus>,
    pub history: Arc<History>,
    pub thumbnails: Arc<Thumbnails>,
    pub transfers: Arc<Transfers>,
    pub discovery: Arc<Discovery>,
    pub ports: Arc<Ports>,

    pub device_name: String,
    pub version: String,
    pub commit: Option<String>,

    pub data_dir: PathBuf,
    pub save_dir: PathBuf,
    pub upload_dir: PathBuf,
    pub public_dir: PathBuf,

    pub started: Instant,
    pub started_at_ms: u128,

    pub limiter_transfer: RateLimiter,
    pub limiter_pin: RateLimiter,
    pub limiter_destructive: RateLimiter,
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        settings: Arc<Settings>,
        pin: Arc<Pin>,
        logbus: Arc<LogBus>,
        history: Arc<History>,
        thumbnails: Arc<Thumbnails>,
        transfers: Arc<Transfers>,
        discovery: Arc<Discovery>,
        ports: Arc<Ports>,
    ) -> AppState {
        AppState {
            settings,
            pin,
            logbus,
            history,
            thumbnails,
            transfers,
            discovery,
            ports,
            device_name: crate::platform::device_name(),
            version: crate::platform::version(),
            commit: crate::platform::commit(),
            data_dir: crate::platform::data_dir(),
            save_dir: crate::platform::save_dir_root(),
            upload_dir: crate::platform::upload_dir(),
            public_dir: crate::repo::public_dir(),
            started: Instant::now(),
            started_at_ms: now_ms(),
            // Batas yang sama dengan Node: transfer longgar (batch 50 file),
            // PIN ketat (6 angka = 1 juta kemungkinan), aksi destruktif ketat.
            limiter_transfer: RateLimiter::new(
                Duration::from_secs(60),
                1200,
                "Terlalu banyak permintaan. Coba lagi sebentar.",
            ),
            limiter_pin: RateLimiter::new(
                Duration::from_secs(60),
                10,
                "Terlalu banyak percobaan PIN. Tunggu sebentar.",
            ),
            limiter_destructive: RateLimiter::new(
                Duration::from_secs(60),
                20,
                "Terlalu banyak permintaan. Coba lagi sebentar.",
            ),
        }
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    pub fn access_key(&self) -> String {
        self.settings.access_key()
    }

    /// Tulis satu baris ke ring buffer yang dibaca dashboard (`GET /logs`).
    ///
    /// Server ini tidak punya logger global: kalau setiap modul mencetak ke
    /// stdout sendiri, dashboard tidak pernah melihat apa pun. Titik-titik
    /// penting (terima/kirim/putus/gagal) memanggil ini supaya halaman pantau
    /// punya isi nyata, bukan array kosong.
    pub fn log(&self, level: &str, text: impl Into<String>) {
        self.logbus.record(level, text);
    }
}
