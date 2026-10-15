//! Persistent operational diagnostics. Conversation deltas and tool output never enter this journal.
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const AGE_MS: u64 = 7 * 86400000;
const CAPACITY: u64 = 50000;
const PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;
const ENTRY_BYTES: usize = 16384;
static LOGGER: OnceLock<Journal> = OnceLock::new();
static WRITE_FAILED: AtomicBool = AtomicBool::new(false);
type Observer = Arc<dyn Fn(Value) + Send + Sync>;

// Preserve the existing stderr output while recording its operational context.
macro_rules! eprintln {
    () => { std::eprintln!() };
    ($($arg:tt)*) => {{
        let message = format!($($arg)*);
        std::eprintln!("{}", message);
        crate::diagnostics::stderr(module_path!(), file!(), line!(), &message);
    }};
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn clipped(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) { end -= 1; }
    text[..end].to_owned()
}

fn redact(text: &str, secrets: &[String]) -> String {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| vec![
        (regex::Regex::new(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+").unwrap(), "$1 [redacted]"),
        (regex::Regex::new(r"(?i)((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+").unwrap(), "${1}[redacted]"),
        (regex::Regex::new(r"(?i)(\b(?:user|assistant|system)\s*[:=]\s*)[^\r\n]+").unwrap(), "${1}[redacted]"),
        (regex::Regex::new(r#"(?i)(["']?(?:[\w-]*(?:token|password|secret|api[_-]?key)|prompt|messages?|content|text|output|result)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s&,;]+)"#).unwrap(), "${1}[redacted]"),
        (regex::Regex::new(r"(?i)(https?://)[^/@\s]+:[^/@\s]+@").unwrap(), "${1}[redacted]@"),
    ]);
    let mut result = text.to_owned();
    for secret in secrets { if !secret.is_empty() { result = result.replace(secret, "[redacted]"); } }
    for (pattern, replacement) in patterns { result = pattern.replace_all(&result, *replacement).into_owned(); }
    clipped(&result, 8192)
}

pub(crate) fn private_values(value: &Value) -> Vec<String> {
    fn visit(value: &Value, values: &mut Vec<String>, depth: usize) {
        if depth > 6 { return; }
        match value {
            Value::Object(object) => for (key, item) in object {
                let key = key.to_ascii_lowercase();
                if ["token", "password", "secret", "key", "authorization", "cookie", "prompt", "message", "content", "text"].iter().any(|part| key.contains(part)) {
                    if let Some(text) = item.as_str().filter(|text| text.len() >= 4) { values.push(text.to_owned()); }
                }
                visit(item, values, depth + 1);
            },
            Value::Array(items) => for item in items { visit(item, values, depth + 1); },
            _ => {}
        }
    }
    let mut values = Vec::new();
    visit(value, &mut values, 0);
    values
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LogQuery {
    pub after_id: u64,
    pub until_id: Option<u64>,
    pub since: Option<u64>,
    pub until: Option<u64>,
    pub limit: Option<usize>,
    pub category: Option<String>,
    pub level: Option<String>,
    pub source: Option<String>,
    pub engine: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub q: Option<String>,
}

impl LogQuery {
    pub fn validate(&self, maximum: usize) -> Result<(), String> {
        if self.limit.is_some_and(|limit| limit == 0 || limit > maximum)
            || self.after_id > i64::MAX as u64 || self.until_id.is_some_and(|id| id > i64::MAX as u64)
            || self.since.is_some_and(|at| at > i64::MAX as u64) || self.until.is_some_and(|at| at > i64::MAX as u64)
            || self.since.zip(self.until).is_some_and(|(since, until)| since > until)
            || self.category.as_deref().is_some_and(|value| !["performance", "error", "exception", "lifecycle"].contains(&value))
            || self.level.as_deref().is_some_and(|value| !["info", "warn", "error"].contains(&value))
            || [&self.source, &self.engine, &self.session_id, &self.run_id, &self.q].iter().any(|value| value.as_ref().is_some_and(|value| value.is_empty() || value.len() > 512)) {
            return Err("Invalid log query".into());
        }
        Ok(())
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry<'a> {
    pub category: &'a str,
    pub level: &'a str,
    pub source: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Value>,
}

struct Storage { db: Connection, count: u64, bytes: u64, last_trim: u64 }
struct Journal { storage: Mutex<Storage>, secrets: Mutex<Vec<String>>, observer: Mutex<Option<Observer>>, epoch: String }

impl Storage {
    fn trim(&mut self) -> rusqlite::Result<()> {
        let now = now_ms();
        if now.saturating_sub(self.last_trim) < 60000 && self.count <= CAPACITY && self.bytes <= PAYLOAD_BYTES { return Ok(()); }
        self.last_trim = now;
        self.db.execute("DELETE FROM logs WHERE at<?", [now.saturating_sub(AGE_MS)])?;
        self.db.execute("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id DESC LIMIT -1 OFFSET ?)", [CAPACITY])?;
        (self.count, self.bytes) = self.db.query_row("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM logs", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        while self.bytes > PAYLOAD_BYTES {
            let (last, count, bytes): (u64, u64, u64) = self.db.query_row("SELECT MAX(id),COUNT(*),SUM(bytes) FROM (SELECT id,bytes FROM logs ORDER BY id LIMIT 256)", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            self.db.execute("DELETE FROM logs WHERE id<=?", [last])?;
            self.count -= count; self.bytes -= bytes;
        }
        Ok(())
    }
}

impl Journal {
    fn open(path: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(path.parent().ok_or("Missing log directory")?).map_err(|error| error.to_string())?;
        let db = Connection::open(path).map_err(|error| error.to_string())?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, category TEXT NOT NULL,
              level TEXT NOT NULL, source TEXT NOT NULL, engine TEXT, sessionId TEXT, runId TEXT, bytes INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS logs_time ON logs(at);").map_err(|error| error.to_string())?;
        let epoch: String = db.query_row("SELECT value FROM metadata WHERE key='epoch'", [], |row| row.get(0)).unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
        db.execute("INSERT OR IGNORE INTO metadata VALUES ('epoch',?)", [&epoch]).map_err(|error| error.to_string())?;
        let (count, bytes) = db.query_row("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM logs", [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
        let mut storage = Storage { db, count, bytes, last_trim: 0 };
        storage.trim().map_err(|error| error.to_string())?;
        let secrets = std::env::vars().filter(|(key, _)| ["TOKEN", "PASSWORD", "SECRET", "KEY"].iter().any(|part| key.to_ascii_uppercase().contains(part))).map(|(_, value)| value).filter(|value| !value.is_empty()).collect();
        Ok(Self { storage: Mutex::new(storage), secrets: Mutex::new(secrets), observer: Mutex::new(None), epoch })
    }

    fn append(&self, entry: Entry<'_>, extra_secrets: &[String], nonblocking: bool) -> Result<(), String> {
        let mut value = serde_json::to_value(entry).map_err(|error| error.to_string())?;
        let secrets = if nonblocking { self.secrets.try_lock().map_err(|_| "Log secrets busy")? } else { self.secrets.lock().map_err(|_| "Log secrets unavailable")? };
        let all_secrets: Vec<String> = secrets.iter().chain(extra_secrets).cloned().collect();
        drop(secrets);
        for (_, field) in value.as_object_mut().unwrap().iter_mut() {
            if let Value::String(text) = field { *text = redact(text, &all_secrets); }
        }
        value["at"] = json!(now_ms()); value["origin"] = json!("executor");
        let mut payload = value.to_string();
        while payload.len() > ENTRY_BYTES {
            let key = if value["stack"].as_str().is_some_and(|text| text.len() > 512) { "stack" } else { "message" };
            let text = value[key].as_str().ok_or("Log entry exceeds size limit")?;
            if text.len() <= 512 { return Err("Log entry exceeds size limit".into()); }
            value[key] = json!(clipped(text, text.len() / 2)); payload = value.to_string();
        }
        let mut storage = if nonblocking { self.storage.try_lock().map_err(|_| "Log storage busy")? } else { self.storage.lock().map_err(|_| "Log storage unavailable")? };
        storage.db.execute("INSERT INTO logs(at,category,level,source,engine,sessionId,runId,bytes,payload) VALUES (?,?,?,?,?,?,?,?,?)",
            params![value["at"].as_u64(), value["category"].as_str(), value["level"].as_str(), value["source"].as_str(),
                value["engine"].as_str(), value["sessionId"].as_str(), value["runId"].as_str(), payload.len(), payload]).map_err(|error| error.to_string())?;
        value["id"] = json!(storage.db.last_insert_rowid()); value["epoch"] = json!(self.epoch);
        storage.count += 1; storage.bytes += payload.len() as u64;
        storage.trim().map_err(|error| error.to_string())?;
        drop(storage);
        let observer = self.observer.lock().ok().and_then(|observer| observer.clone());
        if let Some(observer) = observer { observer(value); }
        Ok(())
    }

    fn query(&self, query: &LogQuery) -> Result<Value, String> {
        query.validate(1000)?;
        let mut storage = self.storage.lock().map_err(|_| "Log storage unavailable")?;
        storage.trim().map_err(|error| error.to_string())?;
        let head: u64 = storage.db.query_row("SELECT seq FROM sqlite_sequence WHERE name='logs'", [], |row| row.get(0)).unwrap_or(0);
        let head = query.until_id.unwrap_or(head).min(head);
        let oldest: Option<u64> = storage.db.query_row("SELECT MIN(id) FROM logs", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        let mut sql = "SELECT id,payload FROM logs WHERE id>? AND id<=?".to_owned();
        let mut values: Vec<rusqlite::types::Value> = vec![(query.after_id as i64).into(), (head as i64).into()];
        for (key, value) in [("category", &query.category), ("level", &query.level), ("source", &query.source), ("engine", &query.engine), ("sessionId", &query.session_id), ("runId", &query.run_id)] {
            if let Some(value) = value { sql.push_str(&format!(" AND {key}=?")); values.push(value.clone().into()); }
        }
        if let Some(since) = query.since { sql.push_str(" AND at>=?"); values.push((since as i64).into()); }
        if let Some(until) = query.until { sql.push_str(" AND at<=?"); values.push((until as i64).into()); }
        if let Some(text) = &query.q { sql.push_str(" AND instr(payload,?)>0"); values.push(text.clone().into()); }
        let limit = query.limit.unwrap_or(50);
        sql.push_str(" ORDER BY id LIMIT ?"); values.push(((limit + 1) as i64).into());
        let mut statement = storage.db.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(values), |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
        let mut entries = Vec::new();
        for row in rows {
            let (id, payload) = row.map_err(|error| error.to_string())?;
            let mut entry: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            entry["id"] = json!(id); entry["epoch"] = json!(self.epoch); entries.push(entry);
        }
        let has_more = entries.len() > limit;
        entries.truncate(limit);
        let next = if has_more { entries.last().unwrap()["id"].as_u64().unwrap() } else { query.after_id.max(head) };
        Ok(json!({ "epoch": self.epoch, "entries": entries, "head": head, "nextId": next, "hasMore": has_more,
            "oldestId": oldest, "truncated": query.after_id < oldest.unwrap_or(head + 1).saturating_sub(1), "retention": retention() }))
    }
}

fn retention() -> Value { json!({ "ageMs": AGE_MS, "capacity": CAPACITY, "payloadBytes": PAYLOAD_BYTES, "entryBytes": ENTRY_BYTES }) }

pub(crate) fn init() {
    match Journal::open(&crate::paths::app_home().join("diagnostics/logs.db")) {
        Ok(journal) => { let _ = LOGGER.set(journal); }
        Err(error) => std::eprintln!("[diagnostics] Could not open log journal: {error}"),
    }
    if let Some(journal) = LOGGER.get() { install_panic_hook(journal); }
    record(Entry { category: "lifecycle", level: "info", source: "runtime", operation: Some("started"), metrics: Some(json!({ "pid": std::process::id() })), ..Entry::default() }, &[]);
}

fn install_panic_hook(journal: &'static Journal) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info.to_string();
        let stack = std::backtrace::Backtrace::force_capture().to_string();
        let result = journal.append(Entry { category: "exception", level: "error", source: "panic", message: Some(&message), stack: Some(&stack), ..Entry::default() }, &[], true);
        WRITE_FAILED.store(result.is_err(), Ordering::Relaxed);
        if let Err(error) = result { std::eprintln!("[diagnostics] Could not persist panic: {error}"); }
        previous(info);
    }));
}

pub(crate) fn observe(observer: Observer) { if let Some(journal) = LOGGER.get() { if let Ok(mut target) = journal.observer.lock() { *target = Some(observer); } } }
pub(crate) fn shutdown() {
    record(Entry { category: "lifecycle", level: "info", source: "runtime", operation: Some("stopped"), ..Entry::default() }, &[]);
    if let Some(journal) = LOGGER.get() { if let Ok(mut observer) = journal.observer.lock() { observer.take(); } }
}
pub(crate) fn register_secret(secret: &str) {
    if let Some(journal) = LOGGER.get() { if let Ok(mut secrets) = journal.secrets.lock() { if !secret.is_empty() && !secrets.iter().any(|value| value == secret) { secrets.push(secret.to_owned()); } } }
}
pub(crate) fn record(entry: Entry<'_>, secrets: &[String]) {
    if let Some(journal) = LOGGER.get() {
        let result = journal.append(entry, secrets, false);
        WRITE_FAILED.store(result.is_err(), Ordering::Relaxed);
        if let Err(error) = result { std::eprintln!("[diagnostics] Could not persist log: {error}"); }
    }
}
pub(crate) fn query(query: &LogQuery) -> Result<Value, String> { LOGGER.get().ok_or("Log storage unavailable")?.query(query) }
pub(crate) fn status() -> Value {
    match LOGGER.get().and_then(|journal| journal.storage.lock().ok().map(|storage| (journal, storage))) {
        Some((journal, storage)) => json!({ "available": true, "persistence": "sqlite", "epoch": journal.epoch, "count": storage.count, "bytes": storage.bytes, "lastWriteFailed": WRITE_FAILED.load(Ordering::Relaxed), "retention": retention() }),
        None => json!({ "available": false, "retention": retention() }),
    }
}
pub(crate) fn stderr(source: &str, file: &str, line: u32, message: &str) {
    let lower = message.to_ascii_lowercase();
    let level = if lower.contains("failed") || lower.contains("error") || lower.contains("could not") { "error" }
        else if lower.contains("migrated") || lower.contains("installed") { "info" } else { "warn" };
    record(Entry { category: if level == "info" { "lifecycle" } else { "error" }, level, source, message: Some(message), metrics: Some(json!({ "line": line })), operation: Some(file), ..Entry::default() }, &[]);
}

pub(crate) fn engine_event(event: &Value) {
    let kind = event["kind"].as_str().unwrap_or_default();
    if !["error", "warn", "retry", "permission_denied", "done"].contains(&kind) { return; }
    let text = event["data"].as_str().or_else(|| event["data"]["message"].as_str());
    record(Entry { category: if kind == "done" { "lifecycle" } else { "error" }, level: if kind == "error" { "error" } else if kind == "done" { "info" } else { "warn" },
        source: "engine", operation: Some(kind), message: text, engine: event["engine"].as_str(), session_id: event["sessionId"].as_str(), run_id: event["runId"].as_str(), ..Entry::default() }, &[]);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> std::path::PathBuf { std::env::temp_dir().join(format!("ccgui-logs-{}/logs.db", uuid::Uuid::new_v4())) }

    #[test]
    fn journal_persists_filters_and_fixes_a_page_head_without_conversation_data() {
        let path = path();
        let journal = Journal::open(&path).unwrap();
        for (kind, text) in [("error", "failure token=secret 中文😀"), ("performance", "sample"), ("exception", "panic")] {
            journal.append(Entry { category: kind, level: "error", source: "test", session_id: Some("s"), message: Some(text), ..Entry::default() }, &[], false).unwrap();
        }
        let first = journal.query(&LogQuery { limit: Some(1), ..LogQuery::default() }).unwrap();
        assert_eq!(first["hasMore"], true);
        assert!(!first.to_string().contains("secret"));
        let epoch = first["epoch"].clone();
        drop(journal);
        let journal = Journal::open(&path).unwrap();
        journal.append(Entry { category: "error", level: "error", source: "test", ..Entry::default() }, &[], false).unwrap();
        let rest = journal.query(&LogQuery { after_id: 1, until_id: Some(3), category: Some("exception".into()), session_id: Some("s".into()), ..LogQuery::default() }).unwrap();
        assert_eq!(rest["epoch"], epoch);
        assert_eq!(rest["entries"].as_array().unwrap().len(), 1);
        assert_eq!(rest["nextId"], 3);
        assert_eq!(rest["hasMore"], false);
        drop(journal);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn redaction_covers_credentials_and_unicode_limits() {
        let text = redact("Authorization: Bearer abc\napi_key=xyz prompt=\"private words\" https://u:p@host 中文😀 known", &["known".into()]);
        for private in ["abc", "xyz", "private words", "u:p", "known"] { assert!(!text.contains(private)); }
        assert!(text.contains("中文😀"));
        let stderr = redact("engine stderr: command failed\nUser: private conversation\n{\"content\":\"private body\",\"result\":\"private tool\"}", &[]);
        assert!(stderr.contains("command failed"));
        assert!(!stderr.contains("private"));
        assert!(redact(&"😀".repeat(3000), &[]).len() <= 8192);
        assert!(LogQuery { limit: Some(1001), ..LogQuery::default() }.validate(1000).is_err());
    }

    #[test]
    fn expired_entries_are_removed_without_resetting_the_cursor() {
        let path = path();
        let journal = Journal::open(&path).unwrap();
        journal.append(Entry { category: "error", level: "error", source: "test", ..Entry::default() }, &[], false).unwrap();
        { let mut storage = journal.storage.lock().unwrap(); storage.db.execute("UPDATE logs SET at=1", []).unwrap(); storage.last_trim = 0; }
        let page = journal.query(&LogQuery::default()).unwrap();
        assert!(page["entries"].as_array().unwrap().is_empty());
        assert_eq!(page["nextId"], 1);
        assert_eq!(page["truncated"], true);
        drop(journal);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn panic_hook_records_stack_and_preserves_caught_unwind_and_default_stderr() {
        const ENV: &str = "CCGUI_DIAGNOSTICS_PANIC_TEST";
        if let Some(path) = std::env::var_os(ENV) {
            let journal = Box::leak(Box::new(Journal::open(Path::new(&path)).unwrap()));
            install_panic_hook(journal);
            assert!(std::panic::catch_unwind(|| panic!("panic-test token=private")).is_err());
            return;
        }
        let path = path();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "diagnostics::tests::panic_hook_records_stack_and_preserves_caught_unwind_and_default_stderr", "--nocapture"])
            .env(ENV, &path).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stderr).contains("panic-test"));
        let journal = Journal::open(&path).unwrap();
        let page = journal.query(&LogQuery { category: Some("exception".into()), ..LogQuery::default() }).unwrap();
        assert_eq!(page["entries"].as_array().unwrap().len(), 1);
        assert!(page["entries"][0]["stack"].as_str().unwrap().contains("diagnostics"));
        assert!(!page.to_string().contains("private"));
        drop(journal);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
