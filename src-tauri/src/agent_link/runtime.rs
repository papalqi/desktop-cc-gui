use super::{client::Connection, transport::Transport, wire};
use crate::event_sink::{BroadcastEmit, Emit};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
    time::Instant,
};
use tokio_tungstenite::tungstenite::Message;

type Dispatch = Arc<
    dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>
        + Send
        + Sync,
>;
pub(super) struct Context {
    pub emitters: Arc<BroadcastEmit>,
    pub dispatch: Dispatch,
    pub heartbeat: Arc<dyn Fn(u64) -> Value + Send + Sync>,
    pub update: Option<Arc<crate::relay_update::UpdateState>>,
}
struct Request {
    deadline: Instant,
    started: bool,
    _activity: Option<crate::relay_update::Activity>,
}
type Requests = Arc<Mutex<HashMap<u64, Request>>>;
struct Event {
    name: String,
    raw: String,
    budget: Arc<AtomicUsize>,
}
impl Drop for Event {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.raw.len(), Ordering::Relaxed);
    }
}
struct Events {
    tx: mpsc::Sender<Event>,
    budget: Arc<AtomicUsize>,
    lagged: Arc<AtomicBool>,
}
impl Emit for Events {
    fn emit_json(&self, name: &str, raw: &str) {
        if raw.len() > wire::BULK_BYTES {
            self.lagged.store(true, Ordering::Relaxed);
            return;
        }
        if self.budget.fetch_add(raw.len(), Ordering::Relaxed) > wire::BULK_BYTES - raw.len() {
            self.budget.fetch_sub(raw.len(), Ordering::Relaxed);
            self.lagged.store(true, Ordering::Relaxed);
            return;
        }
        if self
            .tx
            .try_send(Event {
                name: name.to_owned(),
                raw: raw.to_owned(),
                budget: self.budget.clone(),
            })
            .is_err()
        {
            self.lagged.store(true, Ordering::Relaxed);
        }
    }
}
struct Subscription {
    emitters: Arc<BroadcastEmit>,
    id: u64,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.emitters.remove(self.id);
    }
}
struct Lifetime {
    active: Arc<AtomicBool>,
    requests: Requests,
    io: Arc<Transport>,
}
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.requests.lock().clear();
        self.io.close();
    }
}

fn event_frames(event: &Event) -> Result<Vec<(Value, Vec<u8>)>, String> {
    if matches!(
        event.name.as_str(),
        "engine://event" | "plugin-agent://event" | "mission-agent://event"
    ) {
        #[derive(Deserialize)]
        struct Identity {
            #[serde(rename = "runId")]
            run_id: String,
        }
        let values: Vec<Box<serde_json::value::RawValue>> = serde_json::from_str(&event.raw)
            .or_else(|_| serde_json::from_str(&event.raw).map(|value| vec![value]))
            .map_err(|e| e.to_string())?;
        let mut groups: Vec<(String, Vec<Box<serde_json::value::RawValue>>)> = Vec::new();
        for value in values {
            let identity: Identity =
                serde_json::from_str(value.get()).map_err(|e| e.to_string())?;
            if let Some((_, items)) = groups.iter_mut().find(|(run, _)| *run == identity.run_id) {
                items.push(value);
            } else {
                groups.push((identity.run_id, vec![value]));
            }
        }
        groups
            .into_iter()
            .map(|(run_id, items)| {
                Ok((
                    json!({"t":"event","name":event.name,"runId":run_id}),
                    serde_json::to_vec(&items).map_err(|e| e.to_string())?,
                ))
            })
            .collect()
    } else {
        Ok(vec![(
            json!({"t":"event","name":event.name}),
            event.raw.as_bytes().to_vec(),
        )])
    }
}
async fn forward_event(io: &Transport, event: Event) -> Result<(), String> {
    let frames = if event.raw.len() > wire::CONTROL_BYTES / 2 {
        tokio::task::spawn_blocking(move || event_frames(&event))
            .await
            .map_err(|e| e.to_string())??
    } else {
        event_frames(&event)?
    };
    for (frame, bytes) in frames {
        io.content(frame, "payload", bytes, false).await?;
    }
    Ok(())
}
fn response_error(
    io: &Transport,
    id: u64,
    code: &str,
    message: String,
    definitive: bool,
) -> Result<(), String> {
    io.control(json!({"t":"res","id":id,"ok":false,"error":{"code":code,"message":message,"definitive":definitive}}))
}

