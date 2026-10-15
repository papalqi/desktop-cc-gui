use super::SessionMeta;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldWrite {
    pub engine: String,
    pub session_id: String,
    pub field: String,
    pub value: Value,
    pub modified_at: i64,
    pub session: Option<SessionMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldState {
    pub applied: bool,
    pub value: Value,
    pub modified_at: i64,
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn read(conn: &Connection, engine: &str, id: &str, field: &str) -> Result<(Value, i64), String> {
    let preference = match field {
        "model" => Some(("session_models", "model")),
        "effort" => Some(("session_efforts", "effort")),
        "provider" => Some(("session_providers", "provider_id")),
        _ => None,
    };
    if let Some((table, column)) = preference {
        return conn.query_row(&format!("SELECT {column},updated_at FROM {table} WHERE engine=?1 AND session_id=?2"), params![engine, id], |row| Ok((json!(row.get::<_, String>(0)?), row.get(1)?)))
            .optional().map(|value| value.unwrap_or((Value::Null, 0))).map_err(|e| e.to_string());
    }
    let value = match field {
        "pinned" => json!(conn.query_row("SELECT COALESCE((SELECT pinned FROM session_pins WHERE engine=?1 AND session_id=?2),(SELECT pinned FROM sessions WHERE engine=?1 AND session_id=?2),0)", params![engine,id], |row| row.get::<_, bool>(0)).map_err(|e| e.to_string())?),
        "customTitle" => {
            let title = conn.query_row("SELECT value FROM session_metadata_clocks WHERE engine=?1 AND session_id=?2 AND field='customTitle'",params![engine,id], |row| row.get::<_,String>(0)).optional().map_err(|e| e.to_string())?;
            if let Some(title) = title { serde_json::from_str(&title).map_err(|e| e.to_string())? }
            else { conn.query_row("SELECT custom_title FROM sessions WHERE engine=?1 AND session_id=?2", params![engine,id], |row| row.get::<_, Option<String>>(0)).optional().map_err(|e| e.to_string())?.flatten().map(Value::String).unwrap_or(Value::Null) }
        }
        "archived" => json!(conn.query_row("SELECT EXISTS(SELECT 1 FROM session_archives WHERE engine=?1 AND session_id=?2)", params![engine,id], |row| row.get::<_, bool>(0)).map_err(|e| e.to_string())?),
        _ => return Err("invalid session metadata field".into()),
    };
    let at = conn.query_row("SELECT updated_at FROM session_metadata_clocks WHERE engine=?1 AND session_id=?2 AND field=?3", params![engine,id,field], |row| row.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
    Ok((value, at))
}

/// `None` uses a local monotonic timestamp; remote retries keep the original timestamp.
pub fn write(db: &crate::db::Db, engine: &str, id: &str, field: &str, mut value: Value, at: Option<i64>, session: Option<&SessionMeta>) -> Result<FieldState, String> {
    if engine.trim().is_empty() || engine.len() > 64 || id.trim().is_empty() || id.len() > 256 { return Err("invalid session identity".into()); }
    match field {
        "pinned" | "archived" if value.is_boolean() => (),
        "customTitle" if value.is_null() || value.is_string() => {
            value = value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(|s| json!(s)).unwrap_or(Value::Null);
        }
        "model" | "effort" | "provider" if value.as_str().is_some_and(|s| !s.trim().is_empty()) => {
            if field == "provider" && (value.as_str().unwrap().len() > 128 || !value.as_str().unwrap().bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'-'|b'_'|b'.'))) { return Err("invalid provider id".into()); }
        }
        _ => return Err("invalid session metadata value".into()),
    }
    if at.is_some_and(|at| at <= 0 || at > 9_007_199_254_740_991) { return Err("invalid metadata timestamp".into()); }
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (current, previous_at) = read(&tx, engine, id, field)?;
    let at = at.unwrap_or_else(|| now().max(previous_at + 1));
    if at <= previous_at { return Ok(FieldState { applied: false, value: current, modified_at: previous_at }); }
    match field {
        "pinned" => {
            tx.execute("INSERT INTO session_pins(engine,session_id,pinned) VALUES(?1,?2,?3) ON CONFLICT(engine,session_id) DO UPDATE SET pinned=excluded.pinned", params![engine,id,value.as_bool().unwrap()]).map_err(|e| e.to_string())?;
            tx.execute("UPDATE sessions SET pinned=?3 WHERE engine=?1 AND session_id=?2", params![engine,id,value.as_bool().unwrap()]).map_err(|e| e.to_string())?;
        }
        "customTitle" => {
            tx.execute("UPDATE sessions SET custom_title=?3 WHERE engine=?1 AND session_id=?2", params![engine,id,value.as_str()]).map_err(|e| e.to_string())?;
        }
        "archived" => {
            if value.as_bool().unwrap() {
                let session = session.ok_or("archive snapshot is required")?;
                if session.engine != engine || session.session_id != id || session.workspace_path.trim().is_empty() { return Err("invalid archive snapshot identity".into()); }
                let snapshot = serde_json::to_string(session).map_err(|e| e.to_string())?;
                tx.execute("INSERT INTO session_archives(engine,session_id,workspace_path,snapshot_json,archived_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(engine,session_id) DO UPDATE SET workspace_path=excluded.workspace_path,snapshot_json=excluded.snapshot_json,archived_at=excluded.archived_at", params![engine,id,session.workspace_path,snapshot,at]).map_err(|e| e.to_string())?;
            } else {
                tx.execute("DELETE FROM session_archives WHERE engine=?1 AND session_id=?2", params![engine,id]).map_err(|e| e.to_string())?;
            }
        }
        _ => {
            let (table, column) = match field { "model" => ("session_models","model"), "effort" => ("session_efforts","effort"), _ => ("session_providers","provider_id") };
            tx.execute(&format!("INSERT INTO {table}(engine,session_id,{column},updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(engine,session_id) DO UPDATE SET {column}=excluded.{column},updated_at=excluded.updated_at"), params![engine,id,value.as_str(),at]).map_err(|e| e.to_string())?;
        }
    }
    if matches!(field, "pinned" | "customTitle" | "archived") {
        tx.execute("INSERT INTO session_metadata_clocks(engine,session_id,field,updated_at,value) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(engine,session_id,field) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value", params![engine,id,field,at,value.to_string()]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(FieldState { applied: true, value, modified_at: at })
}

pub fn apply(state: &crate::AppState, args: FieldWrite) -> Result<FieldState, String> {
    let result = write(&state.db, &args.engine, &args.session_id, &args.field, args.value, Some(args.modified_at), args.session.as_ref())?;
    if result.applied { state.sink.emit_sessions_changed(); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_writes_are_idempotent_and_cannot_overwrite_newer_desktop_preferences() {
        let dir = std::env::temp_dir().join(format!("ccgui-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open_at(&dir.join("app.db")).unwrap();
        db.remember_session_model("codex", "s", "desktop", 200).unwrap();
        let old = write(&db,"codex","s","model",json!("queued"),Some(100),None).unwrap();
        assert!(!old.applied);
        assert_eq!(old.value, json!("desktop"));
        assert_eq!(old.modified_at, 200);
        let fresh = write(&db,"codex","s","model",json!("web"),Some(300),None).unwrap();
        assert!(fresh.applied);
        db.remember_session_model("codex", "s", "stale-send", 250).unwrap();
        assert_eq!(write(&db,"codex","s","model",json!("old"),Some(250),None).unwrap().value, json!("web"));
        assert!(!write(&db,"codex","s","model",json!("web"),Some(300),None).unwrap().applied);
        assert!(write(&db,"codex","s","pinned",json!(true),Some(100),None).unwrap().applied);
        let local = write(&db,"codex","s","pinned",json!(false),None,None).unwrap();
        assert!(local.modified_at > 100);
        assert_eq!(write(&db,"codex","s","pinned",json!(true),Some(100),None).unwrap().value, json!(false));
        assert!(write(&db,"codex","s","provider",json!("bad/provider"),Some(300),None).is_err());
        assert!(write(&db,"codex","s","archived",json!(true),Some(300),None).is_err());
        assert!(write(&db,"codex","unindexed","customTitle",json!("  新标题🙂  "),Some(100),None).unwrap().applied);
        assert_eq!(write(&db,"codex","unindexed","customTitle",json!("old"),Some(50),None).unwrap().value, json!("新标题🙂"));
        let session: SessionMeta = serde_json::from_value(json!({ "engine":"codex","sessionId":"s","workspacePath":"/ws","filePath":"/s.jsonl","fileSize":0,"fileMtimeMs":0,"title":"s","preview":"","createdAt":null,"updatedAt":null,"messageCount":0,"pinned":false,"customTitle":null })).unwrap();
        assert!(write(&db,"codex","s","archived",json!(true),Some(100),Some(&session)).unwrap().applied);
        let restored = write(&db,"codex","s","archived",json!(false),None,None).unwrap();
        assert!(restored.applied);
        assert_eq!(write(&db,"codex","s","archived",json!(true),Some(100),Some(&session)).unwrap().value,json!(false));
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
