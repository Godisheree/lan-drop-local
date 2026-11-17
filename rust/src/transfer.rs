//! Transfer TCP — padanan `server/transfer.js`.
//!
//! Kontrak kabel sama persis dengan versi Node:
//!   handshake  : frame JSON `transfer-request`
//!   balasan    : frame JSON `transfer-response` (accepted, resumeOffset)
//!   metadata   : frame JSON `file-start` / `text`
//!   isi        : byte mentah sampai ukuran yang dijanjikan
//!   penutup    : frame `transfer-saved` / `transfer-save-failed` / `text-saved`
//!
//! Yang berbeda hanya mesinnya, bukan janjinya: satu task per koneksi, jadi
//! urutan baca-tulis jelas dan tidak ada handler yang saling menimpa. Aturan
//! keamanan tetap sama dengan Node — partial disimpan saat koneksi putus,
//! hanya pembatalan eksplisit yang menghapusnya, dan file kecil yang tiba
//! lengkap dalam satu paket tetap difinalisasi (dulu hilang tanpa pesan).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::platform;
use crate::protocol::{self, MAX_TEXT_BYTES};
use crate::state::{now_ms, AppState};

const PART_SUFFIX: &str = ".landrop-part";
const RESUME_TTL: u128 = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TTL: u128 = 7 * 24 * 60 * 60 * 1000;
const TRANSFER_RETENTION: u128 = 10 * 60 * 1000;
const TEXT_TTL: u128 = 10 * 60 * 1000;
const MAX_PORT_TRIES: u16 = 10;
const IO_TIMEOUT: Duration = Duration::from_secs(protocol::CONNECTION_IDLE_TIMEOUT_SECS);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

// ===================== Entri state =====================

struct PendingEntry {
    file_name: String,
    file_size: u64,
    sender_name: String,
    sender_id: String,
    batch_id: Option<Value>,
    kind: String,
    resume_offset: u64,
    status: String,
    created_at: u128,
    auto: bool,
    reject_message: Option<String>,
    decision: Option<oneshot::Sender<bool>>,
    cancel: Arc<AtomicBool>,
}

struct OutgoingEntry {
    socket: Option<TcpStream>,
    status: String,
    target_ip: String,
    file_name: String,
    file_size: u64,
    peer_name: Option<String>,
    created_at: u128,
    resume_offset: u64,
    reject_message: Option<String>,
    cancelled_by_user: bool,
    ended_at: Option<u128>,
}

struct Progress {
    file_name: String,
    file_size: u64,
    bytes_transferred: u64,
    status: String,
    save_path: Option<String>,
    saved_to: Option<String>,
    thumbnail_id: Option<String>,
    reason: Option<String>,
    resumed: bool,
    ended_at: Option<u128>,
}

#[derive(Default)]
pub struct Transfers {
    pending: Mutex<HashMap<String, PendingEntry>>,
    outgoing: Mutex<HashMap<String, OutgoingEntry>>,
    progress: Mutex<HashMap<String, Progress>>,
    texts: Mutex<Vec<Value>>,
}

fn terminal(status: &str) -> bool {
    !matches!(status, "pending" | "accepted" | "transferring")
}

fn random_id() -> String {
    crate::settings::hex_random_public(4)
}

// ===================== Nama & path file =====================

/// Nama file aman buat filesystem (karakter terlarang Windows, titik di ujung).
pub fn sanitize_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("file");
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']).trim().to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "file".to_string();
    }
    trimmed.chars().take(200).collect()
}

