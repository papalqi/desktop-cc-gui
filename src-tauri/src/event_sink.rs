use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

const FLUSH_INTERVAL: Duration = Duration::from_millis(32);
// Chat already coalesces updates per animation frame and budgets Markdown
// parsing separately. Keep IPC batching, but don't add two frames of waiting.
const CHAT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_BYTES: usize = 64 * 1024;

pub const ENGINE_EVENT_NAME: &str = "engine://event";

/// 插件 agent 轮次的事件流名（plugin_caps::plugin_agent_start）：独立于
/// 聊天引擎流，前端插件运行时监听此名并路由回属主插件。
pub const PLUGIN_AGENT_EVENT_NAME: &str = "plugin-agent://event";
/// 任务工作台 agent 节点的事件流名（mission::mission_agent_start）：与
/// 聊天和插件流隔离，前端 mission runtime 按 run id 路由回对应节点。
pub const MISSION_AGENT_EVENT_NAME: &str = "mission-agent://event";
pub const SESSIONS_CHANGED_EVENT: &str = "sessions://changed";
pub const SCAN_PROGRESS_EVENT: &str = "scan://progress";
pub const INSTALL_PROGRESS_EVENT: &str = "plugin://install-progress";
pub const CLI_UPDATE_PROGRESS_EVENT: &str = "cli://update-progress";

/// History-scan progress for the status bar; `finished` marks the last event
/// of a scan run.
#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
    pub finished: bool,
}

/// Local plugin-install copy progress for the manager UI; `finished` marks
/// the last event of an install run. done/total are bytes.
#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub done: u64,
    pub total: u64,
    pub finished: bool,
}

/// Events are serialized once at push time; flush then only joins the cached
/// byte strings into a JSON array (previously every event serialized twice).
struct Pending {
    events: Vec<String>,
    bytes: usize,
    scheduled: bool,
}

/// Runtime-agnostic event emitter so tests can drive the mock runtime.
/// Payloads arrive as pre-serialized JSON text.
pub trait Emit: Send + Sync {
    fn emit_json(&self, name: &str, raw_json: &str);
}

impl<R: tauri::Runtime> Emit for tauri::AppHandle<R> {
    fn emit_json(&self, name: &str, raw_json: &str) {
        // RawValue re-emits the exact bytes — no parse/re-serialize roundtrip.
        if let Ok(raw) = serde_json::value::RawValue::from_string(raw_json.to_string()) {
            let _ = self.emit(name, raw);
        }
    }
}
/// Fan-out emitter: the webview plus any attached web-access WS broadcaster
/// (web.rs). Targets are Arc-cloned out of the lock before emitting so a slow
/// target never holds the registry lock.
pub struct BroadcastEmit {
    targets: Mutex<Vec<(u64, Arc<dyn Emit>)>>,
    next_id: AtomicU64,
}

impl BroadcastEmit {
    pub fn new(target: Arc<dyn Emit>) -> Arc<Self> {
        Arc::new(Self {
            targets: Mutex::new(vec![(0, target)]),
            next_id: AtomicU64::new(1),
        })
    }

    /// Register an additional target; the returned id removes it again.
    pub fn add(&self, target: Arc<dyn Emit>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut targets = self.targets.lock().unwrap_or_else(|e| e.into_inner());
        targets.push((id, target));
        id
    }

    pub fn remove(&self, id: u64) {
        let mut targets = self.targets.lock().unwrap_or_else(|e| e.into_inner());
        targets.retain(|(target_id, _)| *target_id != id);
    }
}

impl Emit for BroadcastEmit {
    fn emit_json(&self, name: &str, raw_json: &str) {
        let targets: Vec<Arc<dyn Emit>> = {
            let guard = self.targets.lock().unwrap_or_else(|e| e.into_inner());
            guard.iter().map(|(_, t)| Arc::clone(t)).collect()
        };
        for target in targets {
            target.emit_json(name, raw_json);
        }
    }
}

