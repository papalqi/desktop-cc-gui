use super::{identity, wire};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
pub(super) type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
pub(crate) struct Connection {
    pub(super) control: Socket,
    pub(super) bulk: Socket,
    pub(super) local: Socket,
    pub(super) heartbeat_ms: u64,
}

async fn greeting(socket: &mut Socket) -> Result<Value, String> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(raw))) => return wire::parse_control(&raw),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => return Err("agent greeting was interrupted".into()),
        }
    }
}
async fn send(socket: &mut Socket, frame: Value) -> Result<(), String> {
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .map_err(|_| "agent greeting could not be sent".into())
}

pub(crate) async fn connect(
    db: &crate::db::Db,
    legacy: &str,
    port: u16,
) -> Result<Option<Connection>, String> {
    let Some(target) = identity::Target::from_legacy(legacy) else {
        return Ok(None);
    };
    if !identity::supports_v1(&target).await? {
        return Ok(None);
    }
    let credential = identity::load(db, &target.hub)?;
    let mut capabilities = vec![
        "debug_snapshot",
        "debug_logs",
        "journal",
        "session_origin",
        "run_status",
        "session_log",
        "session_metadata",
        "bulk",
    ];
    if cfg!(windows) {
        capabilities.push("self_update");
    }
    let mut hello = json!({"t":"hello","protocol":1,"machineId":credential.machine_id,"name":target.name,"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"capabilities":capabilities});
    if let Some(token) = credential.token.as_ref() {
        crate::diagnostics::register_secret(token);
        hello["token"] = json!(token);
    } else {
        hello["bootstrapKey"] = json!(target.bootstrap_key);
    }
    let (mut control, _) = connect_async(target.socket_url(false))
        .await
        .map_err(|_| "agent control connection failed")?;
    send(&mut control, hello).await?;
    let welcome = greeting(&mut control).await?;
    if welcome["t"] == "reject" {
        if welcome["reason"] == "unsupported_protocol" {
            return Ok(None);
        }
        if welcome["reason"] == "reenrollment_required" {
            identity::clear_token(db, &target.hub)?;
        }
        return Err(format!(
            "Hub refused machine identity: {}",
            welcome["reason"].as_str().unwrap_or("invalid_greeting")
        ));
    }
    if welcome["t"] != "welcome" {
        return Err("invalid agent welcome".into());
    }
    let device = welcome["deviceId"]
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        .ok_or("invalid Hub device identity")?;
    let token = if let Some(token) = welcome["token"].as_str() {
        identity::save_token(db, &target.hub, token)?;
        token.to_owned()
    } else {
        credential
            .token
            .ok_or("Hub did not issue a machine credential")?
    };
    let (mut bulk, _) = connect_async(target.socket_url(true))
        .await
        .map_err(|_| "agent bulk connection failed")?;
    send(&mut bulk,json!({"t":"bulk-hello","connectionId":welcome["connectionId"],"machineId":credential.machine_id,"token":token})).await?;
    let acknowledgement = greeting(&mut bulk).await?;
    if acknowledgement["t"] != "bulk-ready"
        || acknowledgement["connectionId"] != welcome["connectionId"]
    {
        return Err("invalid agent bulk acknowledgement".into());
    }
    let mut request = format!("ws://127.0.0.1:{port}/ws?events=0")
        .into_client_request()
        .map_err(|_| "invalid local bridge address")?;
    request
        .headers_mut()
        .insert("x-ccgui-via", "relay".parse().unwrap());
    request.headers_mut().insert(
        "cookie",
        format!("ccgui_device={device}")
            .parse()
            .map_err(|_| "invalid Hub device identity")?,
    );
    let (mut local, _) = connect_async(request)
        .await
        .map_err(|_| "Hub device is not approved by the local bridge")?;
    let local_hello = match local.next().await {
        Some(Ok(Message::Text(raw))) => {
            serde_json::from_str::<Value>(&raw).map_err(|_| "invalid local bridge greeting")?
        }
        _ => return Err("local bridge greeting was interrupted".into()),
    };
    if local_hello["type"] != "hello" || local_hello["version"] != env!("CARGO_PKG_VERSION") {
        return Err("invalid local bridge greeting".into());
    }
    let available = local_hello["capabilities"]
        .as_array()
        .ok_or("invalid local bridge capabilities")?;
    let capabilities = capabilities
        .into_iter()
        .filter(|cap| *cap == "bulk" || available.iter().any(|value| value.as_str() == Some(cap)))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    send(
        &mut control,
        json!({"t":"ready","version":env!("CARGO_PKG_VERSION"),"capabilities":capabilities}),
    )
    .await?;
    Ok(Some(Connection {
        control,
        bulk,
        local,
        heartbeat_ms: welcome["heartbeatMs"]
            .as_u64()
            .ok_or("invalid heartbeat period")?,
    }))
}
