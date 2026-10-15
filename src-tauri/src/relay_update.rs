//! Signed Windows relay releases, applied only after the executor is idle.
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, sync::Arc};
use tauri::{Emitter, Manager};

const FILES: [&str; 3] = ["package.zip", "install-windows.ps1", "install-self-update.ps1"];

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReleaseFile { name: String, url: String, bytes: u64, sha256: String }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release {
    version: String,
    protocol: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min_hub_protocol: Option<u8>,
    files: Vec<ReleaseFile>,
    #[serde(skip_serializing)]
    signature: String,
}

fn version(value: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit())) {
        return Err("invalid update version".into());
    }
    Ok([parts[0].parse().map_err(|_| "invalid version")?, parts[1].parse().map_err(|_| "invalid version")?, parts[2].parse().map_err(|_| "invalid version")?])
}

fn verify_release(release: &Release, public_key: &str, base: &reqwest::Url) -> Result<(), String> {
    let decode = |value: &str| base64::engine::general_purpose::STANDARD.decode(value).map_err(|_| "invalid release signature encoding".to_string());
    let key = decode(public_key.trim())?;
    let signature = decode(&release.signature)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(&serde_json::to_vec(release).map_err(|e| e.to_string())?, &signature)
        .map_err(|_| "release signature did not verify")?;
    version(&release.version)?;
    if release.protocol > 1 || release.min_hub_protocol.unwrap_or(0) > 0 { return Err("update requires a newer Hub protocol".into()); }
    if release.files.len() != FILES.len() { return Err("release is missing installer files".into()); }
    for (file, expected) in release.files.iter().zip(FILES) {
        let url = reqwest::Url::parse(&file.url).map_err(|_| "invalid release URL")?;
        if file.name != expected || file.bytes == 0 || file.sha256.len() != 64 || !file.sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return Err("invalid release file".into());
        }
        if url.origin() != base.origin() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err("release file URL is outside the configured Hub".into());
        }
    }
    Ok(())
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: Option<String>,
    pub phase: String,
    pub error: Option<String>,
    pub failed_version: Option<String>,
    #[serde(default)]
    pub failed_versions: Vec<String>,
    pub deferred_until: u64,
    pub blackout_start: Option<u16>,
    pub blackout_end: Option<u16>,
}

#[derive(Default)]
struct Gate {
    info: UpdateInfo, installing: bool, requests: usize, transfers: usize, token: Option<String>,
    #[cfg(windows)]
    updater: Option<UpdaterProcess>,
}

#[cfg(windows)]
struct UpdaterProcess(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl UpdaterProcess {
    fn finished(&self) -> Result<bool, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT}, System::Threading::WaitForSingleObject};
        match unsafe { WaitForSingleObject(HANDLE(self.0.as_raw_handle()), 0) } {
            WAIT_OBJECT_0 => Ok(true), WAIT_TIMEOUT => Ok(false), _ => Err("could not check independent updater process".into()),
        }
    }
}

#[cfg(windows)]
fn spawn_updater(script: &Path, request: &Path) -> Result<UpdaterProcess, String> {
    use std::os::windows::{process::CommandExt, io::FromRawHandle};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_QUERY_INFORMATION};
    // WMI starts the updater outside the app's scheduled-task process tree;
    // breakaway also excludes the provider's quota job. Stopping the app task
    // must never kill the process responsible for rollback.
    let shell = PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let command_line = format!("\"{}\" -NoProfile -ExecutionPolicy Bypass -File \"{}\" -Request \"{}\"", shell.display(), script.display(), request.display());
    let quoted = command_line.replace('\'', "''");
    let source = format!("$ErrorActionPreference='Stop'; $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{CreateFlags=[uint32]0x09000000;ShowWindow=[uint16]0}}; $result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -OperationTimeoutSec 5 -Arguments @{{CommandLine='{quoted}';ProcessStartupInformation=$startup}}; $result | Select-Object ProcessId,ReturnValue | ConvertTo-Json -Compress");
    let utf16: Vec<u8> = source.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let output = std::process::Command::new(shell).args(["-NoProfile", "-EncodedCommand"])
        .arg(base64::engine::general_purpose::STANDARD.encode(utf16)).env_remove("PSModulePath")
        .creation_flags(0x08000000).stdin(std::process::Stdio::null()).output().map_err(|_| "could not start updater bootstrap")?;
    if !output.status.success() { return Err("independent updater bootstrap failed".into()); }
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| "invalid updater process receipt")?;
    if result["ReturnValue"] != 0 { return Err("Windows refused the independent updater process".into()); }
    let pid = result["ProcessId"].as_u64().filter(|pid| *pid > 0 && *pid <= u32::MAX as u64).ok_or("missing updater process ID")? as u32;
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_INFORMATION, false, pid) }.map_err(|_| "could not retain updater process handle")?;
    Ok(UpdaterProcess(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.0) }))
}