/// Klaim nama tujuan secara atomik: `create_new` pada file `.part`.
///
/// Dua pengirim dengan nama sama yang datang bersamaan tidak boleh memilih
/// kandidat yang sama — yang kalah dapat `EEXIST` dan lanjut ke nomor
/// berikutnya.
fn claim_part_path(save_dir: &Path, safe_name: &str) -> Option<(PathBuf, PathBuf)> {
    let safe_name = sanitize_file_name(safe_name);
    let path = Path::new(&safe_name);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let base = path
        .file_stem()
        .and_then(|e| e.to_str())
        .unwrap_or("file")
        .to_string();

    for i in 0..10_000u32 {
        let name = if i == 0 {
            safe_name.clone()
        } else {
            format!("{base} ({i}){ext}")
        };
        let final_path = save_dir.join(&name);
        if final_path.exists() {
            continue;
        }
        let part_path = PathBuf::from(format!("{}{PART_SUFFIX}", final_path.display()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
        {
            Ok(_) => return Some((final_path, part_path)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

fn parts_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("parts")
}

fn part_meta_path(state: &AppState, key: &str) -> PathBuf {
    parts_dir(state).join(format!("{key}.json"))
}

fn read_part_meta(state: &AppState, key: &str) -> Option<Value> {
    let text = std::fs::read_to_string(part_meta_path(state, key)).ok()?;
    let meta: Value = serde_json::from_str(&text).ok()?;
    let updated = meta.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0) as u128;
    if now_ms().saturating_sub(updated) > RESUME_TTL {
        return None;
    }
    Some(meta)
}

#[allow(clippy::too_many_arguments)]
fn write_part_meta(
    state: &AppState,
    key: &str,
    save_dir: &Path,
    part_path: &Path,
    final_path: &Path,
    file_name: &str,
    actual_file_name: &str,
    actual_file_size: u64,
    bytes_written: u64,
) {
    let _ = std::fs::create_dir_all(parts_dir(state));
    let payload = json!({
        "saveDir": save_dir.to_string_lossy(),
        "partPath": part_path.to_string_lossy(),
        "finalPath": final_path.to_string_lossy(),
        "fileName": file_name,
        "actualFileName": actual_file_name,
        "actualFileSize": actual_file_size,
        "bytesWritten": bytes_written,
        "updatedAt": now_ms() as u64,
    });
    let target = part_meta_path(state, key);
    let tmp = PathBuf::from(format!("{}.tmp", target.display()));
    if std::fs::write(&tmp, payload.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &target);
    }
}

fn delete_part_meta(state: &AppState, key: &str) {
    let _ = std::fs::remove_file(part_meta_path(state, key));
}

/// Folder tujuan per file: override env berlaku di semua platform, selain itu
/// subfolder kategori di bawah folder simpan (Pictures/Videos/Documents/Music).
pub fn resolve_save_dir(state: &AppState, safe_name: &str) -> PathBuf {
    if let Ok(dir) = std::env::var("LANDROP_SAVE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let category = platform::classify_extension(safe_name);
    match platform::save_category(category) {
        Some(sub) => state.save_dir.join(sub),
        None => state.save_dir.join("Downloads"),
    }
}

fn is_save_fallback(state: &AppState, dir: &Path) -> bool {
    dir == state.data_dir.join("downloads")
}

/// Path file yang dikirim WAJIB di dalam folder upload. Tanpa ini
/// `/transfer/send-file` bisa dipakai membaca file apa pun di disk.
pub fn assert_inside_uploads(state: &AppState, file_path: &str) -> Result<PathBuf, String> {
    let root = state.upload_dir.clone();
    let resolved = std::path::absolute(Path::new(file_path)).map_err(|_| "Invalid file path".to_string())?;
    let root_abs = std::path::absolute(&root).unwrap_or(root.clone());
    let inside = |base: &Path, target: &Path| -> bool {
        match (std::fs::canonicalize(base), std::fs::canonicalize(target)) {
            (Ok(b), Ok(t)) => t != b && t.starts_with(&b),
            _ => target != base && target.starts_with(base),
        }
    };
    if resolved == root_abs || !inside(&root_abs, &resolved) {
        return Err("Invalid file path: outside the upload folder".to_string());
    }
    Ok(resolved)
}

/// Buang upload & partial yang sudah kedaluwarsa.
fn cleanup_stale(state: &AppState) {
    let now = now_ms();
    if let Ok(entries) = std::fs::read_dir(&state.upload_dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let age = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| now.saturating_sub(d.as_millis()))
                .unwrap_or(0);
            if age > UPLOAD_TTL {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(parts_dir(state)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let updated = meta.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0) as u128;
            if now.saturating_sub(updated) > RESUME_TTL {
                if let Some(part) = meta.get("partPath").and_then(|v| v.as_str()) {
                    let _ = std::fs::remove_file(part);
                }
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

// ===================== Frame IO =====================

async fn read_frame(
    stream: &mut TcpStream,
    buffered: &mut Vec<u8>,
    timeout: Duration,
) -> Result<Option<Value>, String> {
    loop {
        if buffered.len() >= 4 {
            let len = u32::from_be_bytes(buffered[..4].try_into().unwrap()) as usize;
            if len > protocol::MAX_FRAME_BYTES {
                return Err(format!(
                    "Frame too large: {len} bytes (max {})",
                    protocol::MAX_FRAME_BYTES
                ));
            }
            if buffered.len() >= 4 + len {
                let payload: Vec<u8> = buffered[4..4 + len].to_vec();
                buffered.drain(..4 + len);
                return Ok(Some(serde_json::from_slice(&payload).unwrap_or(Value::Null)));
            }
        }
        let mut chunk = [0u8; 16 * 1024];
        let n = match tokio::time::timeout(timeout, stream.read(&mut chunk)).await {
            Err(_) => return Err("idle".to_string()),
            Ok(Err(err)) => return Err(err.to_string()),
            Ok(Ok(0)) => return Ok(None),
            Ok(Ok(n)) => n,
        };
        buffered.extend_from_slice(&chunk[..n]);
    }
}

/// Ambil tepat `count` byte isi; sisa buffer dari frame sebelumnya ikut dipakai.
async fn stream_body<F>(
    stream: &mut TcpStream,
    buffered: &mut Vec<u8>,
    count: u64,
    mut on_chunk: F,
) -> Result<u64, String>
where
    F: FnMut(&[u8]) -> Result<(), String>,
{
    let mut written: u64 = 0;
    if !buffered.is_empty() && count > 0 {
        let take = std::cmp::min(buffered.len() as u64, count) as usize;
        let chunk: Vec<u8> = buffered.drain(..take).collect();
        on_chunk(&chunk)?;
        written += take as u64;
    }
    let mut chunk = vec![0u8; 64 * 1024];
    while written < count {
        let want = std::cmp::min(chunk.len() as u64, count - written) as usize;
        let n = match tokio::time::timeout(IO_TIMEOUT, stream.read(&mut chunk[..want])).await {
            Err(_) => break, // idle: diperlakukan sebagai putus, bukan error fatal
            Ok(Err(_)) => break,
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => n,
        };
        on_chunk(&chunk[..n])?;
        written += n as u64;
    }
    Ok(written)
}

async fn send_frame(stream: &mut TcpStream, value: &Value) -> bool {
    let bytes = protocol::framed(value);
    stream.write_all(&bytes).await.is_ok()
}

// ===================== Penerima =====================

fn is_trusted_source(state: &AppState, address: Option<&str>) -> bool {
    let Some(addr) = address else { return false };
    let normalized = addr.trim_start_matches("::ffff:").split('%').next().unwrap_or(addr);
    if normalized.is_empty() {
        return false;
    }
    if normalized == "::1" || normalized == "::" || normalized.starts_with("127.") {
        return true;
    }
    state.discovery.is_known_peer_address(normalized)
}

fn decide_auto_accept(
    state: &AppState,
    msg: &Value,
    resume_offset: u64,
    sender_ip: Option<&str>,
) -> (bool, Option<String>) {
    let sender_name = msg.get("senderName").and_then(|v| v.as_str()).unwrap_or("");
    let allowed = state
        .settings
        .is_auto_approve_peer(sender_name, sender_ip, |name| {
            state.discovery.known_ips_for_name(name)
        });
    if !allowed {
        return (false, None);
    }

    let size = msg.get("fileSize").and_then(|v| v.as_u64()).unwrap_or(0);
    if size == 0 {
        return (false, Some("Ukuran file tidak diketahui, terima otomatis dilewati".to_string()));
    }
    let free = platform::free_space(&state.save_dir);
    let Some(free) = free else {
        return (
            false,
            Some("Penerima tidak bisa memeriksa ruang disk, kiriman otomatis dilewati".to_string()),
        );
    };
    let remaining = size.saturating_sub(resume_offset);
    if remaining > free {
        return (false, Some("Ruang disk penerima tidak cukup untuk terima otomatis".to_string()));
    }
    (true, None)
}

async fn handle_incoming(state: Arc<AppState>, mut stream: TcpStream) {
    let peer_ip = stream
        .peer_addr()
        .ok()
        .map(|a| a.ip().to_string());
    let mut buffered: Vec<u8> = Vec::new();

    let msg = match read_frame(&mut stream, &mut buffered, IO_TIMEOUT).await {
        Ok(Some(v)) => v,
        _ => return,
    };
    if msg.get("type").and_then(|v| v.as_str()) != Some("transfer-request") {
        return;
    }

    let request_id = random_id();
    let kind = msg
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_string();
    let file_name = msg
        .get("fileName")
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_string();
    let file_size = msg.get("fileSize").and_then(|v| v.as_u64()).unwrap_or(0);
    let sender_name = msg
        .get("senderName")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    let sender_id = msg
        .get("senderId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let resume_id = msg
        .get("resumeId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let batch_id = msg.get("batchId").cloned();

    // Key resume: identitas stabil satu file dari satu pengirim. Tanpa
    // senderId+resumeId, dua file berbeda yang kebetulan bernama dan berukuran
    // sama akan disambung jadi satu.
    let transfer_key = if kind == "text" {
        None
    } else {
        Some(protocol::make_transfer_key(
            &sender_id, &resume_id, &file_name, file_size,
        ))
    };

    let mut resume_offset = 0u64;
    if let Some(key) = &transfer_key {
        if let Some(meta) = read_part_meta(&state, key) {
            let bytes_written = meta.get("bytesWritten").and_then(|v| v.as_u64()).unwrap_or(0);
            if bytes_written > 0 {
                if let Some(part) = meta.get("partPath").and_then(|v| v.as_str()) {
                    if let Ok(st) = std::fs::metadata(part) {
                        resume_offset = std::cmp::min(bytes_written, st.len());
                    }
                }
            }
        }
    }

    let known_sender = is_trusted_source(&state, peer_ip.as_deref());
    let (tx, rx) = oneshot::channel::<bool>();
    let cancel = Arc::new(AtomicBool::new(false));

    {
        let mut pending = match state.transfers.pending.lock() {
            Ok(p) => p,
            Err(_) => return,
        };
        pending.insert(
            request_id.clone(),
            PendingEntry {
                file_name: file_name.clone(),
                file_size,
                sender_name: sender_name.clone(),
                sender_id,
                batch_id,
                kind: kind.clone(),
                resume_offset,
                status: "pending".to_string(),
                created_at: now_ms(),
                auto: false,
                reject_message: None,
                decision: Some(tx),
                cancel: cancel.clone(),
            },
        );
    }
    println!(
        "[Transfer] Incoming request {request_id}: {file_name} ({file_size} bytes) from {sender_name}"
    );

    if kind == "text" {
        if known_sender {
            state.transfers.respond(&state, &request_id, true, None).ok();
        } else {
            println!(
                "[Transfer] text from unknown {} — queued for approval",
                peer_ip.clone().unwrap_or_default()
            );
        }
    } else if known_sender {
        let (accept, reason) = decide_auto_accept(&state, &msg, resume_offset, peer_ip.as_deref());
        if accept {
            if let Ok(mut pending) = state.transfers.pending.lock() {
                if let Some(entry) = pending.get_mut(&request_id) {
                    entry.auto = true;
                }
            }
            println!("[Transfer] {request_id} accepted automatically from {sender_name}");
            state.transfers.respond(&state, &request_id, true, None).ok();
        } else if let Some(reason) = reason {
            println!("[Transfer] {request_id} not auto-accepted: {reason}");
            state.transfers.respond(&state, &request_id, false, Some(reason)).ok();
        }
    }

    let accepted = match tokio::time::timeout(IO_TIMEOUT, rx).await {
        Ok(Ok(v)) => v,
        _ => {
            if let Ok(mut pending) = state.transfers.pending.lock() {
                pending.remove(&request_id);
            }
            let _ = stream.shutdown().await;
            return;
        }
    };

    if accepted {
        let _ = send_frame(
            &mut stream,
            &json!({
                "type": "transfer-response",
                "accepted": true,
                "resumeOffset": resume_offset,
            }),
        )
        .await;
    } else {
        let message = state
            .transfers
            .take_reject_message(&request_id)
            .unwrap_or_else(|| "Ditolak oleh penerima".to_string());
        let _ = send_frame(
            &mut stream,
            &json!({
                "type": "transfer-response",
                "accepted": false,
                "message": message,
            }),
        )
        .await;
        let _ = stream.shutdown().await;
        if let Ok(mut pending) = state.transfers.pending.lock() {
            pending.remove(&request_id);
        }
        return;
    }

    let meta = match read_frame(&mut stream, &mut buffered, IO_TIMEOUT).await {
        Ok(Some(v)) => v,
        _ => {
            if let Ok(mut pending) = state.transfers.pending.lock() {
                pending.remove(&request_id);
            }
            let _ = stream.shutdown().await;
            return;
        }
    };
    let meta_type = meta.get("type").and_then(|v| v.as_str()).unwrap_or("");

    if meta_type == "text" {
        receive_text(
            &state,
            &mut stream,
            &mut buffered,
            &request_id,
            &meta,
            &sender_name,
            peer_ip.as_deref(),
        )
        .await;
        if let Ok(mut pending) = state.transfers.pending.lock() {
            pending.remove(&request_id);
        }
        let _ = stream.shutdown().await;
        return;
    }

    if meta_type != "file-start" {
        if let Ok(mut pending) = state.transfers.pending.lock() {
            pending.remove(&request_id);
        }
        let _ = stream.shutdown().await;
        return;
    }

    receive_file(
        &state,
        &mut stream,
        &mut buffered,
        &request_id,
        &meta,
        &file_name,
        &sender_name,
        transfer_key.clone(),
        &cancel,
    )
    .await;

    if let Ok(mut pending) = state.transfers.pending.lock() {
        pending.remove(&request_id);
    }
    let _ = stream.shutdown().await;
}

async fn receive_text(
    state: &AppState,
    stream: &mut TcpStream,
    buffered: &mut Vec<u8>,
    request_id: &str,
    meta: &Value,
    sender_name: &str,
    sender_ip: Option<&str>,
) {
    // Panjang teks adalah KLAIM pengirim; tanpa batas, satu frame tanpa
    // `length` bisa menahan RAM penerima sampai socket ditutup.
    let claimed = meta.get("length").and_then(|v| v.as_i64()).unwrap_or(-1);
    if claimed < 0 || claimed as usize > MAX_TEXT_BYTES {
        println!(
            "[Transfer] text {request_id} rejected: implausible length {}",
            meta.get("length").cloned().unwrap_or(Value::Null)
        );
        return;
    }
    let length = claimed as u64;
    let mut data: Vec<u8> = Vec::with_capacity(length as usize);
    let written = stream_body(stream, buffered, length, |chunk| {
        data.extend_from_slice(chunk);
        Ok(())
    })
    .await
    .unwrap_or(0);
    if written < length {
        println!("[Transfer] text {request_id} incomplete ({written}/{length}) — dropped");
        return;
    }

    let text = String::from_utf8_lossy(&data).to_string();
    // senderIp ikut disimpan: nama pengirim cuma klaim, alamat IP-nya fakta.
    state.transfers.push_text(json!({
        "id": request_id,
        "senderName": sender_name,
        "senderIp": sender_ip,
        "text": text,
        "timestamp": now_ms() as u64,
    }));
    state.transfers.set_progress(
        request_id,
        Progress {
            file_name: "Teks".to_string(),
            file_size: length,
            bytes_transferred: length,
            status: "completed".to_string(),
            save_path: None,
            saved_to: None,
            thumbnail_id: None,
            reason: None,
            resumed: false,
            ended_at: Some(now_ms()),
        },
    );
    state.history.add(json!({
        "direction": "receive",
        "fileName": "Teks",
        "fileSize": 0,
        "peer": sender_name,
        "status": "completed",
    }));
    println!(
        "[Transfer] ✅ {request_id} — text received ({} chars) from {sender_name}",
        text.chars().count()
    );

    state.log("info", format!("teks dari {sender_name} diterima"));
    // ACK eksplisit: satu-satunya bukti teksnya benar-benar mendarat.
    let _ = send_frame(stream, &json!({"type": "text-saved", "length": length})).await;
}

async fn receive_file(
    state: &AppState,
    stream: &mut TcpStream,
    buffered: &mut Vec<u8>,
    request_id: &str,
    meta: &Value,
    requested_name: &str,
    sender_name: &str,
    transfer_key: Option<String>,
    cancel: &Arc<AtomicBool>,
) {
    let actual_size = meta.get("fileSize").and_then(|v| v.as_u64()).unwrap_or(0);
    if actual_size == 0 {
        println!("[Transfer] {request_id} — implausible file size, transfer dibatalkan");
        return;
    }
    let safe_name = sanitize_file_name(
        meta.get("fileName")
            .and_then(|v| v.as_str())
            .unwrap_or(requested_name),
    );

    let mut save_dir = resolve_save_dir(state, &safe_name);
    if std::fs::create_dir_all(&save_dir).is_err() {
        println!(
            "[Transfer] Destination folder {} could not be created — falling back to the internal folder",
            save_dir.display()
        );
        save_dir = state.data_dir.join("downloads");
        let _ = std::fs::create_dir_all(&save_dir);
    }
    let save_fallback = is_save_fallback(state, &save_dir);

    let key = transfer_key.unwrap_or_else(|| {
        protocol::make_transfer_key("", "", &safe_name, actual_size)
    });

    let mut display_name = safe_name.clone();
    let mut final_path = save_dir.join(&display_name);
    let mut part_path = PathBuf::from(format!("{}{PART_SUFFIX}", final_path.display()));

    // Resume: hanya menyambung kalau identitas file sama (jumlah byte yang
    // dijanjikan sama dengan partial yang tercatat).
    let mut start_bytes: u64 = 0;
    if let Some(part_meta) = read_part_meta(state, &key) {
        let meta_size = part_meta
            .get("actualFileSize")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if meta_size == actual_size {
            if let Some(recorded) = part_meta.get("partPath").and_then(|v| v.as_str()) {
                if let Ok(st) = std::fs::metadata(recorded) {
                    start_bytes = std::cmp::min(
                        part_meta.get("bytesWritten").and_then(|v| v.as_u64()).unwrap_or(0),
                        st.len(),
                    );
                    if start_bytes > 0 {
                        part_path = PathBuf::from(recorded);
                        if let Some(final_recorded) = part_meta.get("finalPath").and_then(|v| v.as_str()) {
                            final_path = PathBuf::from(final_recorded);
                        }
                        if let Some(name) = part_meta.get("actualFileName").and_then(|v| v.as_str()) {
                            display_name = name.to_string();
                        }
                        if st.len() != start_bytes {
                            let _ = std::fs::OpenOptions::new()
                                .write(true)
                                .open(&part_path)
                                .and_then(|f| f.set_len(start_bytes));
                        }
                        println!(
                            "[Transfer] {request_id} — RESUMING from byte {start_bytes}/{actual_size}"
                        );
                    }
                }
            }
        }
    }

    if start_bytes == 0 {
        match claim_part_path(&save_dir, &safe_name) {
            Some((claimed_final, claimed_part)) => {
                final_path = claimed_final;
                display_name = final_path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or(&safe_name)
                    .to_string();
                part_path = claimed_part;
            }
            None => {
                println!(
                    "[Transfer] {request_id} — could not claim a file name in {}, transfer aborted",
                    save_dir.display()
                );
                return;
            }
        }
    }

    state.transfers.set_progress(
        request_id,
        Progress {
            file_name: display_name.clone(),
            file_size: actual_size,
            bytes_transferred: start_bytes,
            status: "transferring".to_string(),
            save_path: Some(final_path.to_string_lossy().to_string()),
            saved_to: None,
            thumbnail_id: None,
            reason: None,
            resumed: start_bytes > 0,
            ended_at: None,
        },
    );

    // Guard ruang disk dengan ukuran NYATA. Gagal ukur = jangan menebak.
    let remaining = actual_size.saturating_sub(start_bytes);
    match platform::free_space(&save_dir) {
        Some(free) if remaining <= free => {}
        _ => {
            println!(
                "[Transfer] {request_id} — not enough disk space for the remaining {remaining} byte, transfer dibatalkan"
            );
            if start_bytes == 0 {
                let _ = std::fs::remove_file(&part_path);
            }
            state.transfers.remove_progress(request_id);
            return;
        }
    }

    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&part_path)
        .await;
    let mut file = match file {
        Ok(f) => f,
        Err(err) => {
            println!("[Transfer] {request_id} — cannot open partial file: {err}");
            state.transfers.remove_progress(request_id);
            return;
        }
    };
    if start_bytes > 0 {
        if file.seek(std::io::SeekFrom::Start(start_bytes)).await.is_err() {
            state.transfers.remove_progress(request_id);
            return;
        }
    }

    let mut written = start_bytes;

    // Sisa byte yang ikut di paket frame `file-start`: untuk file kecil,
    // seluruh isinya bisa sudah ada di sini.
    if !buffered.is_empty() {
        let take = std::cmp::min(buffered.len() as u64, actual_size - written) as usize;
        if take > 0 {
            let chunk: Vec<u8> = buffered.drain(..take).collect();
            if let Err(err) = file.write_all(&chunk).await {
                println!("[Transfer] {request_id} — write error: {err}");
            }
            written += take as u64;
            state.transfers.set_bytes(request_id, written);
        }
    }
    write_part_meta(
        state,
        &key,
        &save_dir,
        &part_path,
        &final_path,
        &safe_name,
        &display_name,
        actual_size,
        written,
    );
    let mut last_meta_save = now_ms();

    let mut chunk = vec![0u8; 64 * 1024];
    while written < actual_size {
        // Pembatalan dari dashboard harus berhenti SEKARANG, bukan setelah
        // penerima mengirim byte berikutnya: kalau tidak, file yang sudah
        // dibatalkan tetap ditulis sampai pengirim menutup koneksi dan
        // partial-nya tertinggal sebagai sisa yang tak bisa dilanjutkan siapa pun.
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let want = std::cmp::min(chunk.len() as u64, actual_size - written) as usize;
        // Baca dalam potongan 250 ms supaya tanda batal terlihat cepat.
        // Timeout panjang di sini membuat file yang sudah dibatalkan tetap
        // menunggu byte yang tidak akan datang sampai batas idle habis.
        let mut idle = Duration::ZERO;
        let n = loop {
            if cancel.load(Ordering::SeqCst) {
                break None;
            }
            match tokio::time::timeout(Duration::from_millis(250), stream.read(&mut chunk[..want])).await
            {
                Err(_) => {
                    idle += Duration::from_millis(250);
                    if idle >= IO_TIMEOUT {
                        break None;
                    }
                    continue;
                }
                Ok(Err(_)) => break None,
                Ok(Ok(0)) => break None,
                Ok(Ok(n)) => break Some(n),
            }
        };
        let Some(n) = n else { break };
        if let Err(err) = file.write_all(&chunk[..n]).await {
            println!("[Transfer] {request_id} — write error: {err}");
            break;
        }
        written += n as u64;
        state.transfers.set_bytes(request_id, written);
        // Meta periodik: kalau proses mati mendadak, posisi terakhir tetap
        // tercatat dan kiriman berikutnya bisa lanjut dari situ.
        if now_ms().saturating_sub(last_meta_save) >= 2000 {
            last_meta_save = now_ms();
            write_part_meta(
                state,
                &key,
                &save_dir,
                &part_path,
                &final_path,
                &safe_name,
                &display_name,
                actual_size,
                written,
            );
        }
    }

    let total_written = start_bytes + written;

    if cancel.load(Ordering::SeqCst) {
        let _ = tokio::fs::remove_file(&part_path).await;
        delete_part_meta(state, &key);
        state.transfers.mark_status(request_id, "cancelled", None);
        println!("[Transfer] {request_id} — dibatalkan penerima, partial dihapus");
        return;
    }

    if total_written < actual_size {
        // FIN/RST bukan pembatalan: partial DISIMPAN supaya bisa dilanjutkan.
        write_part_meta(
            state,
            &key,
            &save_dir,
            &part_path,
            &final_path,
            &safe_name,
            &display_name,
            actual_size,
            total_written,
        );
        let reason = format!(
            "interrupted at {total_written}/{actual_size} bytes — partial kept, resend to resume"
        );
        state.transfers.mark_status(request_id, "failed", Some(reason.clone()));
        println!("[Transfer] {request_id} — putus di {total_written}/{actual_size}, partial kept for resume");
        return;
    }

    let _ = file.flush().await;
    drop(file);

    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&part_path);
        delete_part_meta(state, &key);
        state.transfers.mark_status(request_id, "cancelled", None);
        return;
    }

    // Part -> final. Kalau nama tujuan muncul di antara klaim dan sekarang,
    // pilih nama berikutnya dulu: rename menimpa tanpa bertanya.
    if start_bytes == 0 && final_path.exists() {
        let path = final_path.clone();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        let base = path
            .file_stem()
            .and_then(|e| e.to_str())
            .unwrap_or("file")
            .to_string();
        for i in 1..10_000 {
            let candidate = save_dir.join(format!("{base} ({i}){ext}"));
            if !candidate.exists() {
                final_path = candidate;
                break;
            }
        }
        display_name = final_path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or(&display_name)
            .to_string();
    }

    let finalised = std::fs::rename(&part_path, &final_path);
    match finalised {
        Ok(_) => {
            delete_part_meta(state, &key);
            let thumbnail_id = if crate::thumbnail::is_thumbnailable(&display_name) {
                Some(state.thumbnails.register(&final_path))
            } else {
                None
            };
            state.transfers.complete_progress(
                request_id,
                &final_path.to_string_lossy(),
                thumbnail_id.clone(),
            );
            state.history.add(json!({
                "direction": "receive",
                "fileName": display_name,
                "fileSize": actual_size,
                "peer": sender_name,
                "status": "completed",
                "savedTo": final_path.to_string_lossy(),
                "thumbnailId": thumbnail_id,
                "resumed": start_bytes > 0,
            }));
            let _ = send_frame(
                stream,
                &json!({
                    "type": "transfer-saved",
                    "fileSize": actual_size,
                    "savedTo": final_path.to_string_lossy(),
                    "fallback": save_fallback,
                }),
            )
            .await;
            state.log(
                "info",
                format!("terima: {display_name} dari {sender_name}"),
            );
            println!(
                "[Transfer] ✅ {request_id} — {display_name} diterima ({actual_size} bytes) → {}",
                final_path.display()
            );
        }
        Err(err) => {
            println!(
                "[Transfer] Failed to finalise {display_name}: {err} — partial remains at {}",
                part_path.display()
            );
            state.transfers.mark_status(
                request_id,
                "failed",
                Some("penerima gagal menyimpan file".to_string()),
            );
            let _ = send_frame(
                stream,
                &json!({"type": "transfer-save-failed", "reason": "penerima gagal menyimpan file"}),
            )
            .await;
        }
    }
}

// ===================== Pengirim =====================

pub struct RequestMeta {
    pub target_ip: String,
    pub target_port: u16,
    pub file_name: String,
    pub file_size: u64,
    pub resume_id: Option<String>,
    pub batch_id: Option<Value>,
    pub peer_name: Option<String>,
    pub sender_name: String,
    pub sender_id: String,
    pub kind: String,
}

pub async fn send_transfer_request(
    state: Arc<AppState>,
    meta: RequestMeta,
) -> Result<String, String> {
    let request_id = random_id();
    let address = format!("{}:{}", meta.target_ip, meta.target_port);
    state.log(
        "info",
        format!("kirim: {} → {}", meta.file_name, meta.peer_name.clone().unwrap_or_else(|| meta.target_ip.clone())),
    );
    println!(
        "[Transfer] 🔌 → {} ke {} ({address}) [requestId={request_id}]",
        meta.file_name,
        meta.peer_name.clone().unwrap_or_else(|| meta.target_ip.clone())
    );

    // Entri DIDAFTARKAN dulu, koneksi menyusul di task terpisah. Node juga
    // begitu: POST /transfer/request langsung dijawab requestId, sementara
    // handshake TCP berjalan di belakang dan hasilnya dibaca lewat
    // /transfer/status. Kalau handshake-nya ikut ditunggu di handler ini,
    // pemanggil yang menerima file tidak pernah sempat menjawab accept →
    // dua sisi saling menunggu.
    {
        let mut outgoing = state
            .transfers
            .outgoing
            .lock()
            .map_err(|_| "Transfer state unavailable".to_string())?;
        outgoing.insert(
            request_id.clone(),
            OutgoingEntry {
                socket: None,
                status: "pending".to_string(),
                target_ip: meta.target_ip.clone(),
                file_name: meta.file_name.clone(),
                file_size: meta.file_size,
                peer_name: meta.peer_name.clone(),
                created_at: now_ms(),
                resume_offset: 0,
                reject_message: None,
                cancelled_by_user: false,
                ended_at: None,
            },
        );
    }

    let task_state = state.clone();
    let task_id = request_id.clone();
    tokio::spawn(async move {
        let result = handshake(&task_state, &task_id, &address, &meta).await;
        if let Err(err) = result {
            if let Ok(mut outgoing) = task_state.transfers.outgoing.lock() {
                if let Some(entry) = outgoing.get_mut(&task_id) {
                    if !entry.cancelled_by_user {
                        entry.status = "disconnected".to_string();
                        entry.reject_message = Some(err.clone());
                        entry.ended_at = Some(now_ms());
                    }
                }
            }
            eprintln!("[Transfer] ❌ {task_id}: {err}");
        }
    });

    Ok(request_id)
}

async fn handshake(
    state: &Arc<AppState>,
    request_id: &str,
    address: &str,
    meta: &RequestMeta,
) -> Result<(), String> {
    let mut stream = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
        Err(_) => {
            return Err(format!(
                "Connection to {address} timed out — the peer may be down, or a firewall is blocking the route."
            ))
        }
        Ok(Err(err)) => return Err(format!("Cannot reach {address}: {err}")),
        Ok(Ok(s)) => s,
    };

    let frame = json!({
        "type": "transfer-request",
        "fileName": meta.file_name,
        "fileSize": meta.file_size,
        "senderName": meta.sender_name,
        "senderId": meta.sender_id,
        "resumeId": meta.resume_id,
        "batchId": meta.batch_id,
        "kind": meta.kind,
    });
    if !send_frame(&mut stream, &frame).await {
        return Err("Failed to send the transfer request".to_string());
    }

    let mut buffered: Vec<u8> = Vec::new();
    let msg = match read_frame(&mut stream, &mut buffered, IO_TIMEOUT).await {
        Ok(Some(msg)) => msg,
        Ok(None) => return Err("Peer closed the connection before answering".to_string()),
        Err(err) => return Err(err),
    };
    if msg.get("type").and_then(|v| v.as_str()) != Some("transfer-response") {
        return Err("Peer answered with an unexpected frame".to_string());
    }

    let accepted = msg.get("accepted").and_then(|v| v.as_bool()).unwrap_or(false);
    if let Ok(mut outgoing) = state.transfers.outgoing.lock() {
        if let Some(entry) = outgoing.get_mut(request_id) {
            entry.status = if accepted { "accepted" } else { "rejected" }.to_string();
            entry.resume_offset = if accepted {
                msg.get("resumeOffset").and_then(|v| v.as_u64()).unwrap_or(0)
            } else {
                0
            };
            entry.reject_message = if accepted {
                None
            } else {
                msg.get("message").and_then(|v| v.as_str()).map(str::to_string)
            };
            if entry.cancelled_by_user {
                return Ok(());
            }
            entry.socket = Some(stream);
        }
    }
    Ok(())
}

/// Container/codec yang tidak dijamin bisa diputar perangkat tujuan. Sama
/// dengan daftar di `server/transfer.js`: dikonversi dulu kalau ffmpeg ada,
/// kalau tidak dikirim apa adanya.
const NEEDS_TRANSCODE: &[&str] = &[
    "mpeg", "mpg", "avi", "mkv", "webm", "mov", "3gp", "flv", "ts",
];

struct PreparedFile {
    path: PathBuf,
    name: String,
    size: u64,
}

/// Siapkan berkas untuk dikirim: video yang perlu dikonversi diubah ke mp4
/// (atau mp3 kalau isinya audio saja). Kegagalan apa pun jatuh ke berkas asli
/// — pengguna lebih baik menerima mkv daripada tidak menerima apa-apa.
async fn prepare_send_file(state: &AppState, path: &Path, name: &str) -> PreparedFile {
    let passthrough = || PreparedFile {
        path: path.to_path_buf(),
        name: name.to_string(),
        size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    };

    // Ekstensi diambil dari NAMA ASLI, bukan dari path di disk: upload
    // disimpan dengan nama acak tanpa ekstensi, jadi path-nya tidak pernah
    // memberi tahu ini video atau bukan.
    let ext = name
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| e != name)
        .unwrap_or_default();
    if !NEEDS_TRANSCODE.contains(&ext.as_str()) {
        return passthrough();
    }
    // ffmpeg mendeteksi format dari isi, tapi container mentah tanpa ekstensi
    // sering gagal ditebak. Hardlink dengan ekstensi benar menyelesaikannya
    // tanpa menyalin byte.
    let mut input_path = path.to_path_buf();
    if path.extension().is_none() && !ext.is_empty() {
        let linked = path.with_extension(&ext);
        if !linked.exists() {
            let _ = std::fs::hard_link(path, &linked);
        }
        if linked.exists() {
            input_path = linked;
        }
    }
    if crate::ffmpeg::ffmpeg_path().is_none() {
        println!("[Transfer] ffmpeg tidak ada — {name} dikirim apa adanya");
        return passthrough();
    }

    let input = input_path.to_string_lossy().to_string();
    // Nama keluar mengikuti NAMA ASLI: di disk berkasnya bernama hex acak,
    // dan memakai itu sebagai nama kiriman berarti penerima mendapat
    // "46b332fdf03445f6a5f7a95866369168.mp4" alih-alih "uji.mp4".
    let stem = name
        .rsplit_once('.')
        .map(|(base, _)| base)
        .unwrap_or(name)
        .to_string();
    let out_dir = state.upload_dir.clone();

    // Audio saja (mis. mp4 berisi album art) → mp3, jauh lebih kecil.
    if let Some(info) = crate::ffmpeg::probe(&path.to_path_buf()).await {
        if !info.has_real_video && info.has_audio {
            let out = out_dir.join(format!("{stem}.mp3"));
            let out_str = out.to_string_lossy().to_string();
            let args: Vec<String> = vec![
                "-nostdin".into(), "-loglevel".into(), "error".into(), "-y".into(),
                "-i".into(), input, "-vn".into(),
                "-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into(),
                out_str,
            ];
            if crate::ffmpeg::run_ffmpeg(&args, std::time::Duration::from_secs(1800))
                .await
                .is_some()
            {
                if let Ok(meta) = std::fs::metadata(&out) {
                    if meta.len() > 0 {
                        println!("[Transfer] audio → mp3: {stem}.mp3 ({} byte)", meta.len());
                        return PreparedFile {
                            path: out,
                            name: format!("{stem}.mp3"),
                            size: meta.len(),
                        };
                    }
                }
            }
            let _ = std::fs::remove_file(&out);
            return passthrough();
        }
    }

    let out = out_dir.join(format!("{stem}.mp4"));
    let out_str = out.to_string_lossy().to_string();
    let args: Vec<String> = vec![
        "-nostdin".into(), "-loglevel".into(), "error".into(), "-y".into(),
        "-i".into(), input,
        "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
        "-crf".into(), "23".into(),
        "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into(),
        "-movflags".into(), "+faststart".into(),
        out_str,
    ];
    println!("[Transfer] konversi {name} → mp4...");
    if crate::ffmpeg::run_ffmpeg(&args, std::time::Duration::from_secs(3600))
        .await
        .is_none()
    {
        let _ = std::fs::remove_file(&out);
        println!("[Transfer] konversi gagal — {name} dikirim apa adanya");
        return passthrough();
    }
    let Ok(meta) = std::fs::metadata(&out) else {
        return passthrough();
    };
    if meta.len() == 0 {
        let _ = std::fs::remove_file(&out);
        return passthrough();
    }
    println!("[Transfer] video → mp4: {stem}.mp4 ({} byte)", meta.len());
    PreparedFile {
        path: out,
        name: format!("{stem}.mp4"),
        size: meta.len(),
    }
}

pub async fn start_file_send(
    state: Arc<AppState>,
    request_id: &str,
    file_path: &str,
) -> Result<u64, String> {
    let (mut stream, resume_offset, file_name) = {
        let mut outgoing = state
            .transfers
            .outgoing
            .lock()
            .map_err(|_| "Transfer state unavailable".to_string())?;
        let entry = outgoing
            .get_mut(request_id)
            .ok_or_else(|| format!("Request {request_id} not found"))?;
        if entry.status != "accepted" {
            return Err(format!(
                "Request {request_id} status is \"{}\", expected \"accepted\"",
                entry.status
            ));
        }
        let stream = entry
            .socket
            .take()
            .ok_or_else(|| "Transfer socket is not available".to_string())?;
        (stream, entry.resume_offset, entry.file_name.clone())
    };

    let upload_path = assert_inside_uploads(&state, file_path)?;
    if !upload_path.exists() {
        return Err(format!("File not found: {}", upload_path.display()));
    }
    let prepared = prepare_send_file(&state, &upload_path, &file_name).await;
    let safe_path = prepared.path.clone();
    let file_name = prepared.name.clone();
    let actual_size = prepared.size;
    if actual_size == 0 {
        return Err("File is empty".to_string());
    }

    if actual_size < resume_offset {
        return Err("Receiver asked to resume beyond the file size".to_string());
    }

    state.transfers.set_progress(
        request_id,
        Progress {
            file_name: file_name.clone(),
            file_size: actual_size,
            bytes_transferred: resume_offset,
            status: "transferring".to_string(),
            save_path: None,
            saved_to: None,
            thumbnail_id: None,
            reason: None,
            resumed: resume_offset > 0,
            ended_at: None,
        },
    );

    if !send_frame(
        &mut stream,
        &json!({"type": "file-start", "fileName": file_name, "fileSize": actual_size}),
    )
    .await
    {
        state.transfers.mark_status(request_id, "failed", Some("koneksi putus".to_string()));
        return Err("Failed to start the file stream".to_string());
    }

    let mut file = tokio::fs::File::open(&safe_path)
        .await
        .map_err(|e| e.to_string())?;
    if resume_offset > 0 {
        file.seek(std::io::SeekFrom::Start(resume_offset))
            .await
            .map_err(|e| e.to_string())?;
    }

    let mut sent = resume_offset;
    let mut chunk = vec![0u8; 64 * 1024];
    let mut send_error: Option<String> = None;
    loop {
        let n = match file.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(err) => {
                send_error = Some(err.to_string());
                break;
            }
        };
        if let Err(err) = stream.write_all(&chunk[..n]).await {
            send_error = Some(err.to_string());
            break;
        }
        sent += n as u64;
        state.transfers.set_bytes(request_id, sent);
    }

    let mut saved = false;
    let mut saved_to: Option<String> = None;
    let mut save_reason: Option<String> = None;
    if send_error.is_none() {
        let _ = stream.flush().await;
        let mut buffered: Vec<u8> = Vec::new();
        match tokio::time::timeout(Duration::from_secs(60), read_frame(&mut stream, &mut buffered, IO_TIMEOUT)).await {
            Ok(Ok(Some(msg))) => match msg.get("type").and_then(|v| v.as_str()) {
                Some("transfer-saved") => {
                    saved = true;
                    saved_to = msg.get("savedTo").and_then(|v| v.as_str()).map(str::to_string);
                }
                Some("transfer-save-failed") => {
                    save_reason = Some(
                        msg.get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("penerima gagal menyimpan file")
                            .to_string(),
                    );
                }
                _ => {}
            },
            _ => {}
        }
    }
    let _ = stream.shutdown().await;

    let (status, reason) = if let Some(err) = send_error {
        ("failed".to_string(), Some(err))
    } else if saved {
        ("completed".to_string(), None)
    } else if let Some(reason) = save_reason {
        ("failed".to_string(), Some(reason))
    } else if sent >= actual_size {
        (
            "unconfirmed".to_string(),
            Some("penerima tidak konfirmasi file tersimpan".to_string()),
        )
    } else {
        ("failed".to_string(), None)
    };

    {
        if let Ok(mut progress) = state.transfers.progress.lock() {
            if let Some(p) = progress.get_mut(request_id) {
                p.status = status.clone();
                p.bytes_transferred = sent;
                p.saved_to = saved_to.clone();
                p.reason = reason.clone();
                p.ended_at = Some(now_ms());
            }
        }
        if let Ok(mut outgoing) = state.transfers.outgoing.lock() {
            if let Some(entry) = outgoing.get_mut(request_id) {
                entry.status = status.clone();
                entry.ended_at = Some(now_ms());
            }
        }
    }

    state.history.add(json!({
        "direction": "send",
        "fileName": file_name,
        "fileSize": actual_size,
        "peer": state.transfers.peer_label(request_id),
        "status": status,
        "savedTo": saved_to,
        "reason": reason,
        "resumed": resume_offset > 0,
    }));

    if status == "completed" || status == "cancelled" || status == "rejected" {
        let _ = std::fs::remove_file(&safe_path);
    } else {
        println!("[Transfer] Upload kept for resume: {}", safe_path.display());
    }

    Ok(actual_size)
}

pub async fn start_text_send(
    state: Arc<AppState>,
    request_id: &str,
    text: &str,
) -> Result<(), String> {
    let mut stream = {
        let mut outgoing = state
            .transfers
            .outgoing
            .lock()
            .map_err(|_| "Transfer state unavailable".to_string())?;
        let entry = outgoing
            .get_mut(request_id)
            .ok_or_else(|| format!("Request {request_id} not found"))?;
        if entry.status != "accepted" {
            return Err(format!(
                "Request {request_id} status is \"{}\", expected \"accepted\"",
                entry.status
            ));
        }
        entry
            .socket
            .take()
            .ok_or_else(|| "Transfer socket is not available".to_string())?
    };

    let bytes = text.as_bytes().to_vec();
    let size = bytes.len() as u64;
    state.transfers.set_progress(
        request_id,
        Progress {
            file_name: "Teks".to_string(),
            file_size: size,
            bytes_transferred: 0,
            status: "transferring".to_string(),
            save_path: None,
            saved_to: None,
            thumbnail_id: None,
            reason: None,
            resumed: false,
            ended_at: None,
        },
    );

    if !send_frame(&mut stream, &json!({"type": "text", "length": size})).await {
        state.transfers.mark_status(request_id, "failed", Some("koneksi putus".to_string()));
        return Err("Failed to send the text".to_string());
    }
    if stream.write_all(&bytes).await.is_err() {
        state.transfers.mark_status(request_id, "failed", Some("koneksi putus".to_string()));
        return Err("Failed to send the text".to_string());
    }
    let _ = stream.flush().await;

    let mut acked = false;
    let mut buffered: Vec<u8> = Vec::new();
    match tokio::time::timeout(Duration::from_secs(30), read_frame(&mut stream, &mut buffered, IO_TIMEOUT)).await {
        Ok(Ok(Some(msg))) => {
            if msg.get("type").and_then(|v| v.as_str()) == Some("text-saved") {
                acked = true;
            }
        }
        _ => {}
    }
    let _ = stream.shutdown().await;

    let status = if acked { "completed" } else { "unconfirmed" };
    let reason = if acked {
        None
    } else {
        Some("penerima tidak mengonfirmasi teks diterima".to_string())
    };
    {
        if let Ok(mut progress) = state.transfers.progress.lock() {
            if let Some(p) = progress.get_mut(request_id) {
                p.status = status.to_string();
                p.bytes_transferred = size;
                p.reason = reason.clone();
                p.ended_at = Some(now_ms());
            }
        }
        if let Ok(mut outgoing) = state.transfers.outgoing.lock() {
            if let Some(entry) = outgoing.get_mut(request_id) {
                entry.status = status.to_string();
                entry.ended_at = Some(now_ms());
            }
        }
    }
    state.history.add(json!({
        "direction": "send",
        "fileName": "Teks",
        "fileSize": size,
        "peer": state.transfers.peer_label(request_id),
        "status": status,
        "reason": reason,
    }));
    Ok(())
}

// ===================== Registry & tampilan JSON =====================

impl Transfers {
    pub fn new() -> Transfers {
        Transfers::default()
    }

    fn set_progress(&self, id: &str, progress: Progress) {
        if let Ok(mut map) = self.progress.lock() {
            map.insert(id.to_string(), progress);
        }
    }

    fn set_bytes(&self, id: &str, bytes: u64) {
        if let Ok(mut map) = self.progress.lock() {
            if let Some(p) = map.get_mut(id) {
                p.bytes_transferred = bytes;
            }
        }
    }

    fn mark_status(&self, id: &str, status: &str, reason: Option<String>) {
        if let Ok(mut map) = self.progress.lock() {
            if let Some(p) = map.get_mut(id) {
                p.status = status.to_string();
                if let Some(reason) = reason.clone() {
                    p.reason = Some(reason);
                }
                if terminal(status) {
                    p.ended_at = Some(now_ms());
                }
            }
        }
        if let Ok(mut outgoing) = self.outgoing.lock() {
            if let Some(entry) = outgoing.get_mut(id) {
                entry.status = status.to_string();
                if terminal(status) {
                    entry.ended_at = Some(now_ms());
                }
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(entry) = pending.get_mut(id) {
                entry.status = status.to_string();
            }
        }
    }

    fn complete_progress(&self, id: &str, saved_to: &str, thumbnail_id: Option<String>) {
        if let Ok(mut map) = self.progress.lock() {
            if let Some(p) = map.get_mut(id) {
                p.status = "completed".to_string();
                p.bytes_transferred = p.file_size;
                p.saved_to = Some(saved_to.to_string());
                p.save_path = Some(saved_to.to_string());
                p.thumbnail_id = thumbnail_id;
                p.ended_at = Some(now_ms());
            }
        }
    }

    fn remove_progress(&self, id: &str) {
        if let Ok(mut map) = self.progress.lock() {
            map.remove(id);
        }
    }

    fn peer_label(&self, id: &str) -> String {
        if let Ok(outgoing) = self.outgoing.lock() {
            if let Some(entry) = outgoing.get(id) {
                return entry
                    .peer_name
                    .clone()
                    .unwrap_or_else(|| entry.target_ip.clone());
            }
        }
        "?".to_string()
    }

    pub fn respond(
        &self,
        _state: &AppState,
        request_id: &str,
        accepted: bool,
        message: Option<String>,
    ) -> Result<Value, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Transfer state unavailable".to_string())?;
        let entry = pending
            .get_mut(request_id)
            .ok_or_else(|| format!("Request {request_id} not found"))?;
        if entry.status != "pending" {
            return Err(format!("Request {request_id} already {}", entry.status));
        }
        entry.status = if accepted { "accepted" } else { "rejected" }.to_string();
        if !accepted {
            entry.reject_message = message.clone();
        }
        let resume_offset = entry.resume_offset;
        if let Some(tx) = entry.decision.take() {
            let _ = tx.send(accepted);
        }
        let status = entry.status.clone();
        drop(pending);

        if !accepted {
            // Sisi koneksi mengirim frame penolakan; di sini cukup catat.
            if let Ok(mut progress) = self.progress.lock() {
                progress.remove(request_id);
            }
        }

        // Frame balasan dikirim oleh task koneksi setelah bangun dari channel,
        // supaya satu socket hanya punya satu penulis.
        Ok(json!({
            "requestId": request_id,
            "status": status,
            "message": message,
            "resumeOffset": resume_offset,
        }))
    }

    fn take_reject_message(&self, request_id: &str) -> Option<String> {
        let pending = self.pending.lock().ok()?;
        pending.get(request_id).and_then(|e| e.reject_message.clone())
    }

    pub fn pending_list(&self) -> Vec<Value> {
        let Ok(pending) = self.pending.lock() else {
            return Vec::new();
        };
        pending
            .iter()
            .filter(|(_, e)| e.status == "pending" || e.status == "accepted")
            .map(|(id, e)| {
                json!({
                    "requestId": id,
                    "fileName": e.file_name,
                    "fileSize": e.file_size,
                    "senderName": e.sender_name,
                    "senderId": e.sender_id,
                    "batchId": e.batch_id,
                    "kind": e.kind,
                    "auto": e.auto,
                    "status": e.status,
                    "createdAt": e.created_at,
                })
            })
            .collect()
    }

    pub fn progress_json(&self, request_id: &str) -> Option<Value> {
        let progress = self.progress.lock().ok()?;
        let p = progress.get(request_id)?;
        let percent = if p.file_size > 0 {
            ((p.bytes_transferred as f64 / p.file_size as f64) * 100.0).round() as i64
        } else {
            0
        };
        Some(json!({
            "requestId": request_id,
            "fileName": p.file_name,
            "fileSize": p.file_size,
            "bytesTransferred": p.bytes_transferred,
            "percent": percent,
            "status": p.status,
            "savePath": p.save_path,
            "savedTo": p.saved_to,
            "thumbnailId": p.thumbnail_id,
            "reason": p.reason,
        }))
    }

    pub fn active_list(&self) -> Vec<Value> {
        let mut rows: HashMap<String, Value> = HashMap::new();

        if let Ok(outgoing) = self.outgoing.lock() {
            for (id, e) in outgoing.iter() {
                if terminal(&e.status) {
                    continue;
                }
                rows.insert(
                    id.clone(),
                    json!({
                        "requestId": id,
                        "direction": "send",
                        "fileName": e.file_name,
                        "fileSize": e.file_size,
                        "peer": e.peer_name.clone().unwrap_or_else(|| e.target_ip.clone()),
                        "status": e.status,
                        "createdAt": e.created_at,
                        "bytesTransferred": 0,
                        "percent": 0,
                        "resumed": false,
                    }),
                );
            }
        }
        if let Ok(pending) = self.pending.lock() {
            for (id, e) in pending.iter() {
                if terminal(&e.status) || rows.contains_key(id) {
                    continue;
                }
                rows.insert(
                    id.clone(),
                    json!({
                        "requestId": id,
                        "direction": "receive",
                        "fileName": e.file_name,
                        "fileSize": e.file_size,
                        "peer": e.sender_name,
                        "status": e.status,
                        "createdAt": e.created_at,
                        "bytesTransferred": 0,
                        "percent": 0,
                        "resumed": false,
                    }),
                );
            }
        }
        if let Ok(progress) = self.progress.lock() {
            for (id, p) in progress.iter() {
                if terminal(&p.status) && !rows.contains_key(id) {
                    continue;
                }
                if terminal(&p.status) {
                    continue;
                }
                let entry = rows.entry(id.clone()).or_insert_with(|| {
                    json!({
                        "requestId": id,
                        "direction": "receive",
                        "fileName": p.file_name,
                        "fileSize": p.file_size,
                        "peer": "?",
                        "status": p.status,
                        "createdAt": null,
                        "bytesTransferred": 0,
                        "percent": 0,
                        "resumed": false,
                    })
                });
                entry["fileName"] = json!(p.file_name);
                entry["fileSize"] = json!(p.file_size);
                entry["bytesTransferred"] = json!(p.bytes_transferred);
                entry["percent"] = json!(if p.file_size > 0 {
                    ((p.bytes_transferred as f64 / p.file_size as f64) * 100.0).round() as i64
                } else {
                    0
                });
                entry["status"] = json!(p.status);
                entry["resumed"] = json!(p.resumed);
            }
        }

        rows.into_values().collect()
    }

    pub fn status_json(&self, request_id: &str) -> Option<Value> {
        if let Ok(pending) = self.pending.lock() {
            if let Some(e) = pending.get(request_id) {
                return Some(json!({
                    "requestId": request_id,
                    "status": e.status,
                    "role": "receiver",
                }));
            }
        }
        if let Ok(outgoing) = self.outgoing.lock() {
            if let Some(e) = outgoing.get(request_id) {
                return Some(json!({
                    "requestId": request_id,
                    "status": e.status,
                    "role": "sender",
                    "resumeOffset": e.resume_offset,
                    "reason": e.reject_message,
                }));
            }
        }
        None
    }

    pub fn texts_list(&self) -> Vec<Value> {
        let Ok(mut texts) = self.texts.lock() else {
            return Vec::new();
        };
        let now = now_ms();
        texts.retain(|t| {
            let ts = t.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0) as u128;
            now.saturating_sub(ts) < TEXT_TTL
        });
        texts.clone()
    }

    pub fn consume_text(&self, id: &str) -> bool {
        let Ok(mut texts) = self.texts.lock() else {
            return false;
        };
        let before = texts.len();
        texts.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(id));
        texts.len() != before
    }

    pub fn push_text(&self, item: Value) {
        if let Ok(mut texts) = self.texts.lock() {
            texts.push(item);
            if texts.len() > 50 {
                texts.remove(0);
            }
        }
    }

    pub fn cancel_outgoing(&self, request_id: &str) -> Result<(), String> {
        let mut outgoing = self
            .outgoing
            .lock()
            .map_err(|_| "Transfer state unavailable".to_string())?;
        let entry = outgoing
            .get_mut(request_id)
            .ok_or_else(|| format!("Request {request_id} not found"))?;
        if matches!(entry.status.as_str(), "completed" | "failed" | "cancelled" | "rejected") {
            return Err("Transfer sudah selesai, tidak bisa dibatalkan".to_string());
        }
        entry.cancelled_by_user = true;
        entry.status = "cancelled".to_string();
        entry.ended_at = Some(now_ms());
        if let Some(mut socket) = entry.socket.take() {
            // FIN graceful: penerima harus bisa membedakan batal dari putus.
            tokio::spawn(async move {
                let _ = socket.shutdown().await;
            });
        }
        drop(outgoing);
        self.mark_status(request_id, "cancelled", None);
        Ok(())
    }

    pub fn cancel_incoming(&self, request_id: &str) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Transfer state unavailable".to_string())?;
        let entry = pending
            .get_mut(request_id)
            .ok_or_else(|| format!("Request {request_id} not found"))?;
        if matches!(entry.status.as_str(), "completed" | "failed" | "cancelled" | "rejected") {
            return Err("Transfer sudah selesai, tidak bisa dibatalkan".to_string());
        }
        entry.status = "cancelled".to_string();
        entry.cancel.store(true, Ordering::SeqCst);
        if let Some(tx) = entry.decision.take() {
            let _ = tx.send(false);
        }
        drop(pending);
        self.mark_status(request_id, "cancelled", None);
        Ok(())
    }

    /// Buang entri yang sudah lama selesai supaya map tidak tumbuh selamanya.
    pub fn sweep(&self) {
        let now = now_ms();
        if let Ok(mut progress) = self.progress.lock() {
            let mut drop_ids = Vec::new();
            for (id, p) in progress.iter_mut() {
                if !terminal(&p.status) {
                    p.ended_at = None;
                    continue;
                }
                let ended = *p.ended_at.get_or_insert(now);
                if now.saturating_sub(ended) > TRANSFER_RETENTION {
                    drop_ids.push(id.clone());
                }
            }
            for id in drop_ids {
                progress.remove(&id);
            }
        }
        if let Ok(mut outgoing) = self.outgoing.lock() {
            let mut drop_ids = Vec::new();
            for (id, e) in outgoing.iter_mut() {
                if !terminal(&e.status) {
                    e.ended_at = None;
                    continue;
                }
                let ended = *e.ended_at.get_or_insert(now);
                if now.saturating_sub(ended) > TRANSFER_RETENTION {
                    drop_ids.push(id.clone());
                }
            }
            for id in drop_ids {
                outgoing.remove(&id);
            }
        }
    }
}

