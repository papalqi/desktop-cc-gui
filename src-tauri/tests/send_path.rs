//! End-to-end send-path test: fake `claude` CLI on PATH emitting stream-json
//! NDJSON, real send_message command, real EventSink, events captured via
//! listen_global. Verifies the whole chain the UI depends on.

use ccgui_next_lib::config::ConfigStore;
use ccgui_next_lib::db::Db;
use ccgui_next_lib::engine::{self, ProcessRegistry};
use ccgui_next_lib::event_sink::{EventSink, ENGINE_EVENT_NAME};
use ccgui_next_lib::AppState;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};
/// Tests mutate process-global HOME/PATH; serialize them. Holding the std
/// guard across awaits is intentional here (test serialization, no deadlock:
/// each test awaits only its own child processes).
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct TestEnvironment {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    #[cfg(windows)]
    portable: std::path::PathBuf,
}

impl TestEnvironment {
    fn new(home: &std::path::Path, bin: &std::path::Path) -> Self {
        let keys = ["HOME", "PATH", "APPDATA", "USERPROFILE", "LOCALAPPDATA"];
        let saved = keys.into_iter().map(|key| (key, std::env::var_os(key))).collect();
        std::env::set_var("HOME", home);
        std::env::set_var("APPDATA", home.join("appdata"));
        std::env::set_var("USERPROFILE", home.join("profile"));
        std::env::set_var("LOCALAPPDATA", home.join("localappdata"));
        let mut paths = vec![bin.to_path_buf()];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
        std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
        ccgui_next_lib::engine::resolve::clear_search_paths_cache();
        #[cfg(windows)]
        {
            // Integration targets use the production path resolver. Portable
            // mode keeps settings writes away from the actual user's profile.
            use std::io::Write;
            let directory = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
            let portable = directory.join("portable-data.json");
            let app_home = directory.join(format!("send-path-data-{}", std::process::id()));
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&portable).unwrap();
            file.write_all(serde_json::json!({"appHome": app_home}).to_string().as_bytes()).unwrap();
            assert_eq!(ccgui_next_lib::paths::app_home(), app_home);
            ccgui_next_lib::paths::ensure_dirs().unwrap();
            Self { saved, portable }
        }
        #[cfg(not(windows))]
        {
            ccgui_next_lib::paths::ensure_dirs().unwrap();
            Self { saved }
        }
    }
}

impl Drop for TestEnvironment {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        #[cfg(windows)]
        std::fs::remove_file(&self.portable).unwrap();
        ccgui_next_lib::engine::resolve::clear_search_paths_cache();
    }
}

#[cfg(windows)]
fn write_windows_cli(dir: &std::path::Path, name: &str, script: &str) {
    std::fs::write(dir.join(format!("{name}.cmd")), format!("@echo off\r\nnode \"%~dp0{name}.cjs\" %*\r\n")).unwrap();
    std::fs::write(dir.join(format!("{name}.cjs")), script).unwrap();
}