#[derive(Default)]
pub struct UpdateState(Mutex<Gate>);

pub struct Activity { state: Arc<UpdateState>, transfer: bool }
impl Drop for Activity {
    fn drop(&mut self) {
        let mut gate = self.state.0.lock();
        if self.transfer { gate.transfers -= 1; } else { gate.requests -= 1; }
    }
}

impl UpdateState {
    pub fn idle_query(self: &Arc<Self>) -> Option<Activity> {
        let mut gate = self.0.lock();
        if gate.installing { return None; }
        gate.requests += 1;
        Some(Activity { state:self.clone(), transfer:false })
    }
    pub fn activity(self: &Arc<Self>, transfer: bool) -> Result<Activity, String> {
        let mut gate = self.0.lock();
        if gate.installing { return Err("executor update is being checked; try again after reconnecting".into()); }
        if transfer { gate.transfers += 1; } else { gate.requests += 1; }
        Ok(Activity { state: self.clone(), transfer })
    }
    // Called while holding ProcessRegistry. Both send reservation and update
    // acquisition take that lock first, so neither can overtake the other.
    pub fn allow_run(&self) -> Result<(), String> {
        if self.0.lock().installing { Err("executor update is being checked; try again after reconnecting".into()) } else { Ok(()) }
    }
}

fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn state_path() -> PathBuf { crate::paths::app_home().join("updates/state.json") }
fn pending_path() -> PathBuf { crate::paths::app_home().join("updates/pending.json") }

