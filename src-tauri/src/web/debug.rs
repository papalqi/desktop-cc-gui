use super::{gate, now_ms, token_required, Gate, TokenQuery, WebCtx};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use tauri::Manager;

fn component<T: Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(payload) => json!({ "ok": true, "payload": payload }),
        Err(_) => json!({ "ok": false, "error": { "code": "unavailable" } }),
    }
}

pub(super) fn snapshot(app: &tauri::AppHandle) -> Value {
    let state = app.state::<crate::AppState>();
    let port = state.web.inner.lock().as_ref().map(|running| running.info.port);
    let relay = crate::relay::web_relay_status(app.clone());
    json!({
        "schemaVersion": 1, "generatedAt": now_ms(), "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "pid": std::process::id(),
        "web": { "listening": port.is_some(), "port": port,
            "remoteSockets": super::REMOTE_SESSIONS.load(std::sync::atomic::Ordering::SeqCst) },
        "relay": { "running": relay.is_some(), "connected": relay.as_ref().is_some_and(|info| info.connected),
            "hasError": relay.as_ref().is_some_and(|info| info.error.is_some()) },
        "activeRuns": state.processes.active_runs(),
        "eventQueues": { "chat": component(state.sink.diagnostics()), "terminal": component(state.terminal_sink.diagnostics()),
            "plugin": component(state.plugin_sink.diagnostics()), "mission": component(state.mission_sink.diagnostics()) },
        "metrics": component(crate::metrics::app_metrics(app.state())),
        "performanceDiagnosticsEnabled": component(crate::metrics::performance_diagnostics_enabled(app.state())),
        "logs": crate::diagnostics::status(),
    })
}

fn json_response(data: Value, status: StatusCode) -> Response {
    let body = if status.is_success() { json!({ "data": data }) } else { json!({ "error": data }) };
    let mut body = body;
    body["schemaVersion"] = json!(1);
    body["generatedAt"] = json!(now_ms());
    body["ok"] = json!(status.is_success());
    (status, [(header::CACHE_CONTROL, "no-store")], axum::Json(body)).into_response()
}

fn token_allowed(headers: &HeaderMap, peer: SocketAddr, query: &TokenQuery, expected: &str) -> bool {
    if !token_required(headers, peer) { return true; }
    let bearer = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    bearer.or(query.token.as_deref()).is_some_and(|token| token == expected)
}

pub(super) async fn handler(
    State(ctx): State<WebCtx>, ConnectInfo(peer): ConnectInfo<SocketAddr>, Query(query): Query<TokenQuery>,
    uri: Uri, headers: HeaderMap,
) -> Response {
    if let Gate::Waiting(page) = gate(&ctx, &headers, peer) {
        let mut response = json_response(json!({ "code": "pairing_required" }), StatusCode::UNAUTHORIZED);
        if let Some(cookie) = page.headers().get(header::SET_COOKIE) {
            response.headers_mut().insert(header::SET_COOKIE, cookie.clone());
        }
        return response;
    }
    if !token_allowed(&headers, peer, &query, &ctx.token) {
        return json_response(json!({ "code": "forbidden" }), StatusCode::FORBIDDEN);
    }
    let payload = match uri.path() {
        "/api/debug/logs" | "/api/debug/logs/export" => {
            let exporting = uri.path().ends_with("/export");
            let query = match Query::<crate::diagnostics::LogQuery>::try_from_uri(&uri) {
                Ok(Query(mut query)) => {
                    if exporting && query.limit.is_none() { query.limit = Some(1000); }
                    if query.validate(if exporting { 1000 } else { 100 }).is_err() {
                        return json_response(json!({ "code": "invalid_arguments" }), StatusCode::BAD_REQUEST);
                    }
                    query
                }
                Err(_) => return json_response(json!({ "code": "invalid_arguments" }), StatusCode::BAD_REQUEST),
            };
            let page = match crate::diagnostics::query(&query) {
                Ok(page) => page,
                Err(_) => return json_response(json!({ "code": "unavailable" }), StatusCode::SERVICE_UNAVAILABLE),
            };
            if exporting { return log_export(&page); }
            page
        }
        "/api/debug/snapshot" => snapshot(&ctx.app),
        "/api/debug/performance" => match crate::metrics::performance_diagnostics(ctx.app.state()) {
            Ok(report) => json!(report),
            Err(_) => return json_response(json!({ "code": "unavailable" }), StatusCode::SERVICE_UNAVAILABLE),
        },
        _ => json!({ "authentication": "Existing bridge token (Bearer header or token query); relayed requests require device approval",
            "endpoints": [ { "method": "GET", "path": "/api/debug/snapshot" }, { "method": "GET", "path": "/api/debug/performance" },
                { "method": "GET", "path": "/api/debug/logs" }, { "method": "GET", "path": "/api/debug/logs/export" } ],
            "rpcCommand": "debug_snapshot", "rpcCommands": ["debug_snapshot", "debug_logs"], "logs": crate::diagnostics::status() }),
    };
    json_response(payload, StatusCode::OK)
}

