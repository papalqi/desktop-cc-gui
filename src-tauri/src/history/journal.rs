//! Durable chat events. The event sink commits a batch before either desktop
//! or web observers see it. Native transcripts still supply pre-existing and
//! externally-created turns; recorded runs replace only their own native turn.
use crate::db::Db;
use super::{Message, parse_ts_ms_str};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(crate) fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS chat_runs(
        run_id TEXT PRIMARY KEY, engine TEXT NOT NULL, session_id TEXT,
        workspace_path TEXT NOT NULL, started_at INTEGER NOT NULL,
        native_before TEXT, complete INTEGER NOT NULL DEFAULT 1);
        CREATE INDEX IF NOT EXISTS chat_runs_session ON chat_runs(engine, session_id);
        CREATE TABLE IF NOT EXISTS chat_events(
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id, seq));
        CREATE TABLE IF NOT EXISTS session_origins(
        engine TEXT NOT NULL, session_id TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin='hub'), adopted_at INTEGER,
        PRIMARY KEY(engine, session_id));
        CREATE TABLE IF NOT EXISTS chat_run_tombstones(run_id TEXT PRIMARY KEY);")?;
    let columns = conn.prepare("PRAGMA table_info(chat_runs)")?.query_map([], |r| r.get::<_,String>(1))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    for (name, definition) in [("origin", "TEXT NOT NULL DEFAULT 'local'"),
        ("state", "TEXT NOT NULL DEFAULT 'reserved'"), ("error", "TEXT")] {
        if !columns.contains(name) {
            conn.execute_batch(&format!("ALTER TABLE chat_runs ADD COLUMN {name} {definition}"))?;
        }
    }
    if !columns.contains("state") {
        conn.execute_batch("UPDATE chat_runs SET state=COALESCE(
            (SELECT CASE json_extract(payload,'$.kind') WHEN 'done' THEN 'done' ELSE 'error' END
             FROM chat_events WHERE run_id=chat_runs.run_id
             AND json_extract(payload,'$.kind') IN ('done','error') ORDER BY seq DESC LIMIT 1), 'spawned')")?;
    }
    Ok(())
}

pub(crate) fn session_origin(db: &Db, engine: &str, session: &str) -> Result<String, String> {
    db.0.lock().query_row("SELECT origin FROM session_origins WHERE engine=?1 AND session_id=?2",
        params![engine, session], |r| r.get(0)).optional().map(|v| v.unwrap_or_else(|| "local".into())).map_err(|e| e.to_string())
}

pub(crate) fn recover_runs(db: &Db) -> Result<(), String> {
    db.0.lock().execute("UPDATE chat_runs SET state='error',error='executor restarted before completion was saved'
        WHERE state IN ('reserved','spawned')", []).map(|_| ()).map_err(|e| e.to_string())
}

pub(crate) fn set_origin(db: &Db, engine: &str, session: &str, origin: &str) -> Result<(), String> {
    if engine.trim().is_empty() || session.trim().is_empty() { return Err("engine and sessionId are required".into()); }
    let conn = db.0.lock();
    match origin {
        "hub" => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
            conn.execute("INSERT INTO session_origins(engine,session_id,origin,adopted_at) VALUES(?1,?2,'hub',?3)
                ON CONFLICT(engine,session_id) DO NOTHING", params![engine, session, now])
                .map_err(|e| e.to_string())?;
        }
        "local" => { conn.execute("DELETE FROM session_origins WHERE engine=?1 AND session_id=?2", params![engine,session])
                .map_err(|e| e.to_string())?; }
        _ => return Err("origin must be hub or local".into()),
    }
    Ok(())
}

#[tauri::command]
pub fn set_session_origin(state: tauri::State<'_, crate::AppState>, engine: String, session_id: String, origin: String) -> Result<(), String> {
    set_origin(&state.db, &engine, &session_id, &origin)?;
    state.sink.emit_sessions_changed();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    run_id: String,
    known: bool,
    state: Option<String>,
    session_id: Option<String>,
    started_at: Option<i64>,
    error: Option<String>,
    origin: Option<String>,
}

pub(crate) fn statuses(db: &Db, run_ids: &[String]) -> Result<Vec<RunStatus>, String> {
    if run_ids.len() > 256 { return Err("runIds must contain at most 256 entries".into()); }
    if run_ids.iter().any(|id| id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))) {
        return Err("invalid run id".into());
    }
    let conn = db.0.lock();
    let mut query = conn.prepare("SELECT state,session_id,started_at,error,origin FROM chat_runs WHERE run_id=?1")
        .map_err(|e| e.to_string())?;
    run_ids.iter().map(|run_id| {
        let row = query.query_row([run_id], |r| Ok(RunStatus {
            run_id: run_id.clone(), known: true, state: Some(r.get(0)?), session_id: r.get(1)?,
            started_at: Some(r.get(2)?), error: r.get(3)?, origin: Some(r.get(4)?),
        })).optional().map_err(|e| e.to_string())?;
        if let Some(row) = row { return Ok(row); }
        // A definitive negative closes this id before a delayed invocation
        // can reserve it. The caller uses a new id for an intentional resend.
        conn.execute("INSERT OR IGNORE INTO chat_run_tombstones(run_id) VALUES(?1)", [run_id]).map_err(|e| e.to_string())?;
        Ok(RunStatus { run_id: run_id.clone(), known: false, state: None,
            session_id: None, started_at: None, error: None, origin: None })
    }).collect()
}

