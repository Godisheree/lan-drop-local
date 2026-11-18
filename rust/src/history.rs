//! Riwayat transfer — padanan `server/history.js`.
//!
//! Ditulis atomic (tmp + rename) ke `history.json`. Node menunda tulis 300 ms
//! karena batch transfer bisa memicu banyak entri sekaligus; di sini tulisnya
//! langsung. Bedanya hanya beban disk saat batch besar — tidak ada perubahan
//! perilaku yang bisa dilihat klien, dan tidak ada entri yang bisa hilang
//! kalau proses dimatikan tepat setelah transfer selesai.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const MAX_ENTRIES: usize = 200;

pub struct History {
    path: PathBuf,
    entries: Mutex<Vec<Value>>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl History {
    pub fn load(data_dir: &std::path::Path) -> History {
        let path = data_dir.join("history.json");
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        History {
            path,
            entries: Mutex::new(entries),
        }
    }

    fn write_now(&self) {
        let Ok(entries) = self.entries.lock() else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string(&*entries).unwrap_or_else(|_| "[]".to_string());
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    pub fn add(&self, entry: Value) {
        {
            let Ok(mut entries) = self.entries.lock() else {
                return;
            };
            let direction = if entry.get("direction").and_then(|v| v.as_str()) == Some("receive") {
                "receive"
            } else {
                "send"
            };
            let id = entry
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let seed = now_ms() as u64;
                    format!("{seed:x}{:x}", seed % 7919)
                });
            let item = json!({
                "id": id,
                "ts": now_ms(),
                "direction": direction,
                "fileName": entry.get("fileName").and_then(|v| v.as_str()).unwrap_or("?"),
                "fileSize": entry.get("fileSize").and_then(|v| v.as_f64()).unwrap_or(0.0),
                "peer": entry.get("peer").and_then(|v| v.as_str()).unwrap_or("?"),
                "status": entry.get("status").and_then(|v| v.as_str()).unwrap_or("completed"),
                "reason": entry.get("reason").cloned().unwrap_or(Value::Null),
                "savedTo": entry.get("savedTo").cloned().unwrap_or(Value::Null),
                "thumbnailId": entry.get("thumbnailId").cloned().unwrap_or(Value::Null),
                "resumed": entry.get("resumed").and_then(|v| v.as_bool()).unwrap_or(false),
            });
            entries.insert(0, item);
            entries.truncate(MAX_ENTRIES);
        }
        self.write_now();
    }

    pub fn list(&self) -> Vec<Value> {
        self.entries.lock().map(|e| e.clone()).unwrap_or_default()
    }

    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
        self.write_now();
    }
}
