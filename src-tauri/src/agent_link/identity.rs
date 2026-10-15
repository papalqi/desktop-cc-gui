use crate::db::Db;
use reqwest::Url;
use rusqlite::OptionalExtension;

pub struct Target {
    pub hub: String,
    pub name: String,
    pub bootstrap_key: String,
}
impl Target {
    /// Machine routes belong to the Hub; a generic Cloudflare Worker keeps v0.
    pub fn from_legacy(agent: &str) -> Option<Self> {
        let mut url = Url::parse(agent).ok()?;
        let (prefix, route) = url.path().rsplit_once("/m/")?;
        let name = route.strip_suffix("/agent")?;
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return None;
        }
        let name = name.to_owned();
        let prefix = prefix.to_owned();
        let bootstrap_key = url
            .query_pairs()
            .find(|(key, _)| key == "key")?
            .1
            .into_owned();
        let scheme = match url.scheme() {
            "wss" => "https",
            "ws" => "http",
            _ => return None,
        };
        url.set_scheme(scheme).ok()?;
        url.set_path(&prefix);
        url.set_query(None);
        url.set_fragment(None);
        Some(Self {
            hub: url.as_str().trim_end_matches('/').to_owned(),
            name,
            bootstrap_key,
        })
    }
    pub fn socket_url(&self, bulk: bool) -> String {
        format!(
            "{}/agent/v1{}",
            self.hub.replacen("http", "ws", 1),
            if bulk { "/bulk" } else { "" }
        )
    }
}
pub struct Credential {
    pub machine_id: String,
    pub token: Option<String>,
}
pub fn load(db: &Db, hub: &str) -> Result<Credential, String> {
    let conn = db.0.lock();
    conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),machine_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_credentials(hub TEXT PRIMARY KEY,token TEXT NOT NULL);").map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO agent_identity VALUES(1,?1)",
        [uuid::Uuid::new_v4().to_string()],
    )
    .map_err(|e| e.to_string())?;
    let machine_id = conn
        .query_row(
            "SELECT machine_id FROM agent_identity WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let token = conn
        .query_row(
            "SELECT token FROM agent_credentials WHERE hub=?1",
            [hub],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(Credential { machine_id, token })
}
pub fn save_token(db: &Db, hub: &str, token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 256 {
        return Err("invalid machine token".into());
    }
    crate::diagnostics::register_secret(token);
    db.0.lock().execute("INSERT INTO agent_credentials VALUES(?1,?2) ON CONFLICT(hub) DO UPDATE SET token=excluded.token",[hub,token]).map(|_| ()).map_err(|e| e.to_string())
}

pub fn clear_token(db: &Db, hub: &str) -> Result<(), String> {
    db.0.lock()
        .execute("DELETE FROM agent_credentials WHERE hub=?1", [hub])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub async fn supports_v1(target: &Target) -> Result<bool, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("{}/_relay/agent-protocol", target.hub))
        .send()
        .await
        .map_err(|_| "Hub protocol discovery failed")?;
    if matches!(response.status().as_u16(), 404 | 501) {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err("Hub protocol discovery was refused".into());
    }
    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Hub protocol discovery failed")?
    {
        if bytes.len() + chunk.len() > 8192 {
            return Err("invalid Hub protocol discovery".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        let protocols = value["protocols"]
            .as_array()
            .ok_or("invalid Hub protocol discovery")?;
        if protocols.contains(&serde_json::json!(1)) {
            return Ok(true);
        }
        if protocols.contains(&serde_json::json!(0)) {
            return Ok(false);
        }
    }
    // Pre-v1 CCGUI Hubs send their login form for unknown unauthenticated paths.
    let text = String::from_utf8_lossy(&bytes);
    if text.contains("<title>中转登录</title>")
        && text.contains("/_relay/login\"")
        && text.contains("type=\"password\"")
    {
        return Ok(false);
    }
    Err("invalid Hub protocol discovery".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hub_routes_preserve_the_public_namespace_and_do_not_leak_bootstrap_into_endpoints() {
        let target =
            Target::from_legacy("wss://example.test/CCGUI/m/PC6/agent?key=secret%2Bkey").unwrap();
        assert_eq!(target.hub, "https://example.test/CCGUI");
        assert_eq!(target.name, "PC6");
        assert_eq!(target.bootstrap_key, "secret+key");
        assert_eq!(
            target.socket_url(true),
            "wss://example.test/CCGUI/agent/v1/bulk"
        );
        assert!(Target::from_legacy("wss://worker.test/agent?key=key").is_none());
    }
    #[test]
    fn identity_survives_reopen_and_credentials_are_per_hub() {
        let path =
            std::env::temp_dir().join(format!("ccgui-agent-identity-{}.db", uuid::Uuid::new_v4()));
        let db = Db::open_at(&path).unwrap();
        let first = load(&db, "https://hub.test").unwrap();
        assert!(uuid::Uuid::parse_str(&first.machine_id).is_ok());
        save_token(&db, "https://hub.test", "test-machine-token").unwrap();
        drop(db);
        let db = Db::open_at(&path).unwrap();
        let next = load(&db, "https://hub.test").unwrap();
        assert_eq!(first.machine_id, next.machine_id);
        assert_eq!(next.token.as_deref(), Some("test-machine-token"));
        assert!(load(&db, "https://other.test").unwrap().token.is_none());
        drop(db);
        std::fs::remove_file(&path).unwrap();
    }
}