// ===================== Server =====================

pub fn start_server(state: Arc<AppState>) {
    cleanup_stale(&state);
    let _ = std::fs::create_dir_all(&state.upload_dir);
    let _ = std::fs::create_dir_all(&state.save_dir);

    let server_state = state.clone();
    tokio::spawn(async move {
        let state = server_state;
        let mut port = state.ports.transfer();
        for _ in 0..=MAX_PORT_TRIES {
            match TcpListener::bind(("0.0.0.0", port)).await {
                Ok(listener) => {
                    state.ports.set_transfer(port);
                    println!("[Transfer] TCP server listening on port {port}");
                    let accept_state = state.clone();
                    // Batas koneksi bersamaan: tanpa ini, satu skrip yang
                    // membuka ribuan socket membuat server kehabisan memori
                    // sebelum sempat menolak apa pun.
                    let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
                    tokio::spawn(async move {
                        loop {
                            match listener.accept().await {
                                Ok((stream, peer)) => {
                                    let current = live.load(Ordering::SeqCst);
                                    if current >= protocol::MAX_TCP_CONNECTIONS {
                                        println!(
                                            "[Transfer] ⚠️ {} koneksi aktif — {} ditolak sampai ada yang selesai",
                                            current, peer
                                        );
                                        // Tutup langsung: klien yang kena batas
                                        // tidak perlu dilayani lebih lama.
                                        drop(stream);
                                        continue;
                                    }
                                    live.fetch_add(1, Ordering::SeqCst);
                                    let st = accept_state.clone();
                                    let counter = live.clone();
                                    tokio::spawn(async move {
                                        handle_incoming(st, stream).await;
                                        counter.fetch_sub(1, Ordering::SeqCst);
                                    });
                                }
                                Err(err) => {
                                    eprintln!("[Transfer] accept error: {err}");
                                    tokio::time::sleep(Duration::from_millis(200)).await;
                                }
                            }
                        }
                    });
                    break;
                }
                Err(err) => {
                    println!("⚠️ Transfer port {port} is taken — LAN DROP moved to {}", port + 1);
                    let _ = err;
                    port += 1;
                }
            }
        }
    });

    // Sweeper & pembersih sampah selama server hidup, bukan hanya saat start.
    let sweep_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            sweep_state.transfers.sweep();
        }
    });
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
            cleanup_stale(&cleanup_state);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_name_never_keeps_directories() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("/etc/shadow"), "shadow");
        // Backslash hanya pemisah path di Windows. Di Linux nama itu utuh
        // (dengan `\\` jadi `_`), dan tetap tidak bisa keluar folder karena
        // tidak ada `/` yang tersisa.
        let windows_style = sanitize_file_name("..\\..\\windows\\system32\\evil.dll");
        assert!(!windows_style.contains('/'));
        assert!(!windows_style.is_empty() && windows_style != "..");
        #[cfg(windows)]
        assert_eq!(windows_style, "evil.dll");
    }

    #[test]
    fn forbidden_characters_replaced() {
        assert_eq!(sanitize_file_name("a:b*c?d|e\"f<g>h.txt"), "a_b_c_d_e_f_g_h.txt");
        assert_eq!(sanitize_file_name("baris\nbaru.txt"), "baris_baru.txt");
    }

    #[test]
    fn empty_and_dot_names_fall_back() {
        assert_eq!(sanitize_file_name(""), "file");
        assert_eq!(sanitize_file_name(".."), "file");
        assert_eq!(sanitize_file_name("   "), "file");
    }

    #[test]
    fn trailing_dots_and_spaces_trimmed() {
        assert_eq!(sanitize_file_name("laporan.txt..."), "laporan.txt");
        assert_eq!(sanitize_file_name("nama   "), "nama");
    }

    #[test]
    fn name_length_capped() {
        let long = "a".repeat(500);
        assert_eq!(sanitize_file_name(&long).chars().count(), 200);
    }

    #[test]
    fn unicode_names_survive() {
        assert_eq!(sanitize_file_name("foto-日本語-🎉.png"), "foto-日本語-🎉.png");
    }
}
