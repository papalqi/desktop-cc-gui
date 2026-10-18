//! Revision metadata is durable; canonical message bodies remain in bounded memory.
use super::{
    reader::{
        canonical_session, log_source_signature, read_append_only_prefix, PrefixRead, SessionPage,
    },
    Message,
};
use crate::{db::Db, engine::ProcessRegistry};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

pub(crate) fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS session_log_heads(
        engine TEXT NOT NULL,session_id TEXT NOT NULL,epoch INTEGER NOT NULL,head_rev INTEGER NOT NULL,
        source_signature TEXT NOT NULL,PRIMARY KEY(engine,session_id));
        CREATE TABLE IF NOT EXISTS session_log_rows(
        engine TEXT NOT NULL,session_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,
        hash TEXT NOT NULL,text_hash TEXT NOT NULL,rev INTEGER NOT NULL,deleted INTEGER NOT NULL,payload_bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(engine,session_id,message_id));
        CREATE INDEX IF NOT EXISTS session_log_since ON session_log_rows(engine,session_id,rev);")?;
    let has_bytes = conn
        .prepare("PRAGMA table_info(session_log_rows)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|column| column == "payload_bytes");
    if !has_bytes {
        conn.execute_batch(
            "ALTER TABLE session_log_rows ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
    pub message_id: String,
    pub rev: i64,
    pub seq: i64,
    pub payload: Option<Message>,
    pub deleted: bool,
    #[serde(skip)]
    payload_bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub rows: Vec<LogRow>,
    pub head_rev: i64,
    pub epoch: i64,
    pub next_rev: i64,
    pub has_more: bool,
    pub reset: bool,
    pub origin: String,
    pub event_cursor: Option<i64>,
    pub active_runs: Option<Vec<crate::engine::ActiveRun>>,
    pub settled_run_ids: Option<Vec<String>>,
    pub incomplete_turn: bool,
    pub subagent_history: Vec<Message>,
    pub subagent_history_triggers: Vec<Option<i64>>,
}
struct Snapshot {
    signature: String,
    head: i64,
    epoch: i64,
    rows: Vec<LogRow>,
    page: SessionPage,
    bytes: usize,
    subagent_triggers: Vec<Option<i64>>,
    /// Bytes of the append-only prefix this snapshot parsed. Empty hash means
    /// the snapshot is not a prefix (journal-only or a non-plain source).
    prefix_len: u64,
    prefix_hash: String,
    source_path: PathBuf,
}
#[derive(Default)]
struct Cache {
    entries: HashMap<(String, String, String), Snapshot>,
    bytes: usize,
}
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));
const CACHE_BYTES: usize = 64 * 1024 * 1024;
const CACHE_SESSIONS: usize = 16;
const PAGE_BYTES: usize = 96 * 1024 * 1024;

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn record(
    db: &Db,
    engine: &str,
    session: &str,
    signature: String,
    mut page: SessionPage,
    ids: Vec<String>,
) -> Result<Snapshot, String> {
    let (history, subagent_triggers) = super::reader::subagent_projection(&page.messages);
    page.subagent_history = history;
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (mut epoch, mut head, old_signature) = tx.query_row("SELECT epoch,head_rev,source_signature FROM session_log_heads WHERE engine=?1 AND session_id=?2", params![engine,session], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?))).optional().map_err(|e| e.to_string())?.unwrap_or((1,0,String::new()));
    let old_source: serde_json::Value = serde_json::from_str(&old_signature).unwrap_or_default();
    let new_source: serde_json::Value = serde_json::from_str(&signature).unwrap_or_default();
    let same_native = old_source.is_array()
        && new_source.is_array()
        && old_source[0] == new_source[0]
        && old_source[1] == new_source[1]
        && old_source[2] == new_source[2];
    let same_frames =
        old_source.is_array() && new_source.is_array() && old_source[2] == new_source[2];
    let old_cursor = old_source[3].as_i64().unwrap_or(-1);
    let mut run_heads = HashMap::new();
    {
        let mut stmt = tx.prepare("SELECT r.run_id,COALESCE(MAX(e.cursor),0) FROM chat_runs r LEFT JOIN chat_events e ON e.run_id=r.run_id WHERE r.engine=?1 AND r.session_id=?2 GROUP BY r.run_id").map_err(|e| e.to_string())?;
        for row in stmt
            .query_map(params![engine, session], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?
        {
            let (id, head) = row.map_err(|e| e.to_string())?;
            run_heads.insert(id, head);
        }
    }
    let mut previous = HashMap::new();
    {
        let mut stmt = tx.prepare("SELECT message_id,seq,hash,text_hash,rev,deleted,payload_bytes FROM session_log_rows WHERE engine=?1 AND session_id=?2").map_err(|e| e.to_string())?;
        for row in stmt
            .query_map(params![engine, session], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, bool>(5)?,
                        r.get::<_, i64>(6)?,
                    ),
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (id, meta) = row.map_err(|e| e.to_string())?;
            previous.insert(id, meta);
        }
    }
    let mut bytes = serde_json::to_vec(&page.subagent_history)
        .map_err(|e| e.to_string())?
        .len();
    let mut fresh = Vec::with_capacity(ids.len());
    for (id, message) in ids.into_iter().zip(std::mem::take(&mut page.messages)) {
        let unchanged = if let Some(run) = message.run_id.as_ref() {
            let old_live = old_source[4]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row[0].as_str() == Some(run)));
            let new_live = new_source[4]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row[0].as_str() == Some(run)));
            same_frames
                && run_heads.get(run).is_some_and(|head| *head <= old_cursor)
                && old_live == new_live
        } else {
            same_native && (message.question.is_none() || old_source[4] == new_source[4])
        };
        if let Some(old) = previous
            .get(&id)
            .filter(|old| unchanged && !old.4 && old.0 == message.seq && old.5 > 0)
        {
            bytes += old.5 as usize;
            fresh.push((id, message, old.1.clone(), old.2.clone(), old.5));
            continue;
        }
        let payload = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes += payload.len();
        let identity =
            serde_json::to_vec(&(&message.role, &message.text, &message.args, &message.images))
                .map_err(|e| e.to_string())?;
        fresh.push((
            id,
            message,
            hash(&payload),
            hash(&identity),
            payload.len() as i64,
        ));
    }
    let mut old_order: Vec<_> = previous
        .iter()
        .filter(|(_, row)| !row.4)
        .map(|(id, row)| (row.0, id.as_str()))
        .collect();
    old_order.sort_by_key(|(seq, _)| *seq);
    let new_order: Vec<_> = fresh.iter().map(|(id, _, _, _, _)| id.as_str()).collect();
    let rewritten = !old_order
        .iter()
        .map(|(_, id)| *id)
        .eq(new_order.iter().copied().take(old_order.len()))
        || fresh.iter().any(|(id, _, _, identity, _)| {
            id.starts_with("native:")
                && previous
                    .get(id)
                    .is_some_and(|old| !old.4 && &old.2 != identity)
        });
    if head > 0 && rewritten {
        epoch += 1;
    }
    let mut rows = Vec::with_capacity(fresh.len() + previous.len());
    for (id, message, digest, identity, payload_bytes) in fresh {
        let old = previous.remove(&id);
        let changed = !old
            .as_ref()
            .is_some_and(|row| !row.4 && row.0 == message.seq && row.1 == digest && row.5 > 0);
        let rev = if changed {
            head += 1;
            head
        } else {
            old.unwrap().3
        };
        if changed {
            tx.execute("INSERT INTO session_log_rows(engine,session_id,message_id,seq,hash,text_hash,rev,deleted,payload_bytes) VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8)
            ON CONFLICT(engine,session_id,message_id) DO UPDATE SET seq=excluded.seq,hash=excluded.hash,text_hash=excluded.text_hash,rev=excluded.rev,deleted=0,payload_bytes=excluded.payload_bytes", params![engine,session,id,message.seq,digest,identity,rev,payload_bytes]).map_err(|e| e.to_string())?;
        }
        rows.push(LogRow {
            message_id: id,
            rev,
            seq: message.seq,
            payload: Some(message),
            deleted: false,
            payload_bytes: payload_bytes as usize,
        });
    }
    // Stable deletion order also makes equivalent reads on two hosts reproducible.
    let mut removed: Vec<_> = previous.into_iter().collect();
    removed.sort_by(|a, b| a.0.cmp(&b.0));
    for (id, (seq, _, _, rev, deleted, _)) in removed {
        let rev = if deleted {
            rev
        } else {
            head += 1;
            tx.execute("UPDATE session_log_rows SET deleted=1,rev=?4 WHERE engine=?1 AND session_id=?2 AND message_id=?3",params![engine,session,id,head]).map_err(|e| e.to_string())?;
            head
        };
        rows.push(LogRow {
            message_id: id,
            rev,
            seq,
            payload: None,
            deleted: true,
            payload_bytes: 0,
        });
    }
    tx.execute("INSERT INTO session_log_heads(engine,session_id,epoch,head_rev,source_signature) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(engine,session_id) DO UPDATE SET epoch=excluded.epoch,head_rev=excluded.head_rev,source_signature=excluded.source_signature",params![engine,session,epoch,head,signature]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    rows.sort_by_key(|row| row.rev);
    Ok(Snapshot {
        signature,
        head,
        epoch,
        rows,
        page,
        bytes,
        subagent_triggers,
        prefix_len: 0,
        prefix_hash: String::new(),
        source_path: PathBuf::new(),
    })
}

fn slice(
    snapshot: &Snapshot,
    after: i64,
    epoch: Option<i64>,
    until: Option<i64>,
    limit: usize,
) -> LogPage {
    // An in-flight copy pins the head it started from. Later appends belong
    // to the next call. A requested head past this snapshot, or an epoch
    // change, is still a rewrite.
    let pinned = until.filter(|head| *head <= snapshot.head);
    let reset = after > snapshot.head
        || epoch.is_some_and(|value| value != snapshot.epoch)
        || until.is_some_and(|head| head > snapshot.head);
    let ceiling = if reset {
        snapshot.head
    } else {
        pinned.unwrap_or(snapshot.head)
    };
    let mut rows = Vec::new();
    let mut bytes = 0;
    let mut has_more = false;
    if !reset {
        for row in snapshot
            .rows
            .iter()
            .filter(|row| row.rev > after && row.rev <= ceiling)
        {
            let size = row.payload_bytes + row.message_id.len() * 6 + 256;
            if rows.len() >= limit || !rows.is_empty() && bytes + size > PAGE_BYTES {
                has_more = true;
                break;
            }
            bytes += size;
            rows.push(row.clone());
        }
    }
    let next_rev = if reset {
        0
    } else if has_more {
        rows.last().map_or(after, |row| row.rev)
    } else {
        ceiling
    };
    LogPage {
        rows,
        head_rev: if reset { snapshot.head } else { ceiling },
        epoch: snapshot.epoch,
        next_rev,
        has_more,
        reset,
        origin: snapshot.page.origin.clone(),
        event_cursor: snapshot.page.event_cursor,
        active_runs: snapshot.page.active_runs.clone(),
        settled_run_ids: snapshot.page.settled_run_ids.clone(),
        incomplete_turn: snapshot.page.incomplete_turn,
        subagent_history: snapshot.page.subagent_history.clone(),
        subagent_history_triggers: snapshot.subagent_triggers.clone(),
    }
}

#[cfg(test)]
fn read(
    db: &Db,
    processes: &ProcessRegistry,
    engine: &str,
    session: &str,
    after: i64,
    epoch: Option<i64>,
    until: Option<i64>,
    limit: Option<usize>,
) -> Result<LogPage, String> {
    read_source(
        db, processes, engine, session, after, epoch, until, limit, None,
    )
}

fn stored_head(db: &Db, engine: &str, session: &str) -> Result<Option<(i64, i64)>, String> {
    db.0.lock()
        .query_row(
            "SELECT head_rev,epoch FROM session_log_heads WHERE engine=?1 AND session_id=?2",
            params![engine, session],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// The cached prefix is still the bytes we parsed. A shorter file or a
/// different hash is a rewrite and must not be served from this snapshot.
fn prefix_intact(snapshot: &Snapshot) -> bool {
    if snapshot.prefix_hash.is_empty() {
        return false;
    }
    let mut file = match std::fs::File::open(&snapshot.source_path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    if meta.len() < snapshot.prefix_len {
        return false;
    }
    let mut buf = vec![0u8; snapshot.prefix_len as usize];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    hash(&buf) == snapshot.prefix_hash
}

fn note_source_movement(
    engine: &str,
    session: &str,
    attempts: u32,
    started: std::time::Instant,
    grew: bool,
    prefix_bytes: u64,
    message: &'static str,
) {
    crate::diagnostics::record(
        crate::diagnostics::Entry {
            category: "performance",
            level: "info",
            source: "sync",
            operation: Some("session_log_since"),
            message: Some(message),
            engine: Some(engine),
            session_id: Some(session),
            duration_ms: Some(started.elapsed().as_millis() as u64),
            metrics: Some(serde_json::json!({
                "attempts": attempts,
                "fileGrew": grew,
                "prefixBytes": prefix_bytes,
            })),
            ..crate::diagnostics::Entry::default()
        },
        &[],
    );
}

fn publish(
    cache: &mut Cache,
    key: (String, String, String),
    snapshot: Snapshot,
    after: i64,
    epoch: Option<i64>,
    until: Option<i64>,
    limit: usize,
) -> Result<LogPage, String> {
    let result = slice(&snapshot, after, epoch, until, limit);
    if let Some(old) = cache.entries.remove(&key) {
        cache.bytes = cache.bytes.saturating_sub(old.bytes);
    }
    if snapshot.bytes <= CACHE_BYTES {
        if cache.entries.len() >= CACHE_SESSIONS || cache.bytes + snapshot.bytes > CACHE_BYTES {
            cache.entries.clear();
            cache.bytes = 0;
        }
        cache.bytes += snapshot.bytes;
        cache.entries.insert(key, snapshot);
    }
    Ok(result)
}

fn read_source(
    db: &Db,
    processes: &ProcessRegistry,
    engine: &str,
    session: &str,
    after: i64,
    epoch: Option<i64>,
    until: Option<i64>,
    limit: Option<usize>,
    source: Option<&Path>,
) -> Result<LogPage, String> {
    if after < 0 || until.is_some_and(|head| head < 0) {
        return Err("revision must be nonnegative".into());
    }
    let database: String =
        db.0.lock()
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name='main'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
    let key = (database, engine.to_string(), session.to_string());
    let limit = limit.unwrap_or(500).clamp(1, 500);
    let started = std::time::Instant::now();
    let mut cache = CACHE.lock().map_err(|e| e.to_string())?;
    let signature = log_source_signature(db, engine, session, processes, source)?;
    let stored = stored_head(db, engine, session)?;
    if let Some(hit) = cache
        .entries
        .get(&key)
        .filter(|hit| hit.signature == signature && stored == Some((hit.head, hit.epoch)))
    {
        return Ok(slice(hit, after, epoch, until, limit));
    }
    if let Some(pinned) = until {
        if let Some(hit) = cache.entries.get(&key) {
            let epoch_ok = epoch.map(|value| value == hit.epoch).unwrap_or(true);
            if epoch_ok && pinned <= hit.head && prefix_intact(hit) {
                return Ok(slice(hit, after, epoch, Some(pinned), limit));
            }
        }
    }
    match read_append_only_prefix(db, engine, session, processes, source)? {
        PrefixRead::Ready(ready) => {
            let ready = *ready;
            if ready.grew_during_read || ready.attempts > 1 {
                note_source_movement(
                    engine,
                    session,
                    ready.attempts,
                    started,
                    ready.grew_during_read,
                    ready.prefix_len,
                    "append-only prefix",
                );
            }
            let mut snapshot = record(db, engine, session, ready.signature, ready.page, ready.ids)?;
            snapshot.prefix_len = ready.prefix_len;
            snapshot.prefix_hash = ready.prefix_hash;
            snapshot.source_path = ready.path;
            publish(&mut cache, key, snapshot, after, epoch, until, limit)
        }
        // Not append-only, or the prefix itself was rewritten. Keep the
        // three full parses: a stable rewrite bumps epoch, a source that
        // keeps changing is still an error.
        PrefixRead::Unsupported | PrefixRead::Rewritten => {
            let mut saw_change = false;
            for attempt in 1..=3u32 {
                let signature = log_source_signature(db, engine, session, processes, source)?;
                let (page, ids) = canonical_session(db, engine, session, processes, source)?;
                if log_source_signature(db, engine, session, processes, source)? != signature {
                    saw_change = true;
                    continue;
                }
                if saw_change {
                    note_source_movement(
                        engine,
                        session,
                        attempt,
                        started,
                        false,
                        0,
                        "source signature stabilized",
                    );
                }
                let snapshot = record(db, engine, session, signature, page, ids)?;
                return publish(&mut cache, key, snapshot, after, epoch, until, limit);
            }
            Err("session changed while reading revision log".into())
        }
    }
}

#[tauri::command]
pub async fn session_log_since(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    after_rev: i64,
    epoch: Option<i64>,
    until_rev: Option<i64>,
    limit: Option<usize>,
    workspace_path: Option<String>,
    remote_path: Option<String>,
) -> Result<LogPage, String> {
    let source = match (workspace_path, remote_path) {
        (None, None) => None,
        (Some(workspace), Some(path)) => Some(
            super::reader::remote_session_cache(&state.db, &workspace, &engine, &session_id, &path)
                .await?,
        ),
        _ => return Err("workspacePath and remotePath must be provided together".into()),
    };
    state.sink.flush();
    let db = state.db.clone();
    let processes = state.processes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_source(
            &db,
            &processes,
            &engine,
            &session_id,
            after_rev,
            epoch,
            until_rev,
            limit,
            source.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-log-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn page(messages: Vec<Message>) -> SessionPage {
        SessionPage {
            messages,
            next_before: None,
            subagent_history: vec![],
            event_cursor: Some(0),
            active_runs: Some(vec![]),
            settled_run_ids: Some(vec![]),
            incomplete_turn: false,
            origin: "hub".into(),
        }
    }
    fn message(seq: i64, role: &str, text: &str) -> Message {
        Message {
            seq,
            role: role.into(),
            text: text.into(),
            ..Default::default()
        }
    }
    fn save(db: &Db, messages: Vec<Message>, ids: &[&str]) -> Snapshot {
        record(
            db,
            "codex",
            "s",
            "signature".into(),
            page(messages),
            ids.iter().map(|id| id.to_string()).collect(),
        )
        .unwrap()
    }

    #[test]
    fn revision_pages_use_durable_body_sizes_to_keep_large_rows_on_separate_pages() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let mut snapshot = save(
            &db,
            vec![message(1, "tool", "one"), message(2, "tool", "two")],
            &["native:1", "native:2"],
        );
        // Size metadata comes from the same serialization used for hashing.
        for row in &mut snapshot.rows {
            assert_eq!(
                row.payload_bytes,
                serde_json::to_vec(row.payload.as_ref().unwrap())
                    .unwrap()
                    .len()
            );
            row.payload_bytes = 64 * 1024 * 1024;
        }
        let first = slice(&snapshot, 0, None, None, 500);
        assert!(first.has_more);
        assert_eq!(first.rows.len(), 1);
        assert_eq!(first.next_rev, 1);
        let last = slice(
            &snapshot,
            first.next_rev,
            Some(first.epoch),
            Some(first.head_rev),
            500,
        );
        assert!(!last.has_more);
        assert_eq!(last.rows.len(), 1);
        assert_eq!(last.next_rev, 2);
    }

    #[test]
    fn revision_snapshots_preserve_subagent_rows_and_their_prefix_boundaries() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let messages = vec![
            message(1, "user", "start"),
            message(2, "tool", "spawn_agent"),
            message(3, "assistant", "done"),
            message(4, "user", "replaced"),
            message(5, "user", "next"),
            message(6, "tool", "spawn_agent"),
            message(7, "assistant", "done"),
            message(8, "user", "pending"),
        ];
        let ids: Vec<_> = messages
            .iter()
            .map(|m| format!("native:{}", m.seq))
            .collect();
        let snapshot = record(&db, "codex", "s", "signature".into(), page(messages), ids).unwrap();
        let log = slice(&snapshot, 0, None, None, 500);
        assert_eq!(
            log.subagent_history
                .iter()
                .map(|row| row.seq)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 5, 6, 7, 8]
        );
        assert_eq!(
            log.subagent_history_triggers,
            vec![Some(2), Some(2), Some(3), Some(6), Some(6), Some(7), None]
        );
        assert_eq!(log.subagent_history[0].text, "");
        assert_eq!(log.subagent_history[1].text, "spawn_agent");
    }

    #[test]
    fn updates_keep_the_message_id_and_revision_metadata_survives_restart() {
        let scratch = Scratch::new();
        let path = scratch.0.join("app.db");
        let db = Db::open_at(&path).unwrap();
        let tool = message(2, "tool", "exec");
        let initial = save(
            &db,
            vec![message(1, "user", "中文🙂"), tool.clone()],
            &["native:1", "run:7"],
        );
        assert_eq!((initial.head, initial.epoch), (2, 1));
        let first = slice(&initial, 0, None, None, 1);
        assert!(first.has_more);
        assert_eq!(first.next_rev, 1);
        let mut patched = tool;
        patched.result = Some(json!({"text":"完整🙂\n```ts\nlet a = 1;\n```"}));
        let changed = save(
            &db,
            vec![message(1, "user", "中文🙂"), patched.clone()],
            &["native:1", "run:7"],
        );
        assert_eq!((changed.head, changed.epoch), (3, 1));
        let delta = slice(&changed, 2, Some(1), None, 500);
        assert_eq!(delta.rows.len(), 1);
        assert_eq!(delta.rows[0].message_id, "run:7");
        assert_eq!(
            delta.rows[0].payload.as_ref().unwrap().result,
            patched.result
        );
        // A tool-result patch grows the head without bumping the epoch. The
        // page that already started stays on the revision it pinned; the
        // patched row is the next call, not a reset.
        let unfinished = slice(&changed, first.next_rev, Some(1), Some(first.head_rev), 500);
        assert!(
            !unfinished.reset,
            "an in-flight copy stays on the revision it started"
        );
        assert_eq!(unfinished.head_rev, first.head_rev);
        assert!(unfinished.rows.iter().all(|row| row.rev <= first.head_rev));
        drop(db);
        let db = Db::open_at(&path).unwrap();
        let reopened = save(
            &db,
            vec![message(1, "user", "中文🙂"), patched],
            &["native:1", "run:7"],
        );
        assert_eq!((reopened.head, reopened.epoch), (3, 1));
        assert!(slice(&reopened, 3, Some(1), None, 500).rows.is_empty());
        let columns: Vec<String> =
            db.0.lock()
                .prepare("PRAGMA table_info(session_log_rows)")
                .unwrap()
                .query_map([], |r| r.get(1))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
        assert!(!columns
            .iter()
            .any(|column| column == "payload" || column == "text"));
    }

    #[test]
    fn rewritten_prefixes_and_deletions_reset_epoch_and_leave_monotone_tombstones() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        save(
            &db,
            vec![message(1, "user", "before"), message(2, "assistant", "old")],
            &["native:1", "native:2"],
        );
        let changed = save(&db, vec![message(1, "user", "after")], &["native:1"]);
        assert_eq!((changed.head, changed.epoch), (4, 2));
        assert!(slice(&changed, 2, Some(1), None, 500).reset);
        let snapshot = slice(&changed, 0, None, None, 500);
        assert_eq!(snapshot.rows.iter().filter(|row| row.deleted).count(), 1);
        assert!(snapshot
            .rows
            .iter()
            .find(|row| row.deleted)
            .unwrap()
            .payload
            .is_none());
        let stable = save(&db, vec![message(1, "user", "after")], &["native:1"]);
        assert_eq!((stable.head, stable.epoch), (4, 2));
    }

    #[test]
    fn real_journal_rows_match_history_and_patches_replace_the_original_event_row() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let event = |seq, kind, data| {
            json!({"runId":"r","sessionId":"s","seq":seq,"kind":kind,"data":data}).to_string()
        };
        super::super::journal::begin_with_origin(
            &db,
            "r",
            "codex",
            Some("s"),
            "/ws",
            1000,
            None,
            "hub",
        )
        .unwrap();
        super::super::journal::launch_result(&db, "r", Some("s"), None).unwrap();
        super::super::journal::append(
            &db,
            &[
                event(0, "message", json!({"role":"user","text":"问题🙂"})),
                event(
                    1,
                    "message",
                    json!({"role":"tool","text":"exec","toolCallId":"t","args":{"command":"test"}}),
                ),
            ],
        )
        .unwrap();
        let processes = ProcessRegistry::default();
        let initial = read(&db, &processes, "codex", "s", 0, None, None, Some(500)).unwrap();
        assert_eq!(initial.rows[1].message_id, "run:r:1");
        super::super::journal::append(&db,&[event(2,"message",json!({"role":"tool","text":"exec","toolCallId":"t","patch":true,"result":{"text":"整段结果🙂"}})),event(3,"delta",json!("回复🙂")),event(4,"done",json!({}))]).unwrap();
        let delta = read(
            &db,
            &processes,
            "codex",
            "s",
            initial.head_rev,
            Some(initial.epoch),
            None,
            Some(500),
        )
        .unwrap();
        assert!(!delta.reset);
        assert_eq!(delta.rows[0].message_id, "run:r:1");
        assert_eq!(
            delta.rows[0].payload.as_ref().unwrap().result,
            Some(json!({"text":"整段结果🙂"}))
        );
        let all = read(&db, &processes, "codex", "s", 0, None, None, Some(500)).unwrap();
        let (canonical, _) = canonical_session(&db, "codex", "s", &processes, None).unwrap();
        let mut copied: Vec<_> = all
            .rows
            .iter()
            .filter_map(|row| row.payload.clone())
            .collect();
        copied.sort_by_key(|row| row.seq);
        assert_eq!(
            serde_json::to_value(copied).unwrap(),
            serde_json::to_value(canonical.messages).unwrap()
        );
        assert_eq!(all.origin, "hub");
    }

    #[test]
    fn remote_transcript_revisions_work_without_a_local_catalog_and_reset_on_rewrite() {
        let scratch = Scratch::new();
        let path = scratch.0.join("remote.jsonl");
        let line = |role: &str, text: &str| {
            json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":if role == "user" {"input_text"} else {"output_text"},"text":text}]}}).to_string()
        };
        let prompt = "远程问题🙂\n```ts\nconst x = 1;\n```";
        let reply = "远程回答甲🙂";
        std::fs::write(
            &path,
            format!("{}\n{}", line("user", prompt), line("assistant", reply)),
        )
        .unwrap();
        let database = scratch.0.join("app.db");
        let db = Db::open_at(&database).unwrap();
        super::super::journal::set_origin(&db, "codex", "remote", "hub").unwrap();
        let processes = ProcessRegistry::default();
        let first = read_source(
            &db,
            &processes,
            "codex",
            "remote",
            0,
            None,
            None,
            Some(1),
            Some(&path),
        )
        .unwrap();
        assert!(first.has_more);
        assert_eq!(first.rows[0].payload.as_ref().unwrap().text, prompt);
        assert_eq!(first.rows[0].message_id, "native:1");
        let second = read_source(
            &db,
            &processes,
            "codex",
            "remote",
            first.next_rev,
            Some(first.epoch),
            Some(first.head_rev),
            Some(500),
            Some(&path),
        )
        .unwrap();
        assert_eq!(second.rows[0].payload.as_ref().unwrap().text, reply);
        assert_eq!(second.origin, "hub");
        assert_eq!(
            db.0.lock()
                .query_row("SELECT count(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(db);
        let db = Db::open_at(&database).unwrap();
        let hot = read_source(
            &db,
            &processes,
            "codex",
            "remote",
            first.head_rev,
            Some(first.epoch),
            None,
            Some(500),
            Some(&path),
        )
        .unwrap();
        assert!(hot.rows.is_empty());
        std::fs::write(
            &path,
            format!(
                "{}\n{}",
                line("user", "远程改写🙂"),
                line("assistant", "远程回答乙🙂")
            ),
        )
        .unwrap();
        let reset = read_source(
            &db,
            &processes,
            "codex",
            "remote",
            first.head_rev,
            Some(first.epoch),
            None,
            Some(500),
            Some(&path),
        )
        .unwrap();
        assert!(reset.reset);
        let copied = read_source(
            &db,
            &processes,
            "codex",
            "remote",
            0,
            None,
            None,
            Some(500),
            Some(&path),
        )
        .unwrap();
        let (canonical, _) =
            canonical_session(&db, "codex", "remote", &processes, Some(&path)).unwrap();
        assert_eq!(
            serde_json::to_value(
                copied
                    .rows
                    .into_iter()
                    .filter_map(|row| row.payload)
                    .collect::<Vec<_>>()
            )
            .unwrap(),
            serde_json::to_value(canonical.messages).unwrap()
        );
    }

    #[test]
    fn large_revision_log_keeps_hot_pages_cached_and_preserves_a_new_turn() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let path = scratch.0.join("large.jsonl");
        let text = "中文🙂".repeat(1638);
        let lines: Vec<_> = (0..600).map(|index| { let role = if index % 2 == 0 { "user" } else { "assistant" };
            json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":if role == "user" {"input_text"} else {"output_text"},"text":format!("{index}:{text}")}]}}).to_string()
        }).collect();
        std::fs::write(&path, lines.join("\n")).unwrap();
        db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES('codex','large','/ws',?1,0,0)",[path.to_string_lossy().as_ref()]).unwrap();
        let processes = ProcessRegistry::default();
        let cold = std::time::Instant::now();
        let initial = read(&db, &processes, "codex", "large", 0, None, None, Some(500)).unwrap();
        let cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(initial.rows.len(), 500);
        assert!(initial.has_more);
        let second = read(
            &db,
            &processes,
            "codex",
            "large",
            initial.next_rev,
            Some(initial.epoch),
            Some(initial.head_rev),
            Some(500),
        )
        .unwrap();
        assert_eq!(second.rows.len(), 100);
        let mut samples = Vec::new();
        for _ in 0..20 {
            let started = std::time::Instant::now();
            let hot = read(
                &db,
                &processes,
                "codex",
                "large",
                initial.head_rev,
                Some(initial.epoch),
                None,
                Some(500),
            )
            .unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert!(hot.rows.is_empty());
        }
        let (native, _) = canonical_session(&db, "codex", "large", &processes, None).unwrap();
        super::super::journal::begin(
            &db,
            "new",
            "codex",
            Some("large"),
            "/ws",
            2000,
            native.messages.last(),
        )
        .unwrap();
        let event = |seq, kind, data| {
            json!({"runId":"new","sessionId":"large","seq":seq,"kind":kind,"data":data}).to_string()
        };
        super::super::journal::append(
            &db,
            &[
                event(0, "message", json!({"role":"user","text":"新问题🙂"})),
                event(1, "delta", json!("回答🙂")),
                event(2, "done", json!({})),
            ],
        )
        .unwrap();
        let started = std::time::Instant::now();
        let delta = read(
            &db,
            &processes,
            "codex",
            "large",
            initial.head_rev,
            Some(initial.epoch),
            None,
            Some(500),
        )
        .unwrap();
        let delta_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(delta.rows.len(), 2);
        assert!(!delta.reset);
        assert_eq!(delta.rows[1].payload.as_ref().unwrap().text, "回答🙂");
        samples.sort_by(f64::total_cmp);
        println!("local revision benchmark: bytes={}, cold_snapshot_ms={cold_ms:.2}, hot_empty_page_p50_ms={:.2}, hot_empty_page_p95_ms={:.2}, new_turn_delta_ms={delta_ms:.2}",std::fs::metadata(&path).unwrap().len(),samples[10],samples[19]);
    }

    #[test]
    fn same_millisecond_native_rewrite_is_not_hidden_by_the_parse_or_revision_cache() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let path = scratch.0.join("rewrite.jsonl");
        let write = |text: &str, nanos| {
            std::fs::write(&path,json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}).to_string()).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(
                    std::time::UNIX_EPOCH + std::time::Duration::new(1_790_000_000, nanos),
                ))
                .unwrap();
        };
        write("before", 123_100);
        db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES('codex','s','/ws',?1,0,0)",[path.to_string_lossy().as_ref()]).unwrap();
        let processes = ProcessRegistry::default();
        let first = read(&db, &processes, "codex", "s", 0, None, None, None).unwrap();
        let old_stat = super::super::stat_signature(&path);
        write("edited", 123_200);
        assert_eq!(old_stat, super::super::stat_signature(&path));
        let reset = read(
            &db,
            &processes,
            "codex",
            "s",
            first.head_rev,
            Some(first.epoch),
            None,
            None,
        )
        .unwrap();
        assert!(reset.reset);
        assert!(reset.epoch > first.epoch);
        let updated = read(&db, &processes, "codex", "s", 0, None, None, None).unwrap();
        assert_eq!(updated.rows[0].payload.as_ref().unwrap().text, "edited");
    }

    fn codex_line(role: &str, text: &str) -> String {
        let kind = if role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":kind,"text":text}]}}).to_string()
    }

    fn insert_codex(db: &Db, path: &std::path::Path, session: &str) {
        db.0.lock().execute(
            "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES('codex',?1,'/ws',?2,0,0)",
            rusqlite::params![session, path.to_string_lossy().as_ref()],
        ).unwrap();
    }

    /// The 3b757e562 reader: signature, full `canonical_session`, signature
    /// again, three tries. A live append changes the stamp on every try.
    fn read_source_3b757e562(
        db: &Db,
        processes: &ProcessRegistry,
        session: &str,
    ) -> Result<(), String> {
        for _ in 0..3 {
            let signature = log_source_signature(db, "codex", session, processes, None)?;
            let _ = canonical_session(db, "codex", session, processes, None)?;
            if log_source_signature(db, "codex", session, processes, None)? != signature {
                continue;
            }
            return Ok(());
        }
        Err("session changed while reading revision log".into())
    }

    #[test]
    fn append_keeps_the_pinned_revision_and_returns_the_tail_once() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let path = scratch.0.join("grow.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                codex_line("user", "one"),
                codex_line("assistant", "two")
            ),
        )
        .unwrap();
        insert_codex(&db, &path, "grow");
        let processes = ProcessRegistry::default();
        let first = read(&db, &processes, "codex", "grow", 0, None, None, Some(500)).unwrap();
        assert_eq!(first.rows.len(), 2);
        assert!(!first.reset);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        writeln!(file, "{}", codex_line("assistant", "three")).unwrap();
        file.flush().unwrap();
        drop(file);
        let pinned = read(
            &db,
            &processes,
            "codex",
            "grow",
            0,
            Some(first.epoch),
            Some(first.head_rev),
            Some(500),
        )
        .unwrap();
        assert!(!pinned.reset);
        assert_eq!(pinned.head_rev, first.head_rev);
        assert_eq!(pinned.epoch, first.epoch);
        let texts: Vec<_> = pinned
            .rows
            .iter()
            .map(|row| row.payload.as_ref().unwrap().text.clone())
            .collect();
        assert_eq!(texts, vec!["one".to_string(), "two".to_string()]);
        let tail = read(
            &db,
            &processes,
            "codex",
            "grow",
            first.head_rev,
            Some(first.epoch),
            None,
            Some(500),
        )
        .unwrap();
        assert!(!tail.reset);
        assert_eq!(tail.rows.len(), 1);
        assert_eq!(tail.rows[0].payload.as_ref().unwrap().text, "three");
        assert!(tail.rows[0].rev > first.head_rev);
    }

    #[test]
    fn pinned_until_does_not_hide_a_rewritten_or_truncated_prefix() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let path = scratch.0.join("rewrite.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                codex_line("user", "before-a"),
                codex_line("assistant", "before-b")
            ),
        )
        .unwrap();
        insert_codex(&db, &path, "rw");
        let processes = ProcessRegistry::default();
        let first = read(&db, &processes, "codex", "rw", 0, None, None, None).unwrap();
        std::fs::write(&path, format!("{}\n", codex_line("user", "after"))).unwrap();
        let reset = read(
            &db,
            &processes,
            "codex",
            "rw",
            0,
            Some(first.epoch),
            Some(first.head_rev),
            None,
        )
        .unwrap();
        assert!(reset.reset);
        assert!(reset.epoch > first.epoch);
        let updated = read(&db, &processes, "codex", "rw", 0, None, None, None).unwrap();
        assert_eq!(updated.rows.iter().filter(|row| !row.deleted).count(), 1);
        assert_eq!(
            updated
                .rows
                .iter()
                .find(|row| !row.deleted)
                .unwrap()
                .payload
                .as_ref()
                .unwrap()
                .text,
            "after"
        );
    }

    #[test]
    fn active_append_converges_and_the_old_three_try_loop_does_not() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.0.join("app.db")).unwrap();
        let path = scratch.0.join("live.jsonl");
        let padding = "中文🙂".repeat(1638);
        let base = 80usize;
        let mut lines = Vec::with_capacity(base);
        let mut expected = Vec::with_capacity(base);
        for index in 0..base {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            let text = format!("base-{index}:{padding}");
            expected.push(text.clone());
            lines.push(codex_line(role, &text));
        }
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        insert_codex(&db, &path, "live");
        let processes = ProcessRegistry::default();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let extras = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writer_path = path.clone();
        let writer_stop = std::sync::Arc::clone(&stop);
        let writer_extras = std::sync::Arc::clone(&extras);
        let writer = std::thread::spawn(move || {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(writer_path)
                .unwrap();
            use std::io::Write;
            while !writer_stop.load(std::sync::atomic::Ordering::Relaxed) {
                let n = writer_extras.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                writeln!(file, "{}", codex_line("assistant", &format!("extra-{n}"))).unwrap();
                file.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        });
        let started = std::time::Instant::now();
        let _ = canonical_session(&db, "codex", "live", &processes, None);
        let parse_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut legacy_error = None;
        for _ in 0..5 {
            match read_source_3b757e562(&db, &processes, "live") {
                Err(error) => {
                    legacy_error = Some(error);
                    break;
                }
                Ok(()) => continue,
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        writer.join().unwrap();
        let extra_count = extras.load(std::sync::atomic::Ordering::Relaxed);
        println!(
            "append race measurement: canonical_session_ms={parse_ms:.2}, legacy={legacy_error:?}, extra_lines={extra_count}, bytes={}",
            std::fs::metadata(&path).unwrap().len()
        );
        let legacy_error = legacy_error.unwrap_or_else(|| {
            panic!(
                "3b757e562 three-try loop did not observe the append race; canonical_session_ms={parse_ms:.2}, extra_lines={extra_count}"
            );
        });
        assert!(
            legacy_error.contains("session changed while reading revision log"),
            "{legacy_error}"
        );
        for n in 0..extra_count {
            expected.push(format!("extra-{n}"));
        }
        let tail_count = 40usize;
        let tail_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let tail_flag = std::sync::Arc::clone(&tail_stop);
        let tail_path = path.clone();
        let tail_writer = std::thread::spawn(move || {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(tail_path)
                .unwrap();
            use std::io::Write;
            for n in 0..tail_count {
                if tail_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                writeln!(file, "{}", codex_line("assistant", &format!("tail-{n}"))).unwrap();
                file.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        });
        for n in 0..tail_count {
            expected.push(format!("tail-{n}"));
        }
        let mut got = Vec::new();
        let mut after = 0i64;
        let mut epoch = None;
        let mut until = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if std::time::Instant::now() > deadline {
                panic!(
                    "reader did not converge; have {} of {}",
                    got.len(),
                    expected.len()
                );
            }
            let page = read_source(
                &db,
                &processes,
                "codex",
                "live",
                after,
                epoch,
                until,
                Some(500),
                None,
            )
            .unwrap_or_else(|error| panic!("active read failed: {error}"));
            if page.reset && !got.is_empty() {
                panic!("reset after {} rows: epoch {}", got.len(), page.epoch);
            }
            for row in &page.rows {
                assert!(!row.deleted);
                if let Some((prev, _)) = got.last() {
                    assert!(row.rev > *prev, "revision went backwards");
                }
                got.push((row.rev, row.payload.as_ref().unwrap().text.clone()));
            }
            if page.has_more {
                after = page.next_rev;
                epoch = Some(page.epoch);
                until = Some(page.head_rev);
                continue;
            }
            if got.len() >= expected.len() {
                break;
            }
            after = page.head_rev;
            epoch = Some(page.epoch);
            until = None;
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        tail_stop.store(true, std::sync::atomic::Ordering::Relaxed);
        tail_writer.join().unwrap();
        let texts: Vec<_> = got.into_iter().map(|(_, text)| text).collect();
        assert_eq!(texts, expected);
    }
}