fn log_export(page: &Value) -> Response {
    let body: String = page["entries"].as_array().into_iter().flatten().map(|entry| format!("{entry}\n")).collect();
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert(header::CONTENT_DISPOSITION, "attachment; filename=\"ccgui-logs.ndjson\"".parse().unwrap());
    for (header, field) in [("x-next-cursor", "nextId"), ("x-log-head", "head"), ("x-has-more", "hasMore"), ("x-log-truncated", "truncated")] {
        if let Ok(value) = page[field].to_string().parse() { headers.insert(header, value); }
    }
    if let Some(epoch) = page["epoch"].as_str() { if let Ok(value) = epoch.parse() { headers.insert("x-log-epoch", value); } }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_require_the_existing_token_even_with_a_forged_relay_header() {
        let lan: SocketAddr = "192.168.1.10:1234".parse().unwrap();
        let local: SocketAddr = "127.0.0.1:1234".parse().unwrap();
        let query = TokenQuery { token: None };
        let mut headers = HeaderMap::new();
        assert!(!token_allowed(&headers, local, &query, "secret"));
        headers.insert(crate::relay::VIA_HEADER, "relay".parse().unwrap());
        assert!(!token_allowed(&headers, lan, &query, "secret"));
        assert!(token_allowed(&headers, local, &query, "secret")); // Gate still requires approval.
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert!(token_allowed(&headers, lan, &query, "secret"));
        headers.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert!(!token_allowed(&headers, lan, &TokenQuery { token: Some("secret".into()) }, "secret"));
    }

    #[tokio::test]
    async fn error_envelopes_are_json_uncached_and_do_not_return_internal_errors() {
        let response = json_response(component::<Value>(Err("token=private; prompt=private".into())), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["schemaVersion"], 1);
        assert!(!String::from_utf8(bytes.to_vec()).unwrap().contains("private"));
    }

    #[tokio::test]
    async fn log_exports_keep_page_metadata_and_unicode_as_ndjson() {
        let page = json!({ "entries": [{ "id": 3, "message": "中文😀\nsecond line" }], "epoch": "test-epoch", "nextId": 3, "head": 8, "hasMore": true, "truncated": false });
        let response = log_export(&page);
        assert_eq!(response.headers()["x-next-cursor"], "3");
        assert_eq!(response.headers()["x-log-head"], "8");
        assert_eq!(response.headers()["x-has-more"], "true");
        assert_eq!(response.headers()["x-log-epoch"], "test-epoch");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert_eq!(serde_json::from_str::<Value>(text.trim()).unwrap()["message"], "中文😀\nsecond line");
        let Query(query) = Query::<crate::diagnostics::LogQuery>::try_from_uri(&"/api/debug/logs?since=10&until=20&sessionId=s&limit=100&token=secret".parse().unwrap()).unwrap();
        query.validate(100).unwrap();
        assert_eq!(query.since, Some(10));
        assert_eq!(query.session_id.as_deref(), Some("s"));
        assert!(Query::<crate::diagnostics::LogQuery>::try_from_uri(&"/api/debug/logs?since=abc".parse().unwrap()).is_err());
    }
}