fn dispatch_request(
    frame: Value,
    bytes: Option<Vec<u8>>,
    requests: &Requests,
    io: &Arc<Transport>,
    active: &Arc<AtomicBool>,
    dispatch: &Dispatch,
) {
    let id = frame["id"].as_u64().unwrap();
    let requests = requests.clone();
    let io = io.clone();
    let active = active.clone();
    let dispatch = dispatch.clone();
    // Deliberately detached: disconnect/cancel may discard a reply, but cannot
    // cancel a command after it entered the existing native dispatch lifecycle.
    tokio::spawn(async move {
        let args = if let Some(bytes) = bytes {
            tokio::task::spawn_blocking(move || {
                serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|value| value)
        } else {
            Ok(frame["args"].clone())
        };
        let args = match args {
            Ok(args) => args,
            Err(error) => {
                requests.lock().remove(&id);
                let _ = response_error(&io, id, "invalid_args", error, true);
                return;
            }
        };
        {
            let mut pending = requests.lock();
            let Some(request) = pending.get_mut(&id) else {
                return;
            };
            if !active.load(Ordering::Acquire) {
                pending.remove(&id);
                return;
            }
            if Instant::now() >= request.deadline {
                pending.remove(&id);
                drop(pending);
                let _ = response_error(
                    &io,
                    id,
                    "deadline_exceeded",
                    "executor request deadline expired before dispatch".into(),
                    true,
                );
                return;
            }
            request.started = true;
        }
        let result = dispatch(frame["cmd"].as_str().unwrap().to_owned(), args).await;
        let Some(_request) = requests.lock().remove(&id) else {
            return;
        };
        if !active.load(Ordering::Acquire) {
            return;
        }
        match result {
            Ok(payload) => {
                let bytes = tokio::task::spawn_blocking(move || {
                    serde_json::to_vec(&payload).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())
                .and_then(|value| value);
                let result = match bytes {
                    Ok(bytes) => {
                        io.content(json!({"t":"res","id":id,"ok":true}), "data", bytes, false)
                            .await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    let _ = response_error(&io, id, "response_unavailable", error, false);
                }
            }
            Err(error) => {
                let code = if error.starts_with("unknown command") {
                    "unknown_command"
                } else {
                    "command_failed"
                };
                let _ = response_error(&io, id, code, error, true);
            }
        }
    });
}

pub(crate) async fn serve(
    connection: Connection,
    app: &tauri::AppHandle,
    port: u16,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let handle = app.clone();
    let db = state.db.clone();
    let processes = state.processes.clone();
    let states = Mutex::new(HashMap::<String, (String, u64)>::new());
    let context = Context {
        emitters: state.emitters.clone(),
        update: Some(state.relay.update.clone()),
        dispatch: Arc::new(move |cmd, args| {
            let app = handle.clone();
            Box::pin(async move { crate::web::dispatch_relay(&app, &cmd, args).await })
        }),
        heartbeat: Arc::new(move |seq| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let runs = processes.active_runs();
            let mut status = states.lock();
            status.retain(|id, _| runs.iter().any(|run| run.run_id == *id));
            let runs: Vec<Value> = runs
                .into_iter()
                .map(|run| {
                    let state = if let Some(entry) = processes.get(&run.run_id) {
                        if entry
                            .plans
                            .lock()
                            .map(|plans| !plans.is_empty())
                            .unwrap_or(false)
                        {
                            "awaiting-approval"
                        } else if entry
                            .questions
                            .lock()
                            .map(|questions| !questions.is_empty())
                            .unwrap_or(false)
                        {
                            "awaiting-input"
                        } else {
                            "running"
                        }
                    } else {
                        "running"
                    };
                    let previous = status
                        .entry(run.run_id.clone())
                        .or_insert((state.to_owned(), now));
                    if previous.0 != state {
                        *previous = (state.to_owned(), now);
                    }
                    let mut value = serde_json::to_value(run).unwrap();
                    value["state"] = json!(state);
                    value["updatedAt"] = json!(previous.1);
                    value
                })
                .collect();
            let head =
                db.0.lock()
                    .query_row(
                        "SELECT COALESCE(MAX(cursor),0) FROM chat_events",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap_or(0);
            json!({"t":"hb","seq":seq,"activeRuns":runs,"journalHead":head})
        }),
    };
    run(connection, context, port, stop).await
}

pub(super) async fn run(
    connection: Connection,
    context: Context,
    port: u16,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let Connection {
        control,
        bulk,
        mut local,
        heartbeat_ms,
    } = connection;
    let (mut control_tx, mut control_rx) = control.split();
    let (mut bulk_tx, mut bulk_rx) = bulk.split();
    let (out, mut queue) = mpsc::channel::<String>(256);
    let io = Transport::new(out, context.update.clone());
    let requests: Requests = Arc::new(Mutex::new(HashMap::new()));
    let active = Arc::new(AtomicBool::new(true));
    let _lifetime = Lifetime {
        active: active.clone(),
        requests: requests.clone(),
        io: io.clone(),
    };
    let mut tasks = JoinSet::<Result<(), String>>::new();
    tasks.spawn(async move {
        while let Some(frame) = queue.recv().await {
            control_tx
                .send(Message::Text(frame.into()))
                .await
                .map_err(|_| "agent control writer failed")?;
        }
        Ok(())
    });
    let bulk_io = io.clone();
    tasks.spawn(async move {
        loop {
            let wake = bulk_io.changed.notified();
            if let Some(packet) = bulk_io.next_packet() {
                bulk_tx
                    .send(Message::Binary(packet.clone().into()))
                    .await
                    .map_err(|_| "agent bulk writer failed")?;
                bulk_io.sent(&packet);
            } else {
                wake.await;
            }
        }
    });
    tasks.spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(10)); let mut last = Instant::now();
        loop { tokio::select! {
            _ = ping.tick() => { if last.elapsed() >= Duration::from_secs(30) { return Err("local bridge heartbeat timed out".into()); } local.send(Message::Ping(Vec::new().into())).await.map_err(|_| "local bridge disconnected")?; }
            next = local.next() => match next { Some(Ok(Message::Close(_)))|Some(Err(_))|None => return Err("local bridge authorization ended".into()),Some(Ok(_)) => { last = Instant::now(); } }
        } }
    });
    let (event_tx, mut events) = mpsc::channel::<Event>(256);
    let lagged = Arc::new(AtomicBool::new(false));
    let id = context.emitters.add(Arc::new(Events {
        tx: event_tx,
        budget: Arc::new(AtomicUsize::new(0)),
        lagged: lagged.clone(),
    }));
    let _subscription = Subscription {
        emitters: context.emitters.clone(),
        id,
    };
    let event_io = io.clone();
    tasks.spawn(async move {
        while let Some(event) = events.recv().await {
            if lagged.swap(false, Ordering::Relaxed) {
                event_io.control(json!({"t":"event","name":"engine://resync","payload":null}))?;
            }
            forward_event(&event_io, event).await?;
        }
        Ok(())
    });
    let beat_io = io.clone();
    let heartbeat = context.heartbeat.clone();
    tasks.spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_millis(heartbeat_ms));
        let mut seq = 0;
        loop {
            timer.tick().await;
            seq += 1;
            let heartbeat = heartbeat.clone();
            let frame = tokio::task::spawn_blocking(move || heartbeat(seq))
                .await
                .map_err(|e| e.to_string())?;
            beat_io.control(frame)?;
        }
    });
    let mut tunnels = super::tunnel::Tunnels::new(port, io.clone(), context.update.clone());
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    let mut last = Instant::now();
    loop {
        let incoming = tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            task = tasks.join_next() => return task.unwrap().map_err(|e| e.to_string()).and_then(|value| value).and(Err("agent worker ended".into())),
            next = control_rx.next() => {
                last = Instant::now();
                match next { Some(Ok(Message::Text(raw))) => Some((wire::parse_control(&raw)?,None)),Some(Ok(Message::Close(_)))|Some(Err(_))|None => return Err("agent control disconnected".into()),Some(Ok(_)) => None }
            }
            _ = timer.tick() => {
                if last.elapsed() >= Duration::from_secs(30) || io.timed_out() { return Err("agent heartbeat or bulk transfer timed out".into()); }
                let expired:Vec<(u64,bool)> = requests.lock().iter().filter(|(_,value)| Instant::now() >= value.deadline).map(|(id,value)| (*id,value.started)).collect();
                for (id,started) in expired { requests.lock().remove(&id); io.cancel_request(id)?; response_error(&io,id,"deadline_exceeded","executor request deadline expired".into(),!started)?; }
                continue;
            }
            next = bulk_rx.next() => match next { Some(Ok(Message::Binary(packet))) => io.receive(&packet)?.map(|(frame,bytes)| (frame,Some(bytes))),Some(Ok(Message::Ping(_)|Message::Pong(_))) => None,_ => return Err("agent bulk disconnected".into()) },
        };
        let Some((frame, bytes)) = incoming else {
            continue;
        };
        match frame["t"].as_str().unwrap_or("") {
            "credit" => io.credit(
                frame["id"].as_u64().unwrap() as u32,
                frame["bytes"].as_u64().unwrap() as usize,
            )?,
            "hb-ack" => {}
            "cancel" if frame["kind"] == "stream" => {
                io.cancel_outgoing(frame["id"].as_u64().unwrap() as u32)
            }
            "cancel" => {
                let id = frame["id"].as_u64().unwrap();
                requests.lock().remove(&id);
                io.cancel_request(id)?;
            }
            "req" => {
                let id = frame["id"].as_u64().unwrap();
                if bytes.is_none() {
                    if requests.lock().contains_key(&id) {
                        return Err("duplicate agent request id".into());
                    }
                    let activity = context
                        .update
                        .as_ref()
                        .map(|update| update.activity(false))
                        .transpose();
                    let activity = match activity {
                        Ok(activity) => activity,
                        Err(error) => {
                            response_error(&io, id, "executor_updating", error, true)?;
                            continue;
                        }
                    };
                    requests.lock().insert(
                        id,
                        Request {
                            deadline: Instant::now()
                                + Duration::from_millis(frame["deadlineMs"].as_u64().unwrap()),
                            started: false,
                            _activity: activity,
                        },
                    );
                }
                if bytes.is_none() && !frame["stream"].is_null() {
                    io.expect(frame)?;
                } else {
                    dispatch_request(frame, bytes, &requests, &io, &active, &context.dispatch);
                }
            }
            "open" | "body" | "data" | "end" | "close" => {
                if bytes.is_none() && !frame["stream"].is_null() {
                    tunnels.expect(frame.clone());
                    io.expect(frame)?;
                } else {
                    tunnels.receive(frame, bytes)?;
                }
            }
            _ => return Err("unexpected Hub control frame".into()),
        }
    }
}