#[tauri::command]
pub fn run_status(state: tauri::State<'_, crate::AppState>, run_ids: Vec<String>) -> Result<Vec<RunStatus>, String> {
    state.sink.flush();
    statuses(&state.db, &run_ids)
}

fn adopt_run(conn: &rusqlite::Connection, run: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO session_origins(engine,session_id,origin,adopted_at)
        SELECT engine,session_id,'hub',started_at FROM chat_runs
        WHERE run_id=?1 AND origin='hub' AND session_id IS NOT NULL
        ON CONFLICT(engine,session_id) DO NOTHING", [run])?;
    Ok(())
}

pub(crate) fn launch_result(db: &Db, run: &str, session: Option<&str>, error: Option<&str>) -> Result<(), String> {
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if let Some(error) = error {
        tx.execute("UPDATE chat_runs SET state='spawn_failed',error=?2 WHERE run_id=?1", params![run,error])
            .map_err(|e| e.to_string())?;
    } else {
        tx.execute("UPDATE chat_runs SET state=CASE WHEN state='reserved' THEN 'spawned' ELSE state END,
            session_id=COALESCE(?2,session_id) WHERE run_id=?1", params![run,session]).map_err(|e| e.to_string())?;
        adopt_run(&tx, run).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) fn begin(
    db: &Db, run_id: &str, engine: &str, session_id: Option<&str>,
    workspace: &str, started_at: u64, native_before: Option<&Message>,
) -> Result<(), String> {
    begin_with_origin(db, run_id, engine, session_id, workspace, started_at, native_before, "local")
}

pub(crate) fn begin_with_origin(
    db: &Db, run_id: &str, engine: &str, session_id: Option<&str>,
    workspace: &str, started_at: u64, native_before: Option<&Message>, origin: &str,
) -> Result<(), String> {
    if !matches!(origin, "local" | "hub") { return Err("origin must be hub or local".into()); }
    let anchor = native_before.map(|m| serde_json::json!({"seq":m.seq,"role":m.role,"text":m.text,"ts":m.ts}).to_string());
    let conn = db.0.lock();
    let closed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM chat_run_tombstones WHERE run_id=?1)", [run_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if closed { return Err("run id is closed; use a new id for an intentional resend".into()); }
    conn.execute(
        "INSERT INTO chat_runs(run_id,engine,session_id,workspace_path,started_at,native_before,origin)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![run_id, engine, session_id, workspace, started_at, anchor, origin],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns the same batch, with committed cursors. Retried identities reuse
/// their original row; content and tool outputs have no display-size cap.
pub(crate) fn append(db: &Db, events: &[String]) -> Result<Vec<String>, String> {
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(events.len());
    for raw in events {
        let mut event: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let run = event["runId"].as_str().ok_or("journal event missing runId")?.to_string();
        let seq = event["seq"].as_i64().ok_or("journal event missing seq")?;
        // Custom/plugin sinks are not journaled. A chat event without a
        // reservation is a programming error, not a successfully saved row.
        tx.execute("INSERT OR IGNORE INTO chat_events(run_id,seq,payload) VALUES(?1,?2,?3)",
            params![run, seq, raw]).map_err(|e| e.to_string())?;
        let (cursor, stored): (i64, String) = tx.query_row(
            "SELECT cursor,payload FROM chat_events WHERE run_id=?1 AND seq=?2", params![run, seq],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|e| e.to_string())?;
        event = serde_json::from_str(&stored).map_err(|e| e.to_string())?;
        if let Some(session) = event["sessionId"].as_str() {
            tx.execute("UPDATE chat_runs SET session_id=?2 WHERE run_id=?1", params![run, session]).map_err(|e| e.to_string())?;
        }
        match event["kind"].as_str() {
            Some("session") => { adopt_run(&tx, &run).map_err(|e| e.to_string())?; }
            Some("done" | "error") => {
                let state = if event["kind"] == "error" { "error" } else if event["data"]["cancelled"] == true { "cancelled" } else { "done" };
                tx.execute("UPDATE chat_runs SET state=?2,error=?3 WHERE run_id=?1 AND state IN ('reserved','spawned')",
                    params![run, state, event["data"].as_str().filter(|_| state == "error")]).map_err(|e| e.to_string())?;
            }
            _ => {}
        }
        event["cursor"] = cursor.into();
        out.push(event.to_string());
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

pub(crate) fn mark_incomplete(db: &Db, events: &[String]) {
    let conn = db.0.lock();
    for raw in events {
        if let Ok(event) = serde_json::from_str::<Value>(raw) {
            let _ = conn.execute("UPDATE chat_runs SET complete=0 WHERE run_id=?1", [event["runId"].as_str()]);
        }
    }
}

/// A completed turn must still be discoverable when no page was present to
/// request a native-file rescan, or the CLI never flushed its transcript.
pub(crate) fn unindexed_sessions(db: &Db) -> Result<Vec<super::SessionMeta>, String> {
    let conn = db.0.lock();
    let mut stmt = conn.prepare("SELECT r.engine,r.session_id,r.workspace_path,r.started_at,e.payload,COALESCE(p.pinned,0),json_extract(title.value,'$'),m.model,eff.effort,provider.provider_id,COALESCE(o.origin,'local')
        FROM chat_runs r JOIN chat_events e ON e.run_id=r.run_id AND e.seq=0
        LEFT JOIN session_pins p ON p.engine=r.engine AND p.session_id=r.session_id
        LEFT JOIN session_metadata_clocks title ON title.engine=r.engine AND title.session_id=r.session_id AND title.field='customTitle'
        LEFT JOIN session_models m ON m.engine=r.engine AND m.session_id=r.session_id
        LEFT JOIN session_efforts eff ON eff.engine=r.engine AND eff.session_id=r.session_id
        LEFT JOIN session_providers provider ON provider.engine=r.engine AND provider.session_id=r.session_id
        LEFT JOIN session_origins o ON o.engine=r.engine AND o.session_id=r.session_id
        WHERE r.session_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.engine=r.engine AND s.session_id=r.session_id)
        AND NOT EXISTS(SELECT 1 FROM session_archives a WHERE a.engine=r.engine AND a.session_id=r.session_id)
        ORDER BY r.started_at").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,bool>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,String>(10)?)))
        .map_err(|e| e.to_string())?;
    let mut sessions: HashMap<(String,String), super::SessionMeta> = HashMap::new();
    for row in rows {
        let (engine,session_id,workspace_path,started_at,raw,pinned,custom_title,model,effort,provider,origin) = row.map_err(|e| e.to_string())?;
        let event: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let text = event["data"]["text"].as_str().unwrap_or("");
        let entry = sessions.entry((engine.clone(),session_id.clone())).or_insert_with(|| super::SessionMeta {
            engine, session_id, workspace_path, file_path: String::new(), file_size:0, file_mtime_ms:started_at,
            title:text.lines().next().unwrap_or("").chars().take(80).collect(), preview:text.chars().take(160).collect(),
            created_at:Some(started_at), updated_at:Some(started_at), message_count:0, pinned, custom_title,
            model, effort, provider, remote:None, remote_path:None, origin,
        });
        entry.updated_at = Some(started_at);
    }
    Ok(sessions.into_values().collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    events: Vec<Value>,
    next_cursor: i64,
    head: i64,
    has_more: bool,
}

pub(crate) fn events_after(db: &Db, engine: &str, session: &str, after: i64, until: Option<i64>) -> Result<EventPage, String> {
    let conn = db.0.lock();
    let head: i64 = conn.query_row("SELECT COALESCE(MAX(cursor),0) FROM chat_events", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let head = until.unwrap_or(head).min(head);
    let incomplete: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_runs WHERE engine=?1 AND session_id=?2 AND complete=0)",
        params![engine, session], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if incomplete { return Err("Chat history could not be saved completely; reload the native transcript".into()); }
    let mut stmt = conn.prepare("SELECT e.cursor,e.payload,r.session_id FROM chat_events e
        JOIN chat_runs r USING(run_id) WHERE r.engine=?1 AND r.session_id=?2
        AND e.cursor>?3 AND e.cursor<=?4 ORDER BY e.cursor LIMIT 257").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![engine, session, after.max(0), head], |r|
        Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))
        .map_err(|e| e.to_string())?;
    let mut events = Vec::new();
    for row in rows {
        let (cursor, raw, session) = row.map_err(|e| e.to_string())?;
        let mut event: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        event["cursor"] = cursor.into();
        // Early output can precede the native session announcement.
        event["sessionId"] = session.into();
        events.push(event);
    }
    let has_more = events.len() > 256;
    if has_more { events.pop(); }
    let next_cursor = if has_more { events.last().and_then(|e| e["cursor"].as_i64()).unwrap_or(after) } else { head };
    Ok(EventPage { events, next_cursor, head, has_more })
}

#[tauri::command]
pub async fn load_session_events(
    state: tauri::State<'_, crate::AppState>, engine: String, session_id: String,
    after_cursor: i64, until_cursor: Option<i64>,
) -> Result<EventPage, String> {
    state.sink.flush();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || events_after(&db, &engine, &session_id, after_cursor, until_cursor))
        .await.map_err(|e| e.to_string())?
}

pub(crate) struct RecordedRun {
    run_id: String,
    started_at: i64,
    native_before: Option<Message>,
    events: Vec<Value>,
}

pub(crate) fn settled_ids(runs: &[RecordedRun]) -> HashSet<String> {
    runs.iter().rev().filter(|run| run.events.iter().any(|e| matches!(e["kind"].as_str(), Some("done" | "error"))))
        .map(|run| run.run_id.clone()).collect()
}

pub(crate) fn snapshot(db: &Db, engine: &str, session: &str) -> Result<(i64, Vec<RecordedRun>), String> {
    let conn = db.0.lock();
    let head = conn.query_row("SELECT COALESCE(MAX(cursor),0) FROM chat_events", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT run_id,started_at,native_before FROM chat_runs
        WHERE engine=?1 AND session_id=?2 AND complete=1 ORDER BY started_at,rowid").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![engine, session], |r| Ok((r.get::<_,String>(0)?, r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?)))
        .map_err(|e| e.to_string())?;
    let mut runs = Vec::new();
    for row in rows {
        let (run_id, started_at, anchor) = row.map_err(|e| e.to_string())?;
        let native_before = anchor.map(|s| serde_json::from_str(&s)).transpose().map_err(|e| e.to_string())?;
        let mut events_stmt = conn.prepare("SELECT payload FROM chat_events WHERE run_id=?1 AND cursor<=?2 ORDER BY seq")
            .map_err(|e| e.to_string())?;
        let events = events_stmt.query_map(params![run_id,head], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?
            .map(|r| r.map_err(|e| e.to_string()).and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string())))
            .collect::<Result<Vec<Value>,String>>()?;
        if !events.is_empty() { runs.push(RecordedRun { run_id, started_at, native_before, events }); }
    }
    Ok((head, runs))
}

/// Merge in native-coordinate order before assigning display sequences. Each
/// run replaces its user turn only; the next native user starts an external
/// or later recorded turn and must remain. An anchor also distinguishes two
/// identical prompts and survives append-only transcript growth.
pub(crate) fn overlay(native: &[Message], runs: Vec<RecordedRun>, active: &HashSet<String>, accepted: &HashSet<String>) -> Vec<Message> {
    overlay_identified(native, runs, active, accepted).into_iter().map(|(_, message)| message).collect()
}

pub(crate) fn overlay_identified(native: &[Message], runs: Vec<RecordedRun>, active: &HashSet<String>, accepted: &HashSet<String>) -> Vec<(String, Message)> {
    if runs.is_empty() { return native.iter().map(|m| (format!("native:{}", m.seq), m.clone())).collect(); }
    let mut replacements = Vec::new();
    for run in runs {
        let prompt = run.events.first().and_then(|e| e["data"]["text"].as_str()).unwrap_or("");
        let anchored = run.native_before.as_ref().and_then(|anchor| native.iter().position(|m|
            m.seq == anchor.seq && m.role == anchor.role && m.text == anchor.text && m.ts == anchor.ts)).map(|i| i+1);
        let start = native.iter().enumerate().skip(anchored.unwrap_or(0)).find(|(_,m)|
            m.role == "user" && (m.text.trim() == prompt.trim() || (!prompt.is_empty() && m.text.trim_end().ends_with(prompt.trim()))) &&
            (anchored.is_some() || m.ts.as_deref().and_then(parse_ts_ms_str).is_some_and(|ts| ts >= run.started_at.saturating_sub(1000))))
            .map(|(i,_)| i).or_else(|| {
                // Grok transcripts can omit all timestamps. A new first turn
                // has no anchor; use its prompt only when the match is unique.
                if run.native_before.is_some() || prompt.trim().is_empty() { return None; }
                let mut matches = native.iter().enumerate().filter(|(_,m)| m.role == "user" && m.ts.is_none() &&
                    m.text.trim_end().ends_with(prompt.trim()));
                let (index, _) = matches.next()?;
                matches.next().is_none().then_some(index)
            });
        let start = start.unwrap_or(native.len());
        let end = native.iter().enumerate().skip(start + 1).find(|(_,m)| m.role == "user").map(|(i,_)| i).unwrap_or(native.len());
        let messages = project(&run, active.contains(&run.run_id), accepted);
        replacements.push((start, end, messages));
    }
    replacements.sort_by_key(|(start,_,_)| *start);
    let mut out = Vec::new();
    let mut consumed = 0;
    for (start, end, messages) in replacements {
        if start > consumed { out.extend(native[consumed..start].iter().map(|m| (format!("native:{}", m.seq), m.clone()))); }
        out.extend(messages);
        consumed = consumed.max(end);
    }
    out.extend(native[consumed..].iter().map(|m| (format!("native:{}", m.seq), m.clone())));
    for (i,(_,m)) in out.iter_mut().enumerate() { m.seq = i as i64 + 1; }
    out
}

fn project(run: &RecordedRun, active: bool, accepted: &HashSet<String>) -> Vec<(String, Message)> {
    let mut out: Vec<Message> = Vec::new();
    let mut ids = Vec::new();
    let mut tools: HashMap<String, usize> = HashMap::new();
    let mut model = None;
    let mut effort = None;
    for event in &run.events {
        let previous_len = out.len();
        let data = &event["data"];
        let kind = event["kind"].as_str().unwrap_or("");
        let mut row = Message { run_id: Some(run.run_id.clone()),
            ts: event["ts"].as_i64().map(|ts| ts.to_string()), model: model.clone(), effort: effort.clone(), ..Default::default() };
        match kind {
            "model" => { model = data.as_str().map(str::to_owned); }
            "effort" => { effort = data.as_str().map(str::to_owned); }
            "delta" | "thinking" => {
                let role = if kind == "delta" { "assistant" } else { "thinking" };
                let text = data.as_str().unwrap_or("");
                if let Some(existing) = out.iter_mut().rev().take_while(|m| m.live == Some(true)).find(|m| m.role == role) {
                    existing.text.push_str(text);
                } else if !text.is_empty() {
                    row.role = role.into(); row.text = text.into(); row.live = Some(true); out.push(row);
                }
            }
            "message" => {
                for m in &mut out { m.live = None; }
                row.role = data["role"].as_str().unwrap_or("assistant").into();
                row.text = data["text"].as_str().unwrap_or("").into();
                row.path = data["path"].as_str().map(str::to_owned);
                row.args = data.get("args").cloned(); row.result = data.get("result").cloned();
                row.todos = data.get("todos").and_then(|v| serde_json::from_value(v.clone()).ok());
                row.images = data.get("images").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                row.tool_call_id = data["toolCallId"].as_str().map(str::to_owned);
                if data["patch"] == true || row.role == "tool_result" {
                    let target = row.tool_call_id.as_ref().and_then(|id| tools.get(id).copied()).or_else(||
                        out.iter().rposition(|m| m.role == "tool" && m.text == row.text));
                    if let Some(i) = target {
                        let old = &mut out[i];
                        if row.args.is_some() { old.args = row.args; }
                        if row.result.is_some() { old.result = row.result; }
                        if row.path.is_some() { old.path = row.path; }
                        if row.todos.is_some() { old.todos = row.todos; }
                        continue;
                    }
                }
                if let Some(id) = &row.tool_call_id { tools.insert(id.clone(), out.len()); }
                out.push(row);
            }
            "usage" | "done" => {
                let usage = if kind == "done" { data.get("usage") } else { Some(data) };
                if let Some(m) = out.iter_mut().rev().find(|m| m.role == "assistant") {
                    if let Some(usage) = usage.filter(|u| !u.is_null()) { m.usage = Some(usage.clone()); }
                    if kind == "done" { m.duration_ms = event["ts"].as_i64().map(|t| (t-run.started_at).max(0)); }
                }
                if kind == "done" { for m in &mut out { m.live = None; } }
            }
            "question" => {
                if let (Some(request), Some(questions)) = (data["requestId"].as_str(), data["input"]["questions"].as_array()) {
                    for m in &mut out { m.live = None; }
                    row.role = "question".into();
                    row.text = questions.first().and_then(|q| q["question"].as_str()).unwrap_or("").into();
                    row.question = Some(serde_json::json!({"requestId":request,"runId":run.run_id,
                        "toolUseId":data["toolUseId"],"questions":questions,"status":"pending"}));
                    out.push(row);
                }
            }
            "question_settled" => {
                for m in &mut out {
                    if let Some(question) = &mut m.question {
                        if question["requestId"] == data["requestId"] { question["status"] = "cancelled".into(); }
                    }
                }
            }
            "warn" | "error" => {
                if kind == "error" { for m in &mut out { m.live = None; } }
                row.role = "system".into(); row.text = data.as_str().unwrap_or("").into(); out.push(row);
            }
            _ => {}
        }
        if out.len() > previous_len { ids.push(format!("run:{}:{}", run.run_id, event["seq"].as_i64().unwrap_or(0))); }
    }
    for row in &mut out {
        if !active { row.live = None; }
        if !active {
            if let Some(question) = &mut row.question { question["status"] = "cancelled".into(); }
        }
        if row.role == "assistant" { row.text = super::extract::strip_recorded_internal_frames(std::mem::take(&mut row.text), accepted); }
    }
    ids.into_iter().zip(out).filter(|(_,m)| m.role != "assistant" || !m.text.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TestDir(std::path::PathBuf);
    impl TestDir { fn path(&self) -> &std::path::Path { &self.0 } }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    fn database() -> (TestDir, Db) {
        let dir = TestDir(std::env::temp_dir().join(format!("ccgui-journal-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(dir.path()).unwrap();
        let db = Db::open_at(&dir.path().join("chat.db")).unwrap();
        (dir, db)
    }

    fn event(run: &str, seq: i64, kind: &str, data: Value) -> String {
        json!({"runId":run,"engine":"codex","sessionId":"s","seq":seq,
            "kind":kind,"data":data,"ts":2000+seq,"startedAt":2000}).to_string()
    }

    fn native(seq: i64, role: &str, text: &str, ts: i64) -> Message {
        Message { seq, role: role.into(), text: text.into(), ts: Some(ts.to_string()), ..Default::default() }
    }

    #[test]
    fn run_status_and_origin_survive_reopen_without_replaying_an_id() {
        let (dir, db) = database();
        begin_with_origin(&db,"remote","codex",None,"/ws",2000,None,"hub").unwrap();
        assert_eq!(statuses(&db,&["remote".into()]).unwrap()[0].state.as_deref(),Some("reserved"));
        launch_result(&db,"remote",None,None).unwrap();
        append(&db,&[event("remote",0,"session",json!("s")),event("remote",1,"done",json!({}))]).unwrap();
        assert_eq!(session_origin(&db,"codex","s").unwrap(),"hub");
        assert_eq!(session_origin(&db,"claude","s").unwrap(),"local");
        launch_result(&db,"remote",Some("s"),None).unwrap();
        drop(db);
        let db = Db::open_at(&dir.path().join("chat.db")).unwrap();
        let rows = statuses(&db,&["remote".into(),"absent".into()]).unwrap();
        assert_eq!(rows[0].state.as_deref(),Some("done"));
        assert_eq!(rows[0].origin.as_deref(),Some("hub"));
        assert_eq!(rows[0].session_id.as_deref(),Some("s"));
        assert!(!rows[1].known);
        assert!(begin_with_origin(&db,"absent","codex",None,"/ws",3000,None,"hub").is_err(), "a late send cannot invalidate the negative receipt");
        assert!(begin_with_origin(&db,"remote","codex",None,"/ws",3000,None,"hub").is_err());
    }

    #[test]
    fn failed_launch_does_not_adopt_a_local_session_and_cancel_stays_terminal() {
        let (_dir, db) = database();
        begin_with_origin(&db,"failed","codex",Some("s"),"/ws",2000,None,"hub").unwrap();
        append(&db,&[event("failed",0,"message",json!({"role":"user","text":"draft"}))]).unwrap();
        launch_result(&db,"failed",None,Some("launch rejected")).unwrap();
        append(&db,&[event("failed",1,"error",json!("launch rejected"))]).unwrap();
        assert_eq!(session_origin(&db,"codex","s").unwrap(),"local");
        let rows = statuses(&db,&["failed".into()]).unwrap();
        assert_eq!(rows[0].state.as_deref(),Some("spawn_failed"));
        assert_eq!(rows[0].error.as_deref(),Some("launch rejected"));
        begin(&db,"stopped","codex",Some("s"),"/ws",3000,None).unwrap();
        launch_result(&db,"stopped",None,None).unwrap();
        append(&db,&[event("stopped",0,"done",json!({"cancelled":true}))]).unwrap();
        append(&db,&[event("stopped",1,"error",json!("late error"))]).unwrap();
        assert_eq!(statuses(&db,&["stopped".into()]).unwrap()[0].state.as_deref(),Some("cancelled"));
    }

    #[test]
    fn origin_changes_are_engine_scoped_and_store_only_hub_rows() {
        let (_dir, db) = database();
        set_origin(&db,"codex","s","hub").unwrap();
        set_origin(&db,"codex","s","hub").unwrap();
        assert_eq!(session_origin(&db,"codex","s").unwrap(),"hub");
        assert_eq!(session_origin(&db,"claude","s").unwrap(),"local");
        assert!(set_origin(&db,"codex","s","other").is_err());
        set_origin(&db,"codex","s","local").unwrap();
        assert_eq!(session_origin(&db,"codex","s").unwrap(),"local");
        assert_eq!(db.0.lock().query_row("SELECT COUNT(*) FROM session_origins", [], |r| r.get::<_,i64>(0)).unwrap(),0);
        assert!(statuses(&db,&vec!["r".into();257]).is_err());
    }

    #[test]
    fn migration_backfills_legacy_terminal_states_and_is_idempotent() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE chat_runs(run_id TEXT PRIMARY KEY,engine TEXT,session_id TEXT,workspace_path TEXT,
            started_at INTEGER,native_before TEXT,complete INTEGER DEFAULT 1);
            CREATE TABLE chat_events(cursor INTEGER PRIMARY KEY,run_id TEXT,seq INTEGER,payload TEXT,UNIQUE(run_id,seq));
            INSERT INTO chat_runs VALUES('legacy','codex','s','/ws',1,NULL,1);
            INSERT INTO chat_events VALUES(1,'legacy',0,'{\"kind\":\"done\"}');").unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let row:(String,String) = conn.query_row("SELECT state,origin FROM chat_runs",[],|r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(row,("done".into(),"local".into()));
    }

    #[test]
    fn every_canonical_terminal_run_is_reported_for_event_cleanup() {
        let runs:Vec<_> = (0..40).map(|index| RecordedRun { run_id:format!("r{index}"),started_at:index,native_before:None,events:vec![json!({"kind":"done"})] }).collect();
        assert_eq!(settled_ids(&runs).len(),40);
    }

    #[test]
    fn executor_restart_settles_receipts_without_inventing_history_completion() {
        let (_dir, db) = database();
        begin_with_origin(&db,"lost","codex",Some("s"),"/ws",2000,None,"hub").unwrap();
        launch_result(&db,"lost",None,None).unwrap();
        append(&db,&[event("lost",0,"message",json!({"role":"user","text":"work"}))]).unwrap();
        recover_runs(&db).unwrap();
        let rows = statuses(&db,&["lost".into()]).unwrap();
        assert_eq!(rows[0].state.as_deref(),Some("error"));
        assert!(rows[0].error.as_deref().unwrap().contains("restarted"));
        let (_, runs) = snapshot(&db,"codex","s").unwrap();
        assert!(settled_ids(&runs).is_empty());
    }

    #[test]
    fn persists_without_subscribers_and_reopens_full_unicode_tool_output() {
        let (dir, db) = database();
        begin(&db,"r","codex",None,"/workspace",2000,None).unwrap();
        let output = "中文🙂\n```rust\nprintln!(\"完整\");\n```\n".repeat(5000);
        let batch = vec![
            event("r",0,"message",json!({"role":"user","text":"test"})),
            event("r",1,"thinking",json!("先检查🧪")),
            event("r",2,"message",json!({"role":"tool","text":"exec","toolCallId":"a","args":{"command":"git status"}})),
            event("r",3,"message",json!({"role":"tool","text":"exec","toolCallId":"b","args":{"command":"git status"}})),
            event("r",4,"message",json!({"role":"tool","text":"exec","toolCallId":"a","patch":true,"result":{"text":output,"exit_code":1}})),
            event("r",5,"message",json!({"role":"tool","text":"exec","toolCallId":"b","patch":true,"result":{"text":"second","exit_code":0}})),
            event("r",6,"delta",json!("完成🙂")),
            event("r",7,"done",json!({"usage":{"output_tokens":9}})),
        ];
        let saved = append(&db,&batch).unwrap();
        assert_eq!(append(&db,&batch).unwrap(), saved, "retries reuse their cursors");
        drop(db);
        let db = Db::open_at(&dir.path().join("chat.db")).unwrap();
        let page = events_after(&db,"codex","s",0,None).unwrap();
        assert_eq!(page.events.len(),8);
        let (_, runs) = snapshot(&db,"codex","s").unwrap();
        let rows = overlay(&[],runs,&HashSet::new(),&HashSet::new());
        assert_eq!(rows.len(),5);
        assert_eq!(rows[2].result.as_ref().unwrap()["text"], output);
        assert_eq!(rows[3].result.as_ref().unwrap()["text"], "second");
        assert_eq!(rows[4].text, "完成🙂");
        assert!(rows.iter().all(|m| m.live != Some(true)));
    }

    #[test]
    fn catchup_pages_use_a_frozen_head_and_do_not_cross_sessions() {
        let (_dir, db) = database();
        begin(&db,"r","codex",Some("s"),"/ws",2000,None).unwrap();
        let batch: Vec<_> = (0..600).map(|seq| event("r",seq,"delta",json!(format!("{seq}🙂")))).collect();
        append(&db,&batch).unwrap();
        let first = events_after(&db,"codex","s",0,None).unwrap();
        assert_eq!(first.events.len(),256);
        assert!(first.has_more);
        append(&db,&[event("r",600,"delta",json!("after snapshot"))]).unwrap();
        let second = events_after(&db,"codex","s",first.next_cursor,Some(first.head)).unwrap();
        let third = events_after(&db,"codex","s",second.next_cursor,Some(first.head)).unwrap();
        assert_eq!(third.events.len(),88);
        assert!(!third.has_more);
        assert_eq!(third.next_cursor,600);
        let tail = events_after(&db,"codex","s",third.next_cursor,None).unwrap();
        assert_eq!(tail.events.len(),1);
        assert!(events_after(&db,"codex","other",0,None).unwrap().events.is_empty());
        assert!(events_after(&db,"claude","s",0,None).unwrap().events.is_empty());
    }

    #[test]
    fn replaces_only_recorded_turn_and_keeps_external_turns_and_repeated_prompts() {
        let (_dir, db) = database();
        let history = vec![native(1,"user","same",100),native(2,"assistant","old",200),
            native(3,"user","same",2000),native(4,"assistant","native partial",2100),
            native(5,"user","external",3000),native(6,"assistant","external reply",3100),
            native(7,"user","same",4000),native(8,"assistant","native partial 2",4100)];
        begin(&db,"r1","codex",Some("s"),"/ws",2000,Some(&history[1])).unwrap();
        begin(&db,"r2","codex",Some("s"),"/ws",4000,Some(&history[5])).unwrap();
        for (run,text) in [("r1","完整一🙂"),("r2","完整二🧪")] {
            append(&db,&[event(run,0,"message",json!({"role":"user","text":"same"})),
                event(run,1,"delta",json!(text)),event(run,2,"done",json!({}))]).unwrap();
        }
        let (_, runs) = snapshot(&db,"codex","s").unwrap();
        let rows = overlay(&history,runs,&HashSet::new(),&HashSet::new());
        assert_eq!(rows.iter().map(|m|m.text.as_str()).collect::<Vec<_>>(),
            ["same","old","same","完整一🙂","external","external reply","same","完整二🧪"]);
    }

    #[test]
    fn untimed_first_turn_stays_before_the_anchored_followup() {
        let (_dir, db) = database();
        let history: Vec<_> = [("user", "first🙂"), ("assistant", "first answer"),
            ("user", "followup"), ("assistant", "second answer")].into_iter().enumerate()
            .map(|(i, (role, text))| Message { seq: i as i64 + 1, role: role.into(), text: text.into(), ..Default::default() }).collect();
        begin(&db,"r1","grok",None,"/ws",2000,None).unwrap();
        begin(&db,"r2","grok",Some("s"),"/ws",3000,Some(&history[1])).unwrap();
        for (run,prompt,answer) in [("r1","first🙂","first answer"),("r2","followup","second answer")] {
            append(&db,&[event(run,0,"message",json!({"role":"user","text":prompt})),
                event(run,1,"delta",json!(answer)),event(run,2,"done",json!({}))]).unwrap();
        }
        let (_, runs) = snapshot(&db,"grok","s").unwrap();
        let rows = overlay(&history,runs,&HashSet::new(),&HashSet::new());
        assert_eq!(rows.iter().map(|m|m.text.as_str()).collect::<Vec<_>>(),
            ["first🙂","first answer","followup","second answer"]);
        assert_eq!(rows[0].run_id.as_deref(),Some("r1"));
        assert_eq!(rows[2].run_id.as_deref(),Some("r2"));
    }

    #[test]
    fn ambiguous_untimed_prompts_do_not_overwrite_existing_turns() {
        let (_dir, db) = database();
        let history: Vec<_> = [("user", "same"), ("assistant", "old answer"),
            ("user", "same"), ("assistant", "external answer")].into_iter().enumerate()
            .map(|(i, (role, text))| Message { seq: i as i64 + 1, role: role.into(), text: text.into(), ..Default::default() }).collect();
        begin(&db,"r","grok",None,"/ws",2000,None).unwrap();
        append(&db,&[event("r",0,"message",json!({"role":"user","text":"same"})),
            event("r",1,"delta",json!("recorded answer")),event("r",2,"done",json!({}))]).unwrap();
        let (_, runs) = snapshot(&db,"grok","s").unwrap();
        let rows = overlay(&history,runs,&HashSet::new(),&HashSet::new());
        assert_eq!(rows.iter().map(|m|m.text.as_str()).collect::<Vec<_>>(),
            ["same","old answer","same","external answer","same","recorded answer"]);
    }

    #[test]
    fn continues_partial_text_and_settles_it_when_host_restarts() {
        let (_dir, db) = database();
        begin(&db,"r","codex",Some("s"),"/ws",2000,None).unwrap();
        append(&db,&[event("r",0,"message",json!({"role":"user","text":"test"})),
            event("r",1,"delta",json!("a🙂")),event("r",2,"thinking",json!("think")),event("r",3,"delta",json!("中b"))]).unwrap();
        let (_,runs) = snapshot(&db,"codex","s").unwrap();
        let live = overlay(&[],runs,&HashSet::from(["r".into()]),&HashSet::new());
        assert_eq!(live[1].text,"a🙂中b");
        assert_eq!(live[1].live,Some(true));
        let (_,runs) = snapshot(&db,"codex","s").unwrap();
        let stopped = overlay(&[],runs,&HashSet::new(),&HashSet::new());
        assert_eq!(stopped[1].text,"a🙂中b");
        assert_eq!(stopped[1].live,None);
    }

    #[test]
    fn transaction_failure_never_broadcasts_a_fictitious_cursor() {
        let (_dir, db) = database();
        begin(&db,"r","codex",Some("s"),"/ws",2000,None).unwrap();
        let batch = [event("r",1,"delta",json!("first")),event("missing",1,"delta",json!("bad"))];
        assert!(append(&db,&batch).is_err());
        assert!(events_after(&db,"codex","s",0,None).unwrap().events.is_empty());
        mark_incomplete(&db,&batch);
        assert!(events_after(&db,"codex","s",0,None).is_err());
    }

    #[test]
    fn discovers_a_finished_unindexed_session_and_drops_deleted_events() {
        let (_dir, db) = database();
        begin(&db,"r","codex",None,"/ws",2000,None).unwrap();
        append(&db,&[event("r",0,"message",json!({"role":"user","text":"网页关闭期间的新会话🙂"})),
            event("r",1,"done",json!({}))]).unwrap();
        let sessions = unindexed_sessions(&db).unwrap();
        assert_eq!(sessions.len(),1);
        assert_eq!(sessions[0].title,"网页关闭期间的新会话🙂");
        db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title)
            VALUES('codex','s','/ws','native.jsonl',1,1,'native')", []).unwrap();
        assert!(unindexed_sessions(&db).unwrap().is_empty());
        db.0.lock().execute("DELETE FROM chat_runs WHERE run_id='r'", []).unwrap();
        assert!(events_after(&db,"codex","s",0,None).unwrap().events.is_empty());
    }

    #[test]
    fn restores_question_content_without_reviving_an_ended_request() {
        let (_dir, db) = database();
        begin(&db,"r","codex",Some("s"),"/ws",2000,None).unwrap();
        append(&db,&[event("r",0,"message",json!({"role":"user","text":"test"})),
            event("r",1,"question",json!({"requestId":"q","input":{"questions":[{"question":"选择🙂","options":[{"label":"A","description":"说明"}]}]}}))]).unwrap();
        let (_,runs) = snapshot(&db,"codex","s").unwrap();
        let rows = overlay(&[],runs,&HashSet::new(),&HashSet::new());
        let question = rows.last().unwrap();
        assert_eq!(question.text,"选择🙂");
        assert_eq!(question.question.as_ref().unwrap()["status"],"cancelled");
    }
}