pub struct EventSink {
    emitter: Arc<dyn Emit>,
    name: &'static str,
    inner: Mutex<Pending>,
    flush_interval: Duration,
    journal: Option<Arc<crate::db::Db>>,
    // Commit and broadcast in the same order even when a size-triggered flush
    // races the timer. The cursor describes delivery order as well as storage.
    flush_lock: Mutex<()>,
}

impl EventSink {
    pub fn new(emitter: Arc<dyn Emit>) -> Arc<Self> {
        Self::with_interval(emitter, ENGINE_EVENT_NAME, CHAT_FLUSH_INTERVAL)
    }

    pub fn with_journal(emitter: Arc<dyn Emit>, db: Arc<crate::db::Db>) -> Arc<Self> {
        let mut sink = Self::new(emitter);
        Arc::get_mut(&mut sink).unwrap().journal = Some(db);
        sink
    }

    pub(crate) fn journals_chat(&self) -> bool { self.journal.is_some() }

    pub(crate) fn diagnostics(&self) -> Result<Value, String> {
        let pending = self.inner.lock().map_err(|_| "event queue unavailable")?;
        Ok(serde_json::json!({ "pendingEvents": pending.events.len(), "pendingBytes": pending.bytes,
            "flushScheduled": pending.scheduled, "flushIntervalMs": self.flush_interval.as_millis(),
            "durable": self.journal.is_some() }))
    }

    /// Batched sink emitting under a custom event name (e.g. terminal output).
    pub fn with_name(emitter: Arc<dyn Emit>, name: &'static str) -> Arc<Self> {
        Self::with_interval(emitter, name, FLUSH_INTERVAL)
    }

    fn with_interval(
        emitter: Arc<dyn Emit>,
        name: &'static str,
        flush_interval: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            emitter,
            name,
            flush_interval,
            journal: None,
            flush_lock: Mutex::new(()),
            inner: Mutex::new(Pending {
                events: Vec::new(),
                bytes: 0,
                scheduled: false,
            }),
        })
    }

    pub fn push(self: &Arc<Self>, event: Value) {
        crate::diagnostics::engine_event(&event);
        let Ok(json) = serde_json::to_string(&event) else {
            return;
        };
        let mut flush_now = false;
        {
            let mut pending = match self.inner.lock() {
                Ok(p) => p,
                Err(poisoned) => poisoned.into_inner(),
            };
            pending.bytes += json.len();
            pending.events.push(json);
            if pending.bytes >= FLUSH_BYTES {
                flush_now = true;
            } else if !pending.scheduled {
                pending.scheduled = true;
                let this = Arc::downgrade(self);
                let interval = self.flush_interval;
                tokio::spawn(async move {
                    tokio::time::sleep(interval).await;
                    if let Some(this) = this.upgrade() { this.flush(); }
                });
            }
        }
        if flush_now {
            self.flush();
        }
    }

    pub fn flush(&self) {
        let _flush = self.flush_lock.lock().unwrap_or_else(|e| e.into_inner());
        let events: Vec<String> = {
            let mut pending = match self.inner.lock() {
                Ok(p) => p,
                Err(poisoned) => poisoned.into_inner(),
            };
            if pending.events.is_empty() {
                pending.scheduled = false;
                return;
            }
            pending.bytes = 0;
            pending.scheduled = false;
            std::mem::take(&mut pending.events)
        };
        let events = if let Some(db) = &self.journal {
            match crate::history::journal::append(db, &events) {
                Ok(saved) => saved,
                Err(error) => {
                    eprintln!("[chat-history] could not persist event batch: {error}");
                    crate::history::journal::mark_incomplete(db, &events);
                    self.emitter.emit_json("engine://history-error", "null");
                    events
                }
            }
        } else { events };
        let payload = format!("[{}]", events.join(","));
        self.emitter.emit_json(self.name, &payload);
    }

    /// Non-batched immediate emit for low-frequency signals.
    pub fn emit_sessions_changed(&self) {
        self.emitter.emit_json(SESSIONS_CHANGED_EVENT, "null");
    }
    /// Non-batched immediate emit; the scan loop self-throttles.
    pub fn emit_scan_progress(&self, progress: ScanProgress) {
        if let Ok(json) = serde_json::to_string(&progress) {
            self.emitter.emit_json(SCAN_PROGRESS_EVENT, &json);
        }
    }
    /// Non-batched immediate emit; the install copy self-throttles.
    pub fn emit_install_progress(&self, progress: InstallProgress) {
        if let Ok(json) = serde_json::to_string(&progress) {
            self.emitter.emit_json(INSTALL_PROGRESS_EVENT, &json);
        }
    }
}

