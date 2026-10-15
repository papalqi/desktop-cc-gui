use super::{client::Socket, transport::Transport, wire::BULK_BYTES};
use crate::{
    relay::{HOP_HEADERS, VIA_HEADER},
    relay_update::{Activity, UpdateState},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

struct Http {
    method: String,
    path: String,
    headers: Value,
    body: Vec<u8>,
    _activity: Option<Activity>,
}
struct SocketTask {
    tx: mpsc::Sender<(Vec<u8>, bool)>,
    task: tokio::task::AbortHandle,
}
struct Queued {
    frame: Value,
    bytes: Option<Vec<u8>>,
    ready: bool,
}
pub(super) struct Tunnels {
    port: u16,
    io: Arc<Transport>,
    update: Option<Arc<UpdateState>>,
    client: reqwest::Client,
    http: HashMap<u64, Http>,
    jobs: HashMap<u64, tokio::task::AbortHandle>,
    sockets: HashMap<u64, SocketTask>,
    queues: HashMap<u64, VecDeque<Queued>>,
    pending_bytes: usize,
}
impl Drop for Tunnels {
    fn drop(&mut self) {
        for task in self.jobs.values() {
            task.abort();
        }
        for socket in self.sockets.values() {
            socket.task.abort();
        }
    }
}
impl Tunnels {
    pub fn new(port: u16, io: Arc<Transport>, update: Option<Arc<UpdateState>>) -> Self {
        Self {
            port,
            io,
            update,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            http: HashMap::new(),
            jobs: HashMap::new(),
            sockets: HashMap::new(),
            queues: HashMap::new(),
            pending_bytes: 0,
        }
    }
    pub fn expect(&mut self, frame: Value) {
        self.queues
            .entry(frame["id"].as_u64().unwrap())
            .or_default()
            .push_back(Queued {
                frame,
                bytes: None,
                ready: false,
            });
    }
    pub fn receive(&mut self, frame: Value, bytes: Option<Vec<u8>>) -> Result<(), String> {
        let id = frame["id"].as_u64().unwrap();
        self.jobs.retain(|_, task| !task.is_finished());
        if frame["t"] == "close" {
            if let Some(queue) = self.queues.remove(&id) {
                for entry in queue {
                    if !entry.ready {
                        self.io
                            .cancel_incoming(entry.frame["stream"]["id"].as_u64().unwrap() as u32)?;
                    }
                }
            }
            if let Some(task) = self.jobs.remove(&id) {
                task.abort();
            }
            if let Some(socket) = self.sockets.remove(&id) {
                socket.task.abort();
            }
            if let Some(http) = self.http.remove(&id) {
                self.pending_bytes -= http.body.len();
            }
            return Ok(());
        }
        if bytes.is_some() {
            let queue = self.queues.get_mut(&id).ok_or("unexpected tunnel body")?;
            let entry = queue
                .iter_mut()
                .find(|entry| !entry.ready && entry.frame["stream"]["id"] == frame["stream"]["id"])
                .ok_or("unexpected tunnel body")?;
            entry.bytes = bytes;
            entry.ready = true;
        } else {
            self.queues.entry(id).or_default().push_back(Queued {
                frame,
                bytes: None,
                ready: true,
            });
        }
        loop {
            let entry = self
                .queues
                .get_mut(&id)
                .and_then(|queue| queue.front().filter(|entry| entry.ready).map(|_| ()))
                .and_then(|_| self.queues.get_mut(&id).unwrap().pop_front());
            let Some(entry) = entry else {
                break;
            };
            self.deliver(entry.frame, entry.bytes)?;
        }
        if self.queues.get(&id).is_some_and(VecDeque::is_empty) {
            self.queues.remove(&id);
        }
        Ok(())
    }
    fn deliver(&mut self, frame: Value, bytes: Option<Vec<u8>>) -> Result<(), String> {
        let id = frame["id"].as_u64().unwrap();
        match frame["t"].as_str().unwrap() {
            "open" => {
                if self.http.contains_key(&id)
                    || self.jobs.contains_key(&id)
                    || self.sockets.contains_key(&id)
                {
                    return Err("duplicate tunnel id".into());
                }
                let activity = self
                    .update
                    .as_ref()
                    .map(|update| update.activity(true))
                    .transpose()?;
                if frame["ws"] == true {
                    let (tx, rx) = mpsc::channel(256);
                    let io = self.io.clone();
                    let port = self.port;
                    let task = tokio::spawn(async move {
                        let _activity = activity;
                        if let Err(error) = socket(frame, port, rx, &io).await {
                            let _ = io.control(json!({"t":"error","id":id,"message":error}));
                        }
                        let _ = io.control(json!({"t":"close","id":id}));
                    });
                    self.sockets.insert(
                        id,
                        SocketTask {
                            tx,
                            task: task.abort_handle(),
                        },
                    );
                } else {
                    self.http.insert(
                        id,
                        Http {
                            method: frame["method"].as_str().unwrap().to_owned(),
                            path: frame["path"].as_str().unwrap().to_owned(),
                            headers: frame["headers"].clone(),
                            body: Vec::new(),
                            _activity: activity,
                        },
                    );
                }
            }
            "body" => {
                if let Some(http) = self.http.get_mut(&id) {
                    let bytes = bytes.ok_or("missing tunnel body")?;
                    if self.pending_bytes + bytes.len() > BULK_BYTES {
                        return Err("HTTP request bodies exceed protocol limit".into());
                    }
                    self.pending_bytes += bytes.len();
                    http.body.extend(bytes);
                }
            }
            "end" => {
                if let Some(http) = self.http.remove(&id) {
                    self.pending_bytes -= http.body.len();
                    let io = self.io.clone();
                    let port = self.port;
                    let client = self.client.clone();
                    let task = tokio::spawn(async move {
                        if let Err(error) = request(id, http, port, &io, client).await {
                            let _ = io.control(json!({"t":"error","id":id,"message":error}));
                        }
                        let _ = io.control(json!({"t":"close","id":id}));
                    });
                    self.jobs.insert(id, task.abort_handle());
                }
            }
            "data" => {
                if let Some(socket) = self.sockets.get(&id) {
                    if socket
                        .tx
                        .try_send((
                            bytes.ok_or("missing socket body")?,
                            frame["text"].as_bool().unwrap_or(true),
                        ))
                        .is_err()
                    {
                        if let Some(socket) = self.sockets.remove(&id) {
                            socket.task.abort();
                        }
                        self.io.control(
                            json!({"t":"error","id":id,"message":"local socket queue is full"}),
                        )?;
                    }
                }
            }
            _ => return Err("unexpected tunnel frame".into()),
        }
        Ok(())
    }
}
async fn request(
    id: u64,
    pending: Http,
    port: u16,
    io: &Transport,
    client: reqwest::Client,
) -> Result<(), String> {
    let _activity = pending._activity;
    let method = reqwest::Method::from_bytes(pending.method.as_bytes())
        .map_err(|_| "invalid HTTP method")?;
    let mut request = client
        .request(method, format!("http://127.0.0.1:{port}{}", pending.path))
        .header(VIA_HEADER, "relay");
    for (name, value) in pending.headers.as_object().ok_or("invalid HTTP headers")? {
        if !HOP_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            request = request.header(name, value.as_str().ok_or("invalid HTTP header value")?);
        }
    }
    let response = request
        .body(pending.body)
        .send()
        .await
        .map_err(|_| "local HTTP request failed")?;
    let mut headers = serde_json::Map::new();
    for (name, value) in response.headers() {
        if !HOP_HEADERS.contains(&name.as_str()) {
            if let Ok(value) = value.to_str() {
                headers.insert(name.to_string(), json!(value));
            }
        }
    }
    io.control(json!({"t":"head","id":id,"status":response.status().as_u16(),"headers":headers}))?;
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|_| "local HTTP body failed")?;
        body.extend_from_slice(&bytes);
        if body.len() >= 512 * 1024 {
            io.content(
                json!({"t":"data","id":id}),
                "bytes",
                std::mem::take(&mut body),
                true,
            )
            .await?;
        }
    }
    if !body.is_empty() {
        io.content(json!({"t":"data","id":id}), "bytes", body, true)
            .await?;
    }
    Ok(())
}
async fn socket(
    frame: Value,
    port: u16,
    mut frames: mpsc::Receiver<(Vec<u8>, bool)>,
    io: &Transport,
) -> Result<(), String> {
    let id = frame["id"].as_u64().unwrap();
    let mut request = format!("ws://127.0.0.1:{port}{}", frame["path"].as_str().unwrap())
        .into_client_request()
        .map_err(|_| "invalid socket path")?;
    request
        .headers_mut()
        .insert(VIA_HEADER, "relay".parse().unwrap());
    for (name, value) in frame["headers"]
        .as_object()
        .ok_or("invalid socket headers")?
    {
        let lower = name.to_ascii_lowercase();
        if HOP_HEADERS.contains(&lower.as_str())
            || lower.starts_with("sec-websocket")
            || lower == "origin"
        {
            continue;
        }
        request.headers_mut().insert(
            name.parse::<tokio_tungstenite::tungstenite::http::HeaderName>()
                .map_err(|_| "invalid socket header")?,
            value
                .as_str()
                .ok_or("invalid socket header value")?
                .parse()
                .map_err(|_| "invalid socket header value")?,
        );
    }
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|_| "local socket connection failed")?;
    pipe_socket(socket, id, &mut frames, io).await
}
async fn pipe_socket(
    mut socket: Socket,
    id: u64,
    frames: &mut mpsc::Receiver<(Vec<u8>, bool)>,
    io: &Transport,
) -> Result<(), String> {
    loop {
        tokio::select! {
            frame = frames.recv() => match frame { Some((bytes,text)) => { let message = if text { Message::Text(String::from_utf8(bytes).map_err(|_| "invalid socket UTF-8")?.into()) } else { Message::Binary(bytes.into()) }; socket.send(message).await.map_err(|_| "local socket write failed")?; },None => return Ok(()) },
            next = socket.next() => match next { Some(Ok(Message::Text(text))) => io.content(json!({"t":"data","id":id,"text":true}),"bytes",text.as_bytes().to_vec(),true).await?,Some(Ok(Message::Binary(bytes))) => io.content(json!({"t":"data","id":id,"text":false}),"bytes",bytes.to_vec(),true).await?,Some(Ok(Message::Close(_)))|None => return Ok(()),Some(Err(_)) => return Err("local socket read failed".into()),_ => {} }
        }
    }
}