fn persist(info: &UpdateInfo) -> Result<(), String> {
    let path = state_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(info).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn publish(app: &tauri::AppHandle, update: impl FnOnce(&mut UpdateInfo)) {
    let state = app.state::<crate::AppState>();
    let mut gate = state.relay.update.0.lock();
    update(&mut gate.info);
    let _ = app.emit("relay-update://status", &gate.info);
}

pub fn initialize(state: &UpdateState) {
    let mut gate = state.0.lock();
    gate.info = std::fs::read(state_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if let Some(failed) = gate.info.failed_version.clone() { if !gate.info.failed_versions.contains(&failed) { gate.info.failed_versions.push(failed); } }
    let pending = std::fs::read(pending_path()).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    gate.installing = pending.as_ref().is_some_and(|p| p["version"] == env!("CARGO_PKG_VERSION"));
    gate.token = pending.as_ref().and_then(|p| p["token"].as_str().map(str::to_owned));
    if gate.installing { gate.info.phase = "checking".into(); }
    else if !matches!(gate.info.phase.as_str(), "installed" | "failed") { gate.info.phase = "idle".into(); }
}

#[tauri::command]
pub fn relay_update_status(state: tauri::State<'_, crate::AppState>) -> UpdateInfo { state.relay.update.0.lock().info.clone() }

#[tauri::command]
pub fn relay_update_defer(state: tauri::State<'_, crate::AppState>) -> Result<UpdateInfo, String> {
    let mut gate = state.relay.update.0.lock();
    if gate.installing { return Err("installation has already started".into()); }
    let mut info = gate.info.clone();
    info.deferred_until = now() + 3_600_000;
    persist(&info)?;
    gate.info = info.clone();
    Ok(info)
}

#[tauri::command]
pub fn relay_update_blackout(state: tauri::State<'_, crate::AppState>, start: Option<u16>, end: Option<u16>) -> Result<UpdateInfo, String> {
    if start.is_some() != end.is_some() || start.is_some_and(|m| m >= 1440) || end.is_some_and(|m| m >= 1440) { return Err("invalid update blackout time".into()); }
    let mut gate = state.relay.update.0.lock();
    if gate.installing { return Err("installation has already started".into()); }
    let mut info = gate.info.clone();
    info.blackout_start = start;
    info.blackout_end = end;
    persist(&info)?;
    gate.info = info.clone();
    Ok(info)
}

fn blacked_out(info: &UpdateInfo, minute: u16) -> bool {
    match (info.blackout_start, info.blackout_end) {
        (Some(start), Some(end)) if start < end => minute >= start && minute < end,
        (Some(start), Some(end)) if start > end => minute >= start || minute < end,
        _ => false,
    }
}

fn can_install(gate: &Gate, active: bool, idle: u64, minute: u16, timestamp: u64) -> bool {
    !gate.installing && !active && gate.requests == 0 && gate.transfers == 0 && idle >= 600_000 && gate.info.deferred_until <= timestamp && !blacked_out(&gate.info, minute)
}

#[tauri::command]
pub fn relay_update_check(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let connected = crate::relay::web_relay_status(app.clone()).is_some_and(|info| info.connected);
    // Exercise the same persistent workspace store and embedded resources
    // used by the desktop and web bridge before admitting new work.
    let workspaces = crate::history::reader::list_workspaces(app.state())?.len();
    let assets = app.asset_resolver().get("index.html".into()).is_some_and(|asset| {
        let html = String::from_utf8_lossy(&asset.bytes);
        regex::Regex::new(r#"src="([^"]+\.js)""#).unwrap().captures_iter(&html).any(|capture| {
            app.asset_resolver().get(capture[1].trim_start_matches("./").trim_start_matches('/').to_string()).is_some_and(|js| !js.bytes.is_empty())
        })
    });
    let healthy = connected && assets;
    Ok(serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"healthy":healthy,"connected":connected,"frontend":assets,"workspaces":workspaces}))
}

#[tauri::command]
pub fn relay_update_complete(app: tauri::AppHandle, version: String, token: String) -> Result<(), String> {
    if version != env!("CARGO_PKG_VERSION") { return Err("update version differs".into()); }
    if relay_update_check(app.clone())?["healthy"] != true { return Err("update self-check did not pass".into()); }
    let state = app.state::<crate::AppState>();
    let mut gate = state.relay.update.0.lock();
    if gate.token.as_deref() != Some(&token) { return Err("update receipt does not match".into()); }
    let pending: serde_json::Value = serde_json::from_slice(&std::fs::read(pending_path()).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if pending["version"] != version { return Err("pending update differs".into()); }
    let mut info = gate.info.clone();
    info.phase = "installed".into();
    info.error = None;
    persist(&info)?;
    std::fs::remove_file(pending_path()).map_err(|e| e.to_string())?;
    gate.info = info;
    gate.installing = false;
    gate.token = None;
    Ok(())
}

pub fn abort(state: &crate::AppState, token: &str, version: &str) -> Result<(), String> {
    let mut gate = state.relay.update.0.lock();
    if gate.token.as_deref() != Some(token) { return Err("update receipt does not match".into()); }
    let mut info = gate.info.clone();
    info.failed_version = Some(version.into());
    if !info.failed_versions.iter().any(|failed| failed == version) { info.failed_versions.push(version.into()); }
    info.phase = "failed".into();
    info.error = Some("independent update failed; backup retained".into());
    persist(&info)?;
    gate.info = info;
    gate.installing = false;
    gate.token = None;
    Ok(())
}

#[cfg(windows)]
fn idle_and_minute() -> Result<(u64, u16), String> {
    use windows::Win32::{System::SystemInformation::{GetLocalTime, GetTickCount}, UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO}};
    let mut last = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut last).as_bool() { return Err("cannot inspect local input activity".into()); }
        let time = GetLocalTime();
        Ok((GetTickCount().wrapping_sub(last.dwTime) as u64, time.wHour * 60 + time.wMinute))
    }
}