impl Drop for EventSink {
    fn drop(&mut self) { self.flush(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn diagnostics_observe_queue_size_without_flushing_or_exposing_contents() {
        struct Recorder(Mutex<Vec<String>>);
        impl Emit for Recorder {
            fn emit_json(&self, _: &str, raw: &str) { self.0.lock().unwrap().push(raw.into()); }
        }
        let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
        let sink = EventSink::with_name(recorder.clone(), "test");
        sink.push(json!({ "data": "private-prompt-and-key" }));
        let diagnostics = sink.diagnostics().unwrap();
        assert_eq!(diagnostics["pendingEvents"], 1);
        assert!(diagnostics["pendingBytes"].as_u64().unwrap() > 0);
        assert!(!diagnostics.to_string().contains("private"));
        assert!(recorder.0.lock().unwrap().is_empty());
        sink.flush();
        assert_eq!(sink.diagnostics().unwrap()["pendingEvents"], 0);
        assert_eq!(recorder.0.lock().unwrap().len(), 1);
    }

    struct VerifySaved {
        db: Arc<crate::db::Db>,
        cursors: Mutex<Vec<i64>>,
    }
    impl Emit for VerifySaved {
        fn emit_json(&self, name: &str, raw: &str) {
            assert_eq!(name, ENGINE_EVENT_NAME);
            let events: Vec<Value> = serde_json::from_str(raw).unwrap();
            for event in events {
                let cursor = event["cursor"].as_i64().unwrap();
                let stored: String = self.db.0.lock().query_row("SELECT payload FROM chat_events WHERE cursor=?1", [cursor], |r| r.get(0)).unwrap();
                assert_eq!(serde_json::from_str::<Value>(&stored).unwrap()["data"], event["data"]);
                let mut cursors = self.cursors.lock().unwrap();
                assert!(cursors.last().is_none_or(|last| *last < cursor));
                cursors.push(cursor);
            }
        }
    }

    #[tokio::test]
    async fn commits_before_broadcast_and_keeps_flush_order() {
        let path = std::env::temp_dir().join(format!("ccgui-sink-{}.db", uuid::Uuid::new_v4()));
        let db = Arc::new(crate::db::Db::open_at(&path).unwrap());
        crate::history::journal::begin(&db,"r","codex",Some("s"),"/ws",1,None).unwrap();
        let verify = Arc::new(VerifySaved { db: db.clone(), cursors: Mutex::new(Vec::new()) });
        let sink = EventSink::with_journal(verify.clone(), db.clone());
        for seq in 0..100 {
            sink.push(json!({"runId":"r","sessionId":"s","seq":seq,"data":"中文🙂","kind":"delta"}));
            if seq % 3 == 0 { sink.flush(); }
        }
        sink.flush();
        assert_eq!(verify.cursors.lock().unwrap().len(),100);
        drop(sink); drop(verify); drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn dropping_the_last_sink_saves_pending_events_without_a_timer_owner() {
        let path = std::env::temp_dir().join(format!("ccgui-sink-drop-{}.db", uuid::Uuid::new_v4()));
        let db = Arc::new(crate::db::Db::open_at(&path).unwrap());
        crate::history::journal::begin(&db,"r","codex",Some("s"),"/ws",1,None).unwrap();
        let verify = Arc::new(VerifySaved { db:db.clone(), cursors:Mutex::new(Vec::new()) });
        let sink = EventSink::with_journal(verify.clone(),db.clone());
        let weak = Arc::downgrade(&sink);
        sink.push(json!({"runId":"r","sessionId":"s","seq":0,"data":"末尾🙂","kind":"delta"}));
        drop(sink);
        assert!(weak.upgrade().is_none());
        assert_eq!(verify.cursors.lock().unwrap().len(),1);
        drop(verify); drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
