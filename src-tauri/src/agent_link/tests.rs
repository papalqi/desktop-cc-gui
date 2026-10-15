use super::*;
use crate::event_sink::{BroadcastEmit, Emit};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{watch, Notify};
use tokio_tungstenite::tungstenite::Message;
struct Noop;
impl Emit for Noop {
    fn emit_json(&self, _: &str, _: &str) {}
}
type Peer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;
async fn pair() -> (client::Socket, Peer) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accept = tokio::spawn(async move {
        tokio_tungstenite::accept_async(listener.accept().await.unwrap().0)
            .await
            .unwrap()
    });
    let (client, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/"))
        .await
        .unwrap();
    (client, accept.await.unwrap())
}
async fn connection() -> (client::Connection, Peer, Peer, tokio::task::JoinHandle<()>) {
    let (control, c) = pair().await;
    let (bulk, b) = pair().await;
    let (local, mut l) = pair().await;
    let local = (
        local,
        tokio::spawn(async move { while let Some(Ok(_)) = l.next().await {} }),
    );
    (
        client::Connection {
            control,
            bulk,
            local: local.0,
            heartbeat_ms: 10000,
        },
        c,
        b,
        local.1,
    )
}
async fn next_control(peer: &mut Peer, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match peer.next().await {
                Some(Ok(Message::Text(raw))) => {
                    let value: Value = serde_json::from_str(&raw).unwrap();
                    if value["t"] == kind {
                        return value;
                    }
                }
                other => panic!("unexpected peer result: {other:?}"),
            }
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn cancelled_arguments_cannot_dispatch_and_disconnect_keeps_started_commands_alive() {
    let (connection, mut control, mut bulk, local) = connection().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let finished = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let (counter, ended, wait) = (calls.clone(), finished.clone(), release.clone());
    let context = runtime::Context {
        emitters: BroadcastEmit::new(Arc::new(Noop)),
        update: None,
        heartbeat: Arc::new(|seq| json!({"t":"hb","seq":seq,"activeRuns":[],"journalHead":0})),
        dispatch: Arc::new(move |_, _| {
            let calls = counter.clone();
            let finished = ended.clone();
            let release = wait.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                release.notified().await;
                finished.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"accepted":true}))
            })
        }),
    };
    let (stop, mut stopped) = watch::channel(false);
    let run = tokio::spawn(async move { runtime::run(connection, context, 0, &mut stopped).await });
    let mut sender = wire::Bulk::default();
    let args = sender
        .send(serde_json::to_vec(&json!({"message":"x".repeat(2*1024*1024)})).unwrap())
        .unwrap();
    control
        .send(Message::Text(
            json!({"t":"req","id":1,"cmd":"send_message","stream":args,"deadlineMs":30000})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let credit = next_control(&mut control, "credit").await;
    sender
        .credit(
            credit["id"].as_u64().unwrap() as u32,
            credit["bytes"].as_u64().unwrap() as usize,
        )
        .unwrap();
    let queued = sender.next_packet().unwrap();
    control
        .send(Message::Text(
            json!({"t":"cancel","id":1,"kind":"request"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    next_control(&mut control, "cancel").await;
    bulk.send(Message::Binary(queued.into())).await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    control
        .send(Message::Text(
            json!({"t":"req","id":99,"cmd":"send_message","args":{},"deadlineMs":0})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let expired = next_control(&mut control, "res").await;
    assert_eq!(expired["id"], 99);
    assert_eq!(expired["error"]["code"], "deadline_exceeded");
    assert_eq!(expired["error"]["definitive"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    control
        .send(Message::Text(
            json!({"t":"req","id":2,"cmd":"send_message","args":{},"deadlineMs":30000})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    control.close(None).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        while finished.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(stop);
    local.abort();
}

struct Child(std::process::Child);
#[tokio::test(start_paused = true)]
async fn a_half_open_control_socket_expires_even_when_its_tcp_connection_stays_open() {
    let (connection, _control, _bulk, local) = connection().await;
    let context = runtime::Context {
        emitters: BroadcastEmit::new(Arc::new(Noop)),
        update: None,
        heartbeat: Arc::new(|seq| json!({"t":"hb","seq":seq,"activeRuns":[],"journalHead":0})),
        dispatch: Arc::new(|_, _| Box::pin(async { Ok(Value::Null) })),
    };
    let (stop, mut stopped) = watch::channel(false);
    let run = tokio::spawn(async move { runtime::run(connection, context, 0, &mut stopped).await });
    for _ in 0..32 {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_secs(1)).await;
    }
    let error = run.await.unwrap().unwrap_err();
    assert!(error.contains("agent heartbeat"), "{error}");
    drop(stop);
    local.abort();
}

#[tokio::test]
async fn protocol_discovery_falls_back_only_for_an_explicit_legacy_hub() {
    use axum::response::IntoResponse;
    let mode = Arc::new(AtomicUsize::new(0));
    let selected = mode.clone();
    let router = axum::Router::new().route("/_relay/agent-protocol",axum::routing::get(move || { let selected = selected.clone(); async move { match selected.load(Ordering::SeqCst) {
        0 => axum::Json(json!({"protocols":[0]})).into_response(),
        1 => axum::Json(json!({"protocols":[0,1]})).into_response(),
        2 => axum::http::StatusCode::UNAUTHORIZED.into_response(),
        3 => "<title>中转登录</title><form action=\"/_relay/login\"><input type=\"password\"></form>".into_response(),
        _ => axum::Json(json!({"protocols":[]})).into_response(),
    } } }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let target =
        identity::Target::from_legacy(&format!("ws://127.0.0.1:{port}/m/PC6/agent?key=test"))
            .unwrap();
    assert!(!identity::supports_v1(&target).await.unwrap());
    mode.store(1, Ordering::SeqCst);
    assert!(identity::supports_v1(&target).await.unwrap());
    mode.store(2, Ordering::SeqCst);
    assert!(identity::supports_v1(&target).await.is_err());
    mode.store(3, Ordering::SeqCst);
    assert!(!identity::supports_v1(&target).await.unwrap());
    mode.store(4, Ordering::SeqCst);
    assert!(identity::supports_v1(&target).await.is_err());
    server.abort();
}

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
async fn poll(client: &reqwest::Client, base: &str, check: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let state: Value = client
                .get(format!("{base}/test/state"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if check(&state) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
// This acceptance test needs both repositories and Bun; run explicitly rather
// than making a standalone native checkout depend on the Hub checkout.
#[tokio::test]
#[ignore = "requires sibling ccgui-relay checkout and Bun; explicit Agent Link acceptance test"]
async fn native_hub_real_sockets_approval_bulk_qos_events_http_and_reconnect() {
    let harness = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("ccgui-relay/test-support/native-agent-harness.mjs");
    assert!(harness.is_file(), "missing Hub interoperability harness");
    let mut child = Child(
        std::process::Command::new("bun")
            .arg(&harness)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port = serde_json::from_str::<Value>(&line).unwrap()["port"]
        .as_u64()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let legacy = format!("ws://127.0.0.1:{port}/m/PC6/agent?key=native-test-bootstrap");
    let path = std::env::temp_dir().join(format!("ccgui-v1-interop-{}.db", uuid::Uuid::new_v4()));
    let db = crate::db::Db::open_at(&path).unwrap();
    let web = axum::Router::new().route("/ws",axum::routing::get(|headers:axum::http::HeaderMap,ws:axum::extract::WebSocketUpgrade| async move {
        assert_eq!(headers["cookie"],"ccgui_device=native-test-approved"); assert_eq!(headers["x-ccgui-via"],"relay");
        ws.on_upgrade(|mut socket| async move { socket.send(axum::extract::ws::Message::Text(json!({"type":"hello","version":env!("CARGO_PKG_VERSION"),"capabilities":["journal","session_origin","run_status","session_log"]}).to_string().into())).await.unwrap(); while let Some(Ok(_)) = socket.next().await {} })
    })).route("/echo",axum::routing::post(|headers:axum::http::HeaderMap,body:axum::body::Bytes| async move { assert_eq!(headers["x-ccgui-via"],"relay"); body }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_port = listener.local_addr().unwrap().port();
    let local = tokio::spawn(async move {
        axum::serve(listener, web).await.unwrap();
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap();
    let failure = client::connect(&db, &legacy, local_port).await;
    assert!(matches!(failure,Err(error) if error.contains("approval_required")));
    client
        .post(format!("{base}/test/approve"))
        .send()
        .await
        .unwrap();
    let connection = client::connect(&db, &legacy, local_port)
        .await
        .unwrap()
        .unwrap();
    assert!(identity::load(&db, &base).unwrap().token.is_some());
    let emitters = BroadcastEmit::new(Arc::new(Noop));
    let data = Arc::new(format!("{}中文🙂", "x".repeat(64 * 1024 * 1024)));
    let stops = Arc::new(AtomicUsize::new(0));
    let (large, count) = (data.clone(), stops.clone());
    let make_context = move || {
        let large = large.clone();
        let count = count.clone();
        runtime::Context {
            emitters: emitters.clone(),
            update: None,
            heartbeat: Arc::new(
                |seq| json!({"t":"hb","seq":seq,"sentAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,"journalHead":5,"activeRuns":[{"runId":"live","engine":"grok","workspacePath":"/ws","sessionId":"s","startedAt":1,"state":"awaiting-input","updatedAt":2}]}),
            ),
            dispatch: Arc::new(move |cmd, args| {
                let data = large.clone();
                let count = count.clone();
                Box::pin(async move {
                    if cmd == "read_file" {
                        Ok(json!({"content":data.as_str()}))
                    } else {
                        if cmd == "interrupt_run" {
                            count.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(args)
                    }
                })
            }),
        }
    };
    let context = make_context();
    let emitter = context.emitters.clone();
    let (stop, mut stopped) = watch::channel(false);
    let run =
        tokio::spawn(
            async move { runtime::run(connection, context, local_port, &mut stopped).await },
        );
    poll(&client, &base, |state| {
        state["heartbeats"].as_u64().unwrap() > 0 && state["connected"] == true
    })
    .await;
    client
        .post(format!("{base}/test/hold"))
        .send()
        .await
        .unwrap();
    let request = client
        .post(format!("{base}/test/invoke"))
        .json(&json!({"cmd":"read_file","args":{}}));
    let reading =
        tokio::spawn(async move { request.send().await.unwrap().json::<Value>().await.unwrap() });
    poll(&client, &base, |state| state["held"].as_u64().unwrap() > 0).await;
    let start = std::time::Instant::now();
    let answer: Value = client
        .post(format!("{base}/test/invoke"))
        .json(&json!({"cmd":"interrupt_run","args":{"runId":"live"}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let latency = start.elapsed();
    assert_eq!(answer["data"]["runId"], "live");
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert!(
        latency < Duration::from_secs(1),
        "64 MiB transfer blocked stop for {latency:?}"
    );
    println!("v1 real loopback: 64 MiB result paused after its initial credit; interrupt RPC round trip {latency:?}");
    assert!(!reading.is_finished());
    client
        .post(format!("{base}/test/release"))
        .send()
        .await
        .unwrap();
    let result = reading.await.unwrap();
    assert_eq!(result["data"]["content"].as_str(), Some(data.as_str()));
    drop(result);
    client
        .post(format!("{base}/test/hold"))
        .send()
        .await
        .unwrap();
    let tool = data.as_str();
    emitter.emit_json("engine://event",&json!([{ "runId":"r","seq":1,"kind":"message","data":{"role":"tool","text":"exec","result":tool} }]).to_string());
    emitter.emit_json(
        "engine://event",
        &json!([{ "runId":"r","seq":2,"kind":"done","data":{} }]).to_string(),
    );
    poll(&client, &base, |state| state["held"].as_u64().unwrap() > 0).await;
    let started = std::time::Instant::now();
    let answer: Value = client
        .post(format!("{base}/test/invoke"))
        .json(&json!({"cmd":"interrupt_run","args":{"runId":"live"}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(answer["data"]["runId"], "live");
    let latency = started.elapsed();
    assert!(latency < Duration::from_secs(1));
    let heartbeat = poll(&client, &base, |state| {
        state["heartbeats"].as_u64().unwrap() >= 2
    })
    .await;
    let heartbeat_latency = heartbeat["heartbeatLatency"].as_u64().unwrap();
    assert!(heartbeat_latency < 1000);
    println!("v1 real loopback: 64 MiB tool event paused; interrupt RPC {latency:?}, heartbeat generation to Hub {heartbeat_latency} ms");
    client
        .post(format!("{base}/test/release"))
        .send()
        .await
        .unwrap();
    let state = poll(&client, &base, |state| {
        state["events"].as_array().unwrap().len() >= 2
    })
    .await;
    use sha2::Digest;
    assert_eq!(
        state["events"][0]["payload"][0]["data"]["result"]["bytes"],
        tool.len()
    );
    assert_eq!(
        state["events"][0]["payload"][0]["data"]["result"]["sha256"],
        format!("{:x}", sha2::Sha256::digest(tool.as_bytes()))
    );
    assert_eq!(state["events"][1]["payload"][0]["kind"], "done");
    let upload = "上传🙂".repeat(100000).into_bytes();
    use base64::Engine;
    let frames = json!([{"t":"open","id":71,"path":"/echo","method":"POST","headers":{},"ws":false},{"t":"body","id":71,"b64":base64::engine::general_purpose::STANDARD.encode(&upload)},{"t":"end","id":71}]);
    client
        .post(format!("{base}/test/tunnel"))
        .json(&frames)
        .send()
        .await
        .unwrap();
    let state = poll(&client, &base, |state| {
        state["tunnels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|frame| frame["t"] == "close" && frame["id"] == 71)
    })
    .await;
    let bytes: usize = state["tunnels"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|frame| frame["t"] == "data")
        .map(|frame| frame["length"].as_u64().unwrap() as usize)
        .sum();
    assert_eq!(bytes, upload.len());
    stop.send(true).unwrap();
    assert!(run.await.unwrap().is_ok());
    client
        .post(format!("{base}/test/approve"))
        .send()
        .await
        .unwrap();
    let reenroll = client::connect(&db, &legacy, local_port).await;
    assert!(matches!(reenroll,Err(error) if error.contains("reenrollment_required")));
    assert!(identity::load(&db, &base).unwrap().token.is_none());
    let connection = client::connect(&db, &legacy, local_port)
        .await
        .unwrap()
        .unwrap();
    let context = make_context();
    let (stop, mut stopped) = watch::channel(false);
    let run =
        tokio::spawn(
            async move { runtime::run(connection, context, local_port, &mut stopped).await },
        );
    poll(&client, &base, |state| state["connected"] == true).await;
    client
        .post(format!("{base}/test/revoke"))
        .send()
        .await
        .unwrap();
    assert!(run.await.unwrap().is_err());
    let failure = client::connect(&db, &legacy, local_port).await;
    assert!(matches!(failure,Err(error) if error.contains("invalid_token")));
    drop(stop);
    local.abort();
    drop(db);
    std::fs::remove_file(path).unwrap();
}
