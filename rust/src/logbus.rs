//! Log ring-buffer — padanan `server/logbus.js`.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEPTH: usize = 300;

#[derive(Clone, serde::Serialize)]
pub struct LogLine {
    pub id: u64,
    pub ts: u128,
    pub level: String,
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct Tail {
    pub lines: Vec<LogLine>,
    #[serde(rename = "lastId")]
    pub last_id: u64,
    pub depth: usize,
}

pub struct LogBus {
    inner: Mutex<(VecDeque<LogLine>, u64)>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl LogBus {
    pub fn new() -> LogBus {
        LogBus {
            inner: Mutex::new((VecDeque::with_capacity(DEPTH), 1)),
        }
    }

    pub fn record(&self, level: &str, text: impl Into<String>) {
        if let Ok(mut inner) = self.inner.lock() {
            let next = inner.1;
            inner.1 = inner.1.saturating_add(1);
            inner.0.push_back(LogLine {
                id: next,
                ts: now_ms(),
                level: level.to_string(),
                text: text.into(),
            });
            while inner.0.len() > DEPTH {
                inner.0.pop_front();
            }
        }
    }

    pub fn tail(&self, since_id: u64) -> Tail {
        match self.inner.lock() {
            Ok(inner) => Tail {
                lines: inner
                    .0
                    .iter()
                    .filter(|line| line.id > since_id)
                    .cloned()
                    .collect(),
                last_id: inner.1.saturating_sub(1),
                depth: DEPTH,
            },
            Err(_) => Tail {
                lines: Vec::new(),
                last_id: 0,
                depth: DEPTH,
            },
        }
    }
}

impl Default for LogBus {
    fn default() -> Self {
        Self::new()
    }
}