fn temp_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ccgui-send-test-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_fake_claude(dir: &std::path::Path) {
    #[cfg(windows)]
    {
        write_windows_cli(dir, "claude", r#"
process.stdin.once('data', () => {
  for (const event of [
    {type:'system',subtype:'init',session_id:'fake-session-123'},
    {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Hello '}}},
    {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'from fake'}}},
    {type:'result',subtype:'success',session_id:'fake-session-123',usage:{input_tokens:10,output_tokens:5}}
  ]) console.log(JSON.stringify(event));
  process.stdin.destroy();
});
"#);
    }
    let script = r#"#!/bin/sh
read -r line
echo '{"type":"system","subtype":"init","session_id":"fake-session-123"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"from fake"}}}'
echo '{"type":"result","subtype":"success","session_id":"fake-session-123","usage":{"input_tokens":10,"output_tokens":5}}'
"#;
    let path = dir.join("claude");
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn build_app(
    home: &std::path::Path,
) -> (tauri::App<tauri::test::MockRuntime>, Arc<Mutex<Vec<Value>>>) {
    std::env::set_var("HOME", home);
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let db = Arc::new(Db::open_at(&home.join("app.db")).unwrap());
    let state = AppState {
        db: db.clone(),
        sink: EventSink::with_journal(Arc::new(app.handle().clone()), db),
        terminal_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        plugin_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME,
        ),
        mission_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME,
        ),
        terminals: ccgui_next_lib::terminal::TerminalRegistry::default(),
        processes: Arc::new(ProcessRegistry::default()),
        emitters: ccgui_next_lib::event_sink::BroadcastEmit::new(Arc::new(app.handle().clone())),
        web: ccgui_next_lib::web::WebAccessState::default(),
        relay: ccgui_next_lib::relay::RelayState::default(),
        dsh_host: Arc::new(ccgui_next_lib::dsh_host::DshHostState::default()),
        opencode_server: std::sync::Arc::new(
            ccgui_next_lib::engine::opencode_server::OpencodeServerState::default(),
        ),
        worktree_creations: ccgui_next_lib::git_worktree::CreationRegistry::default(),
    };
    app.manage(state);
    app.manage(ConfigStore::default());

    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    let handle = app.handle().clone();
    handle.listen_any(ENGINE_EVENT_NAME, move |event: tauri::Event| {
        if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
            captured.lock().unwrap().extend(batch);
        }
    });
    (app, events)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn send_message_streams_events_end_to_end() {
    let _env_guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("stream");
    let bin_dir = home.join("appdata").join("npm");
    std::fs::create_dir_all(&bin_dir).unwrap();
    write_fake_claude(&bin_dir);
    let _environment = TestEnvironment::new(&home, &bin_dir);

    let workspace = home.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();

    let (app, events) = build_app(&home);
    let state = app.state::<AppState>();

    let result = engine::send_message(
        state,
        "claude".to_string(),
        workspace.to_string_lossy().to_string(),
        None,
        "hi".to_string(),
        Vec::new(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some("hub".into()),
    )
    .await
    .expect("send_message must succeed");
    assert!(!result.run_id.is_empty());

    // Wait for the done event (events are batched at 32ms).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let kinds: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e.get("kind").and_then(Value::as_str).map(str::to_string))
            .collect();
        if kinds.iter().any(|k| k == "done") && app.state::<AppState>().processes.0.lock().unwrap().is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no done event within 5s: {kinds:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let collected = events.lock().unwrap();
    let kinds: Vec<&str> = collected
        .iter()
        .filter_map(|e| e.get("kind").and_then(Value::as_str))
        .collect();
    assert!(
        kinds.contains(&"session"),
        "session event missing: {kinds:?}"
    );
    assert!(kinds.contains(&"delta"), "delta events missing: {kinds:?}");

    let session_event = collected
        .iter()
        .find(|e| e.get("kind").and_then(Value::as_str) == Some("session"))
        .unwrap();
    assert_eq!(
        session_event.get("data").and_then(Value::as_str),
        Some("fake-session-123")
    );
    let delta_text: String = collected
        .iter()
        .filter(|e| e.get("kind").and_then(Value::as_str) == Some("delta"))
        .filter_map(|e| e.get("data").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert_eq!(delta_text, "Hello from fake");

    let done = collected
        .iter()
        .find(|e| e.get("kind").and_then(Value::as_str) == Some("done"))
        .unwrap();
    assert_eq!(
        done.get("sessionId").and_then(Value::as_str),
        Some("fake-session-123")
    );

    // Process registry drained after exit.
    assert!(app
        .state::<AppState>()
        .processes
        .0
        .lock()
        .unwrap()
        .is_empty());
    drop(collected);
    let statuses = ccgui_next_lib::history::journal::run_status(app.state(), vec![result.run_id, "unknown-run".into()]).unwrap();
    let statuses = serde_json::to_value(statuses).unwrap();
    assert_eq!(statuses[0]["state"], "done");
    assert_eq!(statuses[0]["origin"], "hub");
    assert_eq!(statuses[0]["sessionId"], "fake-session-123");
    assert_eq!(statuses[1]["known"], false);
    let sessions = ccgui_next_lib::history::reader::list_sessions(app.state()).unwrap();
    assert!(sessions.iter().any(|s| s.session_id == "fake-session-123" && s.origin == "hub"));
    let page = ccgui_next_lib::history::reader::load_session_page(app.state(), "claude".into(), "fake-session-123".into(), None, None).await.unwrap();
    assert_eq!(page.origin, "hub");
    assert!(page.messages.iter().any(|m| m.text == "Hello from fake"));
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn interrupt_kills_running_child() {
    let _env_guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("interrupt");
    let bin_dir = home.join("appdata").join("npm");
    std::fs::create_dir_all(&bin_dir).unwrap();
    // Fake engine that emits a session id then hangs forever.
    let script = r#"#!/bin/sh
read -r line
echo '{"type":"system","subtype":"init","session_id":"fake-hang-1"}'
sleep 60
"#;
    let path = bin_dir.join("claude");
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(windows)]
    write_windows_cli(&bin_dir, "claude", r#"
process.stdin.once('data', () => {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fake-hang-1'}));
  setInterval(() => {}, 1000);
});
"#);
    let _environment = TestEnvironment::new(&home, &bin_dir);

    let workspace = home.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();

    let (app, events) = build_app(&home);
    let state = app.state::<AppState>();
    engine::send_message(
        state,
        "claude".to_string(),
        workspace.to_string_lossy().to_string(),
        None,
        "hi".to_string(),
        Vec::new(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // Wait for the session event (child registered under native id).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let seen = events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.get("kind").and_then(Value::as_str) == Some("session"));
        if seen {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no session event within 5s"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let killed = engine::interrupt_session(app.state::<AppState>(), "fake-hang-1".to_string())
        .await
        .unwrap();
    assert!(killed, "interrupt must find and kill the child");

    // Child exits shortly after start_kill.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if app
            .state::<AppState>()
            .processes
            .0
            .lock()
            .unwrap()
            .is_empty()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "child still registered after kill"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// The JS side invokes with camelCase args (`workspacePath`, `sessionId`,
/// `imagePaths`) against snake_case Rust params; this drives the real IPC
/// router to prove that contract plus the command's presence in the handler.
#[test]
fn ipc_send_message_accepts_camel_case_args() {
    let _env_guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("ipc");
    let bin_dir = home.join("appdata").join("npm");
    std::fs::create_dir_all(&bin_dir).unwrap();
    write_fake_claude(&bin_dir);
    let _environment = TestEnvironment::new(&home, &bin_dir);
    let workspace = home.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();

    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![engine::send_message])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let db = Arc::new(Db::open_at(&home.join("app.db")).unwrap());
    app.manage(AppState {
        db: db.clone(),
        sink: EventSink::with_journal(Arc::new(app.handle().clone()), db),
        terminal_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        plugin_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME,
        ),
        mission_sink: EventSink::with_name(
            Arc::new(app.handle().clone()),
            ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME,
        ),
        terminals: ccgui_next_lib::terminal::TerminalRegistry::default(),
        processes: Arc::new(ProcessRegistry::default()),
        emitters: ccgui_next_lib::event_sink::BroadcastEmit::new(Arc::new(app.handle().clone())),
        web: ccgui_next_lib::web::WebAccessState::default(),
        relay: ccgui_next_lib::relay::RelayState::default(),
        dsh_host: Arc::new(ccgui_next_lib::dsh_host::DshHostState::default()),
        opencode_server: std::sync::Arc::new(
            ccgui_next_lib::engine::opencode_server::OpencodeServerState::default(),
        ),
        worktree_creations: ccgui_next_lib::git_worktree::CreationRegistry::default(),
    });
    app.manage(ConfigStore::default());
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let res = tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "send_message".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "engine": "claude",
                "workspacePath": workspace.to_string_lossy(),
                "sessionId": null,
                "prompt": "hi",
                "promptContributions": [],
                "imagePaths": null,
                "model": null,
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    );
    let body = res.unwrap_or_else(|e| panic!("IPC send_message failed: {e}"));
    let value = body.deserialize::<Value>().unwrap();
    let run_id = value.get("runId").and_then(Value::as_str).unwrap_or("");
    assert!(!run_id.is_empty(), "expected runId in response: {value}");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn omp_send_uses_persisted_tier_and_model_without_touching_cli_config() {
    let _env_guard = ENV_LOCK.lock().unwrap();
    let home = temp_home("omp-tier");
    std::fs::create_dir_all(home.join(".ccgui-next")).unwrap();
    let bin_dir = home.join("appdata").join("npm");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let script = bin_dir.join("omp");
    std::fs::write(
        &script,
        r#"#!/bin/sh
printf '%s\n' "$@" > omp-args.txt
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}'
echo '{"type":"agent_end"}'
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(windows)]
    write_windows_cli(&bin_dir, "omp", r#"
require('node:fs').writeFileSync('omp-args.txt', process.argv.slice(2).join('\n')+'\n');
console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'ok'}}));
console.log(JSON.stringify({type:'agent_end'}));
"#);
    let _environment = TestEnvironment::new(&home, &bin_dir);
    let workspace = home.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let (app, events) = build_app(&home);
    let mut settings = ccgui_next_lib::settings::AppSettings::default();
    for (model, tier) in [
        ("openai-codex/gpt-5.4", Some("priority")),
        ("openai-codex/gpt-5.4", Some("default")),
        ("openai-codex/gpt-5.4", None),
        ("openai/gpt-5.4", Some("priority")),
        ("anthropic/claude", Some("priority")),
        ("google/gemini", Some("priority")),
        ("openai-codex/gpt-5.4", Some("priority")),
    ] {
        settings.default_models.insert("omp".into(), model.into());
        settings.omp_openai_service_tier = tier.map(str::to_string);
        ccgui_next_lib::settings::update_app_settings(app.handle().clone(), settings.clone())
            .unwrap();
        events.lock().unwrap().clear();
        engine::send_message(
            app.state(),
            "omp".into(),
            workspace.to_string_lossy().into(),
            None,
            "hi".into(),
            Vec::new(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if events.lock().unwrap().iter().any(|e| e["kind"] == "done") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "OMP did not complete");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let text = std::fs::read_to_string(workspace.join("omp-args.txt")).unwrap();
        let args: Vec<_> = text.lines().collect();
        assert!(args.windows(2).any(|a| a == ["--model", model]));
        let actual = args
            .iter()
            .position(|a| *a == "--service-tier")
            .map(|i| args[i + 1]);
        let expected = if model.starts_with("openai-codex/") {
            tier
        } else {
            None
        };
        assert_eq!(actual, expected, "model {model}");
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "delta" && e["data"] == "ok"));
    }
    assert!(!home.join(".omp/agent/config.yml").exists());
}