#[cfg(windows)]
async fn download(client: &reqwest::Client, file: &ReleaseFile, directory: &Path, key: &str) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;
    let response = client.get(&file.url).bearer_auth(key).send().await.map_err(|_| "update download failed")?.error_for_status().map_err(|_| "update download was refused")?;
    let path = directory.join(&file.name);
    let mut output = std::fs::OpenOptions::new().create(true).truncate(true).write(true).open(path).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut size = 0u64;
    let mut digest = Sha256::new();
    while let Some(bytes) = stream.next().await {
        let bytes = bytes.map_err(|_| "update download was interrupted")?;
        size += bytes.len() as u64;
        if size > file.bytes { return Err("update file exceeds signed size".into()); }
        digest.update(&bytes);
        output.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    if size != file.bytes || format!("{:x}", digest.finalize()) != file.sha256 { return Err("update file size or checksum differs".into()); }
    output.sync_all().map_err(|e| e.to_string())
}

#[cfg(windows)]
async fn poll(app: &tauri::AppHandle, staged: &mut Option<(Release, PathBuf)>, reported: &mut Option<String>) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    {
        let mut gate = state.relay.update.0.lock();
        if gate.updater.as_ref().map(UpdaterProcess::finished).transpose()? == Some(true) {
            gate.updater = None;
            if gate.installing {
                gate.installing = false;
                gate.token = None;
                gate.info.failed_version = gate.info.version.clone();
                if let Some(failed) = gate.info.version.clone() { if !gate.info.failed_versions.contains(&failed) { gate.info.failed_versions.push(failed); } }
                gate.info.phase = "failed".into();
                gate.info.error = Some("independent updater exited before completion; backup retained".into());
                persist(&gate.info)?;
                let _ = app.emit("relay-update://status", &gate.info);
            }
        }
    }
    let settings = crate::settings::read_settings()?;
    let Some((base_url, key)) = crate::relay::autostart_target(&settings) else { return Ok(()) };
    let base = reqwest::Url::parse(&base_url).map_err(|_| "invalid configured Hub URL")?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(120)).build().map_err(|e| e.to_string())?;
    let endpoint = format!("{}/update", base_url.trim_end_matches('/'));
    let outcome = {
        let gate = state.relay.update.0.lock();
        match gate.info.phase.as_str() {
            "installed" | "failed" => gate.info.version.as_ref().map(|version| serde_json::json!({"version":version,"status":gate.info.phase,"step":"executor-receipt"})),
            _ => None,
        }
    };
    if let Some(outcome) = outcome {
        let receipt = outcome.to_string();
        if reported.as_ref() != Some(&receipt) && client.post(format!("{endpoint}/result")).bearer_auth(&key).json(&outcome).send().await.is_ok_and(|r| r.status().is_success()) { *reported = Some(receipt); }
    }
    let response = client.get(&endpoint).bearer_auth(&key).send().await.map_err(|_| "update manifest request failed")?;
    if response.status() == reqwest::StatusCode::NO_CONTENT || response.status() == reqwest::StatusCode::NOT_FOUND { return Ok(()) }
    use futures_util::StreamExt;
    let mut body = response.error_for_status().map_err(|_| "Hub refused update manifest")?.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| "update manifest interrupted")?;
        if bytes.len() + chunk.len() > 65536 { return Err("update manifest is too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let release: Release = serde_json::from_slice(&bytes).map_err(|_| "invalid update manifest")?;
    verify_release(&release, include_str!("../resources/relay-update-public-key.txt"), &base)?;
    {
        let gate = state.relay.update.0.lock();
        if version(&release.version)? <= version(env!("CARGO_PKG_VERSION"))? || gate.info.failed_versions.contains(&release.version) || gate.installing { return Ok(()) }
    }
    if staged.as_ref().is_none_or(|(old, _)| old.version != release.version || old.signature != release.signature) {
        publish(app, |info| { info.version = Some(release.version.clone()); info.phase = "downloading".into(); info.error = None; });
        let directory = crate::paths::app_home().join("updates").join(uuid::Uuid::new_v4().to_string()).join("staged");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        *staged = Some((release.clone(), directory));
    }
    if state.relay.update.0.lock().info.phase != "waiting-idle" {
        let (_, directory) = staged.as_ref().unwrap();
        for file in &release.files { download(&client, file, &directory, &key).await?; }
        std::fs::write(directory.join("manifest.json"), serde_json::to_vec(&serde_json::json!({"version": release.version, "files":release.files})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        publish(app, |info| info.phase = "waiting-idle".into());
    }
    let (idle, minute) = idle_and_minute()?;
    let registry = state.processes.0.lock().map_err(|e| e.to_string())?;
    let mut gate = state.relay.update.0.lock();
    if !can_install(&gate, !registry.is_empty(), idle, minute, now()) { return Ok(()) }
    let (_, directory) = staged.as_ref().unwrap();
    let installed = std::env::current_exe().map_err(|e| e.to_string())?;
    let request = directory.join("auto-request.json");
    let id = uuid::Uuid::new_v4().simple().to_string();
    let token = uuid::Uuid::new_v4().to_string();
    std::fs::write(&request, serde_json::to_vec(&serde_json::json!({"installed":installed,"appHome":crate::paths::app_home(),"version":release.version,"id":id,"token":token})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut info = gate.info.clone();
    info.phase = "installing".into();
    persist(&info)?;
    gate.installing = true;
    gate.token = Some(token);
    gate.info = info;
    let child = spawn_updater(&directory.join("install-self-update.ps1"), &request);
    match child {
        Ok(child) => {
            gate.updater = Some(child);
            let acknowledged = std::fs::write(directory.join("launch-ok.json"), serde_json::to_vec(&serde_json::json!({"token":gate.token})).map_err(|e| e.to_string())?).map_err(|e| e.to_string());
            if let Err(error) = acknowledged { gate.installing = false; gate.token = None; gate.info.phase = "failed".into(); gate.info.failed_version = gate.info.version.clone(); if !gate.info.failed_versions.contains(&release.version) { gate.info.failed_versions.push(release.version); } persist(&gate.info)?; return Err(error); }
        },
        Err(_) => { gate.installing = false; gate.token = None; gate.info.phase = "failed".into(); gate.info.failed_version = gate.info.version.clone(); if !gate.info.failed_versions.contains(&release.version) { gate.info.failed_versions.push(release.version); } persist(&gate.info)?; return Err("could not start independent updater".into()); }
    }
    let _ = app.emit("relay-update://status", &gate.info);
    Ok(())
}

pub fn start(app: tauri::AppHandle) {
    #[cfg(windows)]
    tauri::async_runtime::spawn(async move {
        let mut staged = None;
        let mut reported = None;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Err(error) = poll(&app, &mut staged, &mut reported).await { publish(&app, |info| info.error = Some(error)); }
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_the_shared_node_signed_manifest() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/relay-release.json")).unwrap();
        let release: Release = serde_json::from_value(fixture["manifest"].clone()).unwrap();
        verify_release(&release, fixture["publicKey"].as_str().unwrap(), &reqwest::Url::parse("http://hub.example/m/PC6").unwrap()).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn independent_updater_survives_bootstrap_exit_and_accepts_quoted_paths() {
        let root = std::env::temp_dir().join(format!("ccgui-更新器's {}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let script = root.join("helper.ps1");
        let marker = root.join("marker.txt");
        let mut source = vec![0xef,0xbb,0xbf];
        source.extend_from_slice("param($Request)\n[IO.File]::WriteAllText($Request, '独立🙂', [Text.UTF8Encoding]::new($false)); Start-Sleep -Seconds 1\n".as_bytes());
        std::fs::write(&script,source).unwrap();
        let process = spawn_updater(&script,&marker).unwrap();
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, System::JobObjects::IsProcessInJob};
        let mut in_job = windows::core::BOOL::default();
        unsafe { IsProcessInJob(HANDLE(process.0.as_raw_handle()), None, &mut in_job) }.unwrap();
        assert!(!in_job.as_bool(), "updater still belongs to a job that can terminate it");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !process.finished().unwrap() && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(20)); }
        assert!(process.finished().unwrap());
        assert_eq!(std::fs::read_to_string(marker).unwrap(),"独立🙂");
        drop(process);
        let absolute = dunce::canonicalize(&root).unwrap();
        assert!(absolute.starts_with(dunce::canonicalize(std::env::temp_dir()).unwrap()));
        std::fs::remove_dir_all(absolute).unwrap();
    }
    #[test]
    fn signature_binds_every_file_and_url() {
        use ring::signature::KeyPair;
        let key = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let base = reqwest::Url::parse("http://hub.example/m/PC6").unwrap();
        let mut release = Release { version:"1.2.1".into(), protocol:0, min_hub_protocol:None, signature:String::new(),
            files: FILES.iter().map(|name| ReleaseFile { name: name.to_string(), url: format!("http://hub.example/releases/windows/{name}"), bytes:3, sha256:"a".repeat(64) }).collect() };
        let public = base64::engine::general_purpose::STANDARD.encode(key.public_key().as_ref());
        release.signature = base64::engine::general_purpose::STANDARD.encode(key.sign(&serde_json::to_vec(&release).unwrap()).as_ref());
        verify_release(&release, &public, &base).unwrap();
        release.files[0].bytes += 1;
        assert!(verify_release(&release, &public, &base).is_err());
        release.files[0].bytes -= 1;
        release.files[0].url = "http://elsewhere.example/package.zip".into();
        release.signature = base64::engine::general_purpose::STANDARD.encode(key.sign(&serde_json::to_vec(&release).unwrap()).as_ref());
        assert!(verify_release(&release, &public, &base).is_err());
    }
    #[test]
    fn activities_and_blackout_boundaries_prevent_updates() {
        let state = Arc::new(UpdateState::default());
        let query = state.idle_query().unwrap();
        assert_eq!(state.0.lock().requests,1);
        drop(query);
        let request = state.activity(false).unwrap();
        let transfer = state.activity(true).unwrap();
        { let gate = state.0.lock(); assert_eq!((gate.requests, gate.transfers), (1,1)); }
        drop(request); drop(transfer);
        { let gate = state.0.lock(); assert_eq!((gate.requests, gate.transfers), (0,0)); }
        state.0.lock().installing = true;
        assert!(state.idle_query().is_none());
        assert!(state.allow_run().is_err());
        assert!(state.activity(false).is_err());
        let info = UpdateInfo { blackout_start:Some(1380), blackout_end:Some(360), ..UpdateInfo::default() };
        assert!(blacked_out(&info, 1400)); assert!(blacked_out(&info, 300)); assert!(!blacked_out(&info, 360));
    }
    #[test]
    fn every_idle_condition_is_required() {
        let mut gate = Gate::default();
        assert!(can_install(&gate, false, 600_000, 600, 100));
        assert!(!can_install(&gate, true, 600_000, 600, 100));
        assert!(!can_install(&gate, false, 599_999, 600, 100));
        gate.requests = 1; assert!(!can_install(&gate, false, 600_000, 600, 100)); gate.requests = 0;
        gate.transfers = 1; assert!(!can_install(&gate, false, 600_000, 600, 100)); gate.transfers = 0;
        gate.info.deferred_until = 101; assert!(!can_install(&gate, false, 600_000, 600, 100)); gate.info.deferred_until = 0;
        gate.info.blackout_start = Some(500); gate.info.blackout_end = Some(700);
        assert!(!can_install(&gate, false, 600_000, 600, 100));
        assert!(can_install(&gate, false, 600_000, 700, 100));
    }
}
