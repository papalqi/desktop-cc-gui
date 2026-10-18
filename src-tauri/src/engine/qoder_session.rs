//! Qoder ACP turn driver: one send = one `qodercli --acp` child speaking
//! JSON-RPC over stdio, settled like [`super::dsh_session::run_host_turn`].
//!
//! Wire (reference-verified against qodercli 1.1.28):
//! - Handshake: initialize → session/new | session/resume (req.session_id)
//!   → session/set_model? → session/set_config_option (reasoning_effort)?
//!   → session/set_mode bypassPermissions → session/prompt.
//! - The turn streams as session/update notifications and settles on the
//!   typed prompt response — which qodercli slips BETWEEN notifications
//!   (first user chunk → result → thought/tool/final text), so after the
//!   response lands the reader keeps draining until idle (trailing drain),
//!   or the turn loses its tail.
//! - Interrupt writes session/cancel; the CLI usually answers with a typed
//!   cancelled response within ~2s, then the child is killed.
//! - Agent-initiated requests are answered by this client: permission
//!   requests auto-allow (headless, bypassPermissions mode), fs/* is served
//!   confined to the workspace root.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdout, Command};
use tokio::time::{timeout, Instant};

/// 提取并规范化上下文窗口字段
fn attach_context_window(mut usage: Value) -> Value {
    if usage.get("model_context_window").is_some() {
        return usage;
    }

    let window = usage
        .get("context_window")
        .or_else(|| usage.get("contextWindow"))
        .or_else(|| usage.get("model_context_window"))
        .and_then(|v| match v {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        })
        .filter(|&w| w > 0);

    if let Some(w) = window {
        if let Some(obj) = usage.as_object_mut() {
            obj.insert("model_context_window".to_string(), Value::Number(w.into()));
        }
    }

    usage
}

use super::{EngineEvent, HostTurnGuard, SendRequest, TurnCore, TurnState};

const ACP_PROTOCOL_VERSION: u32 = 1;
pub(crate) const RPC_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// session/new scans the workspace on first contact (measured 30s+ in a
/// large repo), so the setup call needs far more headroom than a plain RPC.
pub(crate) const SESSION_NEW_TIMEOUT: Duration = Duration::from_secs(90);
/// session/resume re-attaches without the workspace scan.
pub(crate) const SESSION_RESUME_TIMEOUT: Duration = Duration::from_secs(30);
/// Idle budget for a prompt, renewed by session activity. Codex shares this
/// constant; the ACP pump also has a generous overall lifetime bound.
pub(crate) const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 30);
const PROMPT_HARD_CAP: Duration = Duration::from_secs(60 * 60 * 8);
/// qodercli interleaves the prompt response into the session/update stream:
/// keep reading after it until the stream goes idle, else the tail is lost.
const PROMPT_TRAILING_IDLE: Duration = Duration::from_millis(400);
const PROMPT_TRAILING_CAP: Duration = Duration::from_secs(2);
/// Grace for the typed cancelled response after session/cancel before the
/// child is killed anyway.
const CANCEL_SETTLE_TIMEOUT: Duration = Duration::from_secs(2);
/// Killed-flag poll cadence inside the read loop.
pub(crate) const KILL_POLL: Duration = Duration::from_millis(150);
const POST_TERMINAL_DRAIN: Duration = Duration::from_millis(250);
/// Catalog probe budget: session/new in the temp dir skips the workspace
/// scan, so the whole handshake fits in seconds.
const MODEL_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const MODEL_PROBE_TOTAL: Duration = Duration::from_secs(20);

#[derive(Clone, Copy)]
struct PumpLimits {
    prompt_hard_cap: Duration,
    trailing_idle: Duration,
    trailing_cap: Duration,
    cancel_settle: Duration,
    kill_poll: Duration,
}

impl Default for PumpLimits {
    fn default() -> Self {
        Self {
            prompt_hard_cap: PROMPT_HARD_CAP,
            trailing_idle: PROMPT_TRAILING_IDLE,
            trailing_cap: PROMPT_TRAILING_CAP,
            cancel_settle: CANCEL_SETTLE_TIMEOUT,
            kill_poll: KILL_POLL,
        }
    }
}

pub(crate) const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;
pub(crate) const JSONRPC_INVALID_PARAMS: i64 = -32602;
pub(crate) const JSONRPC_INTERNAL_ERROR: i64 = -32603;
/// Terminal marker for a kill-interrupted request; the driver swallows it
/// via the killed flag (interrupted runs settle as normal turn ends).
pub(crate) const CANCELLED: &str = "qoder turn cancelled";

// ==================== ACP framing ====================

/// Routes the lines of one in-flight request that are not its response:
/// `session/update` notifications and agent-initiated requests. Returning
/// `Some` writes that frame back to the CLI; `None` means the driver has
/// taken the line over — a question parked for the user must stay
/// unanswered until the answer command posts its response.
pub(crate) type LineRouter<'a> = dyn FnMut(&AcpLine) -> Option<Value> + Send + 'a;

#[derive(Debug)]
pub(crate) enum AcpLine {
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<AcpRpcError>,
    },
    Notification {
        method: String,
        params: Value,
    },
    AgentRequest {
        id: Value,
        method: String,
        params: Value,
    },
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AcpRpcError {
    pub code: i64,
    pub message: String,
}

pub(crate) fn jsonrpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

pub(crate) fn parse_acp_line(value: &Value) -> AcpLine {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        && value.get("method").is_none()
        && value.get("id").is_none()
    {
        return AcpLine::Other;
    }
    let method = value.get("method").and_then(Value::as_str);
    let id = value.get("id").cloned().filter(|id| !id.is_null());
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    if let Some(method) = method {
        if let Some(id) = id {
            return AcpLine::AgentRequest {
                id,
                method: method.to_string(),
                params,
            };
        }
        return AcpLine::Notification {
            method: method.to_string(),
            params,
        };
    }
    if let Some(id) = id {
        let error = value.get("error").map(|err| {
            let code = err
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or(JSONRPC_INTERNAL_ERROR);
            let mut message = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("JSON-RPC error")
                .to_string();
            if let Some(detail) = err
                .get("data")
                .and_then(|data| data.get("details").or_else(|| data.get("message")))
                .and_then(Value::as_str)
                .and_then(|detail| detail.lines().next())
                .map(str::trim)
                .filter(|detail| !detail.is_empty() && !message.contains(detail))
            {
                message.push_str(": ");
                message.extend(detail.chars().take(512));
            }
            let message = super::reader::redact_secrets(&message);
            AcpRpcError { code, message }
        });
        return AcpLine::Response {
            id,
            result: value.get("result").cloned(),
            error,
        };
    }
    AcpLine::Other
}

pub(crate) fn jsonrpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

pub(crate) fn jsonrpc_notification(method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    })
}

pub(crate) fn jsonrpc_error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

pub(crate) fn jsonrpc_result_response(id: &Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

pub(crate) fn encode_ndjson(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

// ==================== session/update mapping ====================

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum QoderSessionUpdate {
    AgentMessageChunk {
        text: String,
    },
    AgentThoughtChunk {
        text: String,
    },
    ToolStarted {
        tool_id: String,
        tool_name: String,
        input: Option<Value>,
    },
    ToolCompleted {
        tool_id: String,
        tool_name: Option<String>,
        output: Option<Value>,
        error: Option<String>,
    },
    Ignore,
}

pub(crate) fn extract_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(text) = content.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(thinking) = content.get("thinking").and_then(Value::as_str) {
        return thinking.to_string();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_string)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_string))
                    .or_else(|| {
                        part.get("thinking")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .or_else(|| {
                        let nested = extract_content_text(part.get("content"));
                        if nested.is_empty() {
                            None
                        } else {
                            Some(nested)
                        }
                    })
            })
            .collect::<Vec<_>>()
            .join("");
    }
    String::new()
}

fn extract_tool_call_id(update: &Value) -> Option<String> {
    update
        .get("toolCallId")
        .or_else(|| update.get("toolCallID"))
        .or_else(|| update.get("tool_call_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_tool_name(update: &Value) -> Option<String> {
    update
        .get("_meta")
        .and_then(|meta| meta.get("qoder"))
        .and_then(|qoder| qoder.get("toolName"))
        .and_then(Value::as_str)
        .or_else(|| update.get("title").and_then(Value::as_str))
        .or_else(|| update.get("kind").and_then(Value::as_str))
        .or_else(|| update.get("name").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_tool_content_text(update: &Value) -> String {
    let from_blocks = extract_content_text(update.get("content"));
    if !from_blocks.trim().is_empty() {
        return from_blocks;
    }
    let from_raw = extract_content_text(update.get("rawOutput"));
    if !from_raw.trim().is_empty() {
        return from_raw;
    }
    extract_content_text(update.get("output"))
}

/// qodercli prefixes model-level failures it could not map to an RPC error
/// ("[Error] Network attempt failed") into the text stream; the driver
/// holds such chunks back and joins them into the terminal error message
/// instead of rendering them as assistant text.
pub(crate) fn is_error_prefixed_text(text: &str) -> bool {
    text.trim_start().starts_with("[Error]")
}

pub(crate) fn map_session_update(update: &Value) -> QoderSessionUpdate {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        "agent_message_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                QoderSessionUpdate::Ignore
            } else {
                QoderSessionUpdate::AgentMessageChunk { text }
            }
        }
        "agent_thought_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                QoderSessionUpdate::Ignore
            } else {
                QoderSessionUpdate::AgentThoughtChunk { text }
            }
        }
        "tool_call" => {
            let status = update
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            let Some(tool_id) = extract_tool_call_id(update) else {
                return QoderSessionUpdate::Ignore;
            };
            let tool_name = extract_tool_name(update).unwrap_or_else(|| "tool".to_string());
            let input = update
                .get("rawInput")
                .cloned()
                .or_else(|| update.get("input").cloned());
            // Replay compresses a tool into one status=completed tool_call
            // snapshot; accepting only pending would drop the block whole.
            if status == "completed" || status == "failed" {
                let output = update
                    .get("rawOutput")
                    .cloned()
                    .or_else(|| update.get("output").cloned())
                    .or_else(|| update.get("content").cloned());
                let error = (status == "failed")
                    .then(|| extract_tool_content_text(update).trim().to_string())
                    .filter(|value| !value.is_empty());
                return QoderSessionUpdate::ToolCompleted {
                    tool_id,
                    tool_name: Some(tool_name),
                    output,
                    error,
                };
            }
            if status != "pending" && status != "in_progress" {
                return QoderSessionUpdate::Ignore;
            }
            QoderSessionUpdate::ToolStarted {
                tool_id,
                tool_name,
                input,
            }
        }
        "tool_call_update" => {
            let status = update.get("status").and_then(Value::as_str).unwrap_or("");
            if status != "completed" && status != "failed" {
                return QoderSessionUpdate::Ignore;
            }
            let Some(tool_id) = extract_tool_call_id(update) else {
                return QoderSessionUpdate::Ignore;
            };
            let output = update
                .get("rawOutput")
                .cloned()
                .or_else(|| update.get("output").cloned())
                .or_else(|| update.get("content").cloned());
            let error = (status == "failed")
                .then(|| extract_tool_content_text(update).trim().to_string())
                .filter(|value| !value.is_empty());
            QoderSessionUpdate::ToolCompleted {
                tool_id,
                tool_name: extract_tool_name(update),
                output,
                error,
            }
        }
        // plan / available_commands_update / config_option_update /
        // user_message_chunk: UI noise here.
        _ => QoderSessionUpdate::Ignore,
    }
}

pub(crate) fn session_update_from_notification(params: &Value) -> QoderSessionUpdate {
    let update = params.get("update").unwrap_or(params);
    map_session_update(update)
}

// ==================== agent-initiated requests ====================

/// Headless permission policy: pick the first allow* option (bypassPermissions
/// mode means the CLI should not ask; when it still does, blocking forever
/// is worse than allowing).
pub(crate) fn permission_auto_answer(params: &Value) -> Result<Value, String> {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "session/request_permission missing options".to_string())?;
    let option = options.iter().find(|option| {
        option
            .get("kind")
            .and_then(Value::as_str)
            .map(|kind| kind.to_ascii_lowercase().starts_with("allow"))
            .unwrap_or(false)
    });
    let option_id = option
        .and_then(|option| {
            option
                .get("optionId")
                .or_else(|| option.get("option_id"))
                .or_else(|| option.get("id"))
                .and_then(Value::as_str)
        })
        .ok_or_else(|| "session/request_permission has no allow* option".to_string())?;
    Ok(json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id,
        }
    }))
}

/// Confine an agent-requested path to the workspace root; the fs capability
/// this client advertises must never read or write outside it.
pub(crate) fn confine_path_to_workspace(
    workspace_root: &Path,
    requested: &str,
    for_write: bool,
) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("empty path".to_string());
    }
    let candidate = PathBuf::from(requested);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    };
    let root = std::fs::canonicalize(workspace_root).unwrap_or_else(|_| {
        if workspace_root.is_absolute() {
            workspace_root.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(workspace_root)
        }
    });
    let resolved = if for_write && !absolute.exists() {
        // Canonicalize the nearest EXISTING ancestor, then re-append the
        // remainder: the immediate parent may not exist yet either, and a
        // raw join compares a symlinked ancestor (macOS /var → /private/var)
        // against the canonical root and falsely rejects in-workspace writes.
        let mut ancestor = absolute.as_path();
        let mut remainder = Vec::new();
        loop {
            let Some(parent) = ancestor.parent() else {
                break absolute.clone();
            };
            remainder.push(
                ancestor
                    .file_name()
                    .ok_or_else(|| "invalid path".to_string())?,
            );
            if parent.exists() {
                let mut resolved =
                    std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
                for component in remainder.iter().rev() {
                    resolved.push(component);
                }
                break resolved;
            }
            ancestor = parent;
        }
    } else {
        std::fs::canonicalize(&absolute).unwrap_or(absolute.clone())
    };
    if resolved == root || resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(format!(
            "path '{}' escapes workspace root '{}'",
            requested,
            root.display()
        ))
    }
}

pub(crate) fn handle_fs_read(workspace_root: &Path, params: &Value) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "fs/read_text_file missing path".to_string())?;
    let confined = confine_path_to_workspace(workspace_root, path, false)?;
    let content = std::fs::read_to_string(&confined).map_err(|error| error.to_string())?;
    Ok(json!({ "content": content }))
}

pub(crate) fn handle_fs_write(workspace_root: &Path, params: &Value) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "fs/write_text_file missing path".to_string())?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "fs/write_text_file missing content".to_string())?;
    let confined = confine_path_to_workspace(workspace_root, path, true)?;
    if let Some(parent) = confined.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&confined, content).map_err(|error| error.to_string())?;
    Ok(json!({}))
}

pub(crate) fn answer_agent_request(
    workspace_root: &Path,
    id: &Value,
    method: &str,
    params: &Value,
) -> Value {
    match method {
        "session/request_permission" => match permission_auto_answer(params) {
            Ok(result) => jsonrpc_result_response(id, result),
            Err(message) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &message),
        },
        "fs/read_text_file" => match handle_fs_read(workspace_root, params) {
            Ok(result) => jsonrpc_result_response(id, result),
            Err(message) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &message),
        },
        "fs/write_text_file" => match handle_fs_write(workspace_root, params) {
            Ok(result) => jsonrpc_result_response(id, result),
            Err(message) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &message),
        },
        _ => jsonrpc_error_response(id, JSONRPC_METHOD_NOT_FOUND, "Method not found"),
    }
}

pub(crate) fn initialize_params() -> Value {
    json!({
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "clientInfo": {
            "name": "ccgui",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "clientCapabilities": {
            "fs": {
                "readTextFile": true,
                "writeTextFile": true,
            }
        }
    })
}

fn extract_session_id(value: &Value) -> Option<String> {
    value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn session_setting_error(setting: &str, value: &str, error: String) -> String {
    format!("Qoder {setting} `{value}` setup failed: {error}")
}

fn parse_rpc_error_message(message: &str) -> String {
    if let Some(rest) = message.strip_prefix("rpc:") {
        if let Some((_, text)) = rest.split_once(':') {
            return text.to_string();
        }
    }
    message.to_string()
}

/// ACP prompt content blocks: text plus base64 image blocks (the qoder
/// image transport — supports_images is true because this exists).
fn assemble_prompt_blocks(
    text: &str,
    images: &[String],
    workspace: &Path,
) -> Result<Vec<Value>, String> {
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for raw in images {
        let (mime, base64) = super::images::load_image(raw, workspace)?;
        blocks.push(json!({
            "type": "image",
            "data": base64,
            "mimeType": mime,
        }));
    }
    Ok(blocks)
}

// ==================== ACP process ====================

pub(crate) struct AcpProcess {
    /// Shared with the registry: a parked question is answered by enqueueing
    /// on this same writer. The read loop never waits on the pipe.
    pub(crate) stdin: super::stdio_duplex::StdioWriter,
    run_id: String,
    reader: BufReader<ChildStdout>,
    /// Partial-line bytes survive a cancelled read (KILL_POLL ticks land
    /// mid-line); read_line_capped only ever appends to it.
    line_buf: Vec<u8>,
    next_id: u64,
    workspace_root: PathBuf,
    limits: PumpLimits,
}

fn acp_timeout_message(
    run_id: &str,
    method: &str,
    cancel_sent: bool,
    hard_deadline: Option<Instant>,
) -> String {
    let reason = if cancel_sent {
        "interrupt"
    } else if hard_deadline.is_some_and(|hard| Instant::now() >= hard) {
        "hard-cap"
    } else {
        "idle-timeout"
    };
    eprintln!("[acp] deadline run={run_id} method={method} reason={reason}");
    if cancel_sent {
        CANCELLED.to_string()
    } else {
        format!("{method} timed out")
    }
}

impl AcpProcess {
    pub(crate) fn new(
        stdin: super::stdio_duplex::StdioWriter,
        stdout: ChildStdout,
        workspace_root: PathBuf,
        run_id: &str,
    ) -> Self {
        Self {
            stdin,
            run_id: run_id.to_string(),
            reader: BufReader::new(stdout),
            line_buf: Vec::new(),
            next_id: 1,
            workspace_root,
            limits: PumpLimits::default(),
        }
    }

    /// Point logs and the shared writer at the registry run id. Spawn only
    /// knows the binary label.
    pub(crate) fn bind_run(&mut self, run_id: &str) {
        self.run_id = run_id.to_string();
        self.stdin.set_run_id(run_id);
    }

    pub(crate) fn write_line(&mut self, value: &Value) -> Result<(), String> {
        if self.stdin.is_closed() {
            return Err("the ACP session's stdin is already closed".to_string());
        }
        let bytes = encode_ndjson(value)?;
        self.stdin.enqueue_frame(bytes)?;
        if let Some(error) = self.stdin.fatal() {
            return Err(error);
        }
        Ok(())
    }

    /// One JSON-RPC request → its result, with agent-initiated requests
    /// settled inline (the ACP permission and fs surface): the qoder CLI
    /// never asks the user anything this client has to park.
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout_dur: Duration,
        killed: &AtomicBool,
        cancel_session_id: Option<&str>,
        on_update: &mut (dyn FnMut(&Value) + Send),
    ) -> Result<Value, String> {
        let workspace = self.workspace_root.clone();
        let mut router = |line: &AcpLine| match line {
            AcpLine::Notification { method, params } if method == "session/update" => {
                on_update(params);
                None
            }
            AcpLine::AgentRequest { id, method, params } => {
                Some(answer_agent_request(&workspace, id, method, params))
            }
            _ => None,
        };
        self.routed(
            method,
            params,
            timeout_dur,
            killed,
            cancel_session_id,
            &mut router,
        )
        .await
    }

    /// The read loop behind [`AcpProcess::request`]: session/update
    /// notifications stream through `router`, which answers an agent request
    /// by returning the frame to write — or returns `None` when the driver
    /// answers it out of band (a question parked for the user).
    ///
    /// A prompt's timeout is an idle budget renewed by session notifications
    /// and agent requests, with an overall hard cap. Other RPCs keep a fixed
    /// deadline. The read wait uses short kill-poll slices so an interrupt
    /// lands even mid-handshake: with a `cancel_session_id` (prompt phase) the
    /// loop first sends session/cancel and grants the CLI a fixed settle
    /// window to answer typed; without one the call aborts immediately.
    pub(crate) async fn routed(
        &mut self,
        method: &str,
        params: Value,
        timeout_dur: Duration,
        killed: &AtomicBool,
        cancel_session_id: Option<&str>,
        router: &mut LineRouter<'_>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let expected_key = id.to_string();
        self.write_line(&jsonrpc_request(id, method, params))?;
        let limits = self.limits;
        let is_prompt = method == "session/prompt";
        let started_at = Instant::now();
        let idle_timeout = is_prompt.then_some(timeout_dur);
        let prompt_hard_deadline = is_prompt.then(|| started_at + limits.prompt_hard_cap);
        let mut deadline = started_at + timeout_dur;
        if let Some(hard_deadline) = prompt_hard_deadline {
            deadline = deadline.min(hard_deadline);
        }
        let mut settled: Option<Value> = None;
        let mut drain_deadline: Option<Instant> = None;
        let mut cancel_sent_at: Option<Instant> = None;
        loop {
            if killed.load(Ordering::SeqCst) {
                match (cancel_sent_at, cancel_session_id) {
                    (None, Some(session_id)) => {
                        eprintln!(
                            "[acp] settle run={} reason=interrupt method={method}",
                            self.run_id
                        );
                        let _ = self.notify("session/cancel", json!({ "sessionId": session_id }));
                        let sent_at = Instant::now();
                        cancel_sent_at = Some(sent_at);
                        deadline = deadline.min(sent_at + limits.cancel_settle);
                    }
                    (None, None) => {
                        eprintln!(
                            "[acp] deadline run={} method={method} reason=interrupt",
                            self.run_id
                        );
                        return Err(CANCELLED.to_string());
                    }
                    (Some(sent), _) if sent.elapsed() > limits.cancel_settle => {
                        eprintln!(
                            "[acp] deadline run={} method={method} reason=interrupt",
                            self.run_id
                        );
                        return Err(CANCELLED.to_string());
                    }
                    (Some(_), _) => {}
                }
            }
            if let Some(error) = self.stdin.fatal() {
                eprintln!(
                    "[acp] stdio fatal run={} method={method} reason={error}",
                    self.run_id
                );
                return Err(error);
            }
            let wait = if settled.is_some() {
                let cap_remaining = drain_deadline
                    .map(|until| until.saturating_duration_since(Instant::now()))
                    .unwrap_or(limits.trailing_idle);
                if cap_remaining.is_zero() {
                    return Ok(settled.take().unwrap_or(Value::Null));
                }
                limits.trailing_idle.min(cap_remaining)
            } else {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(acp_timeout_message(
                        &self.run_id,
                        method,
                        cancel_sent_at.is_some(),
                        prompt_hard_deadline,
                    ));
                }
                remaining.min(limits.kill_poll)
            };

            let read = timeout(
                wait,
                super::read_line_capped(&mut self.reader, &mut self.line_buf),
            )
            .await;
            let bytes = match read {
                Ok(Ok(super::LineRead::Line(bytes))) => bytes,
                Ok(Ok(super::LineRead::Eof)) => {
                    eprintln!("[acp] stdout eof run={} method={method}", self.run_id);
                    return match settled.take() {
                        Some(result) => Ok(result),
                        None => Err(format!("{method} ended: ACP stdout closed")),
                    };
                }
                Ok(Ok(super::LineRead::TooLong)) => {
                    return Err(format!(
                        "{method} emitted a line over {} MiB without a newline; run terminated",
                        super::MAX_LINE_BYTES / (1024 * 1024),
                    ));
                }
                Ok(Err(error)) => {
                    eprintln!(
                        "[acp] stdout error run={} method={method} reason={error}",
                        self.run_id
                    );
                    return match settled.take() {
                        Some(result) => Ok(result),
                        None => Err(format!("{method} stdout error: {error}")),
                    };
                }
                Err(_) => {
                    if let Some(result) = settled.take() {
                        return Ok(result);
                    }
                    // An idle read tick: re-check the deadline and the
                    // killed flag on the next loop pass.
                    if deadline.saturating_duration_since(Instant::now()).is_zero() {
                        return Err(acp_timeout_message(
                            &self.run_id,
                            method,
                            cancel_sent_at.is_some(),
                            prompt_hard_deadline,
                        ));
                    }
                    continue;
                }
            };
            let text = String::from_utf8_lossy(&bytes);
            let line = text.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let parsed = parse_acp_line(&value);
            let session_activity = matches!(
                &parsed,
                AcpLine::Notification { .. } | AcpLine::AgentRequest { .. }
            );
            match parsed {
                AcpLine::Response {
                    id: response_id,
                    result,
                    error,
                } => {
                    if jsonrpc_id_key(&response_id).as_deref() != Some(expected_key.as_str()) {
                        continue;
                    }
                    if let Some(error) = error {
                        return Err(format!("rpc:{}:{method}: {}", error.code, error.message));
                    }
                    let result = result.unwrap_or(Value::Null);
                    if !is_prompt {
                        return Ok(result);
                    }
                    settled = Some(result);
                    drain_deadline = Some(Instant::now() + limits.trailing_cap);
                }
                other => {
                    if session_activity && settled.is_none() && cancel_sent_at.is_none() {
                        if let (Some(idle_timeout), Some(hard_deadline)) =
                            (idle_timeout, prompt_hard_deadline)
                        {
                            deadline = (Instant::now() + idle_timeout).min(hard_deadline);
                        }
                    }
                    if let Some(response) = router(&other) {
                        self.write_line(&response)?;
                    }
                }
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&jsonrpc_notification(method, params))
    }
}

pub(crate) struct SpawnedAcp {
    pub(crate) child: Child,
    pub(crate) acp: AcpProcess,
    pub(crate) stderr_buf: Arc<Mutex<String>>,
    /// Kill-on-close job guard (Windows): drops after teardown, sweeping any
    /// grandchild the CLI orphaned before `taskkill /T` could see a tree.
    #[cfg(windows)]
    pub(crate) _tree_guard: Option<Arc<super::job::KillOnCloseJob>>,
}

/// Spawn a prepared ACP command as this driver's own child: piped stdio, own
/// process group (so teardown sweeps the tree), and a drop backstop — a
/// dropped driver future must never orphan the CLI.
pub(crate) fn spawn_piped_acp(
    command: &mut Command,
    label: &str,
    workspace: &Path,
) -> Result<SpawnedAcp, String> {
    command
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    super::hide_console(command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn {label}: {error}"))?;
    #[cfg(windows)]
    let tree_guard = super::job::assign_kill_on_close(&child);
    let (stdin, stdout, stderr) =
        match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                let _ = child.start_kill();
                return Err("missing stdio pipe after spawn".to_string());
            }
        };
    Ok(SpawnedAcp {
        child,
        acp: AcpProcess::new(
            super::stdio_duplex::StdioWriter::spawn(stdin, label),
            stdout,
            workspace.to_path_buf(),
            label,
        ),
        stderr_buf: super::spawn_stderr_capture(stderr),
        #[cfg(windows)]
        _tree_guard: tree_guard,
    })
}

async fn spawn_acp(bin: &str, workspace: &Path) -> Result<SpawnedAcp, String> {
    let mut command = super::command_for_binary(bin);
    command.arg("--acp");
    spawn_piped_acp(&mut command, bin, workspace)
}

/// The CLI stays resident after the response (ACP is a session protocol);
/// every exit path tears the tree down so no run orphans a qodercli.
pub(crate) async fn teardown(child: &mut Child) {
    if let Some(pid) = child.id() {
        super::kill_process_group(pid);
    }
    let _ = child.kill().await;
    let _ = timeout(POST_TERMINAL_DRAIN, child.wait()).await;
}

/// End a turn's stdin, then kill. `close` is queued behind frames already
/// accepted (including `session/cancel`), so EOF follows them. The kill is
/// the next step. Tests also wait until the writer and its watchdog have
/// exited; `close` ends those tasks even while the registry still holds a
/// clone of the handle.
pub(crate) async fn end_stdio_turn(stdin: &super::stdio_duplex::StdioWriter, child: &mut Child) {
    stdin.close();
    teardown(child).await;
    #[cfg(test)]
    stdin.wait_tasks_finished().await;
}

// ==================== turn driver ====================

/// Per-turn projection state.
#[derive(Default)]
struct TurnView {
    /// [Error]-prefixed chunks held back from the text stream; they become
    /// the terminal error message when the turn fails.
    pending_error_chunks: Vec<String>,
    last_usage: Option<Value>,
    /// toolCallId → tool name from tool_call starts, so the matching
    /// tool_call_update patch can find the row it belongs to.
    tool_names: HashMap<String, String>,
}

/// Drive one send as a qoder ACP turn. Mirrors run_host_turn's settle
/// contract: dispatch events until a terminal done/error, then drain this
/// run's registry entries. Transport/rpc failures surface as
/// EngineEvent::Error — except on interrupt, which commits partial output
/// as a normal turn end (the same contract as the SIGKILL'd process path).
pub(crate) async fn run_acp_turn(
    core: TurnCore,
    req: SendRequest,
    bin: String,
    killed: Arc<AtomicBool>,
    virtual_pid: u32,
) {
    let mut command = super::command_for_binary(&bin);
    command.arg("--acp");
    run_prepared_turn(core, req, command, bin, killed, virtual_pid).await
}

/// Shared settle for a qoder ACP turn. `label` is the binary path in
/// production (so the IDE-launcher guard still applies) and a test tag when
/// the caller already built the command.
async fn run_prepared_turn(
    core: TurnCore,
    req: SendRequest,
    mut command: Command,
    label: String,
    killed: Arc<AtomicBool>,
    virtual_pid: u32,
) {
    let mut state = TurnState::new(req.session_id.clone());
    let mut view = TurnView::default();
    let preassigned_session_id = req.session_id.clone();
    // Abort-safe backstop: an aborted turn never reaches the dispatch below,
    // so the guard emits the one terminal event and frees the registry keys.
    let mut host_guard = HostTurnGuard::arm(&core, &state, Arc::clone(&killed), virtual_pid);
    let result = turn_inner(
        &core,
        &mut state,
        &mut view,
        &req,
        &mut command,
        &label,
        &killed,
    )
    .await;
    let was_killed = killed.load(Ordering::SeqCst);
    let failed = result.is_err();
    if let Err(error) = result {
        if !was_killed {
            core.dispatch_event(&mut state, EngineEvent::Error(error));
        }
    }
    if !state.saw_done && !state.saw_error {
        let usage = if was_killed {
            None
        } else {
            view.last_usage.clone()
        };
        let session_id = state.native_session_id.clone();
        core.dispatch_event(&mut state, EngineEvent::Done { session_id, usage });
    }
    // No await between the terminal dispatch and disarm. An abort only drops
    // the guard at an await point, so it cannot also emit.
    host_guard.disarm_settled(was_killed, failed && !was_killed);
    core.registry.remove_if_pid(&core.run_id, virtual_pid);
    // Clean up both the native session id (if the engine reported one) and
    // the preassigned session id (if we resumed an existing conversation).
    // A resumed session was keyed at spawn under req.session_id, so we must
    // remove that alias even if the native id differs or never arrived.
    if let Some(session_id) = state.native_session_id.clone() {
        core.registry.remove_if_pid(&session_id, virtual_pid);
    }
    if let Some(session_id) = preassigned_session_id {
        core.registry.remove_if_pid(&session_id, virtual_pid);
    }
    core.sink.flush();
}

async fn turn_inner(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    command: &mut Command,
    label: &str,
    killed: &Arc<AtomicBool>,
) -> Result<(), String> {
    if super::qoder::is_qoder_ide_launcher_bin(label) {
        return Err(
            "qoderBin must point to qodercli, not the Qoder IDE launcher (`qoder`)".to_string(),
        );
    }
    let mut spawned = spawn_piped_acp(command, label, &req.workspace)?;
    spawned.acp.bind_run(&core.run_id);
    let result = handshake_and_prompt(&mut spawned.acp, core, state, view, req, killed).await;
    // Already-queued frames, including session/cancel, sit ahead of this EOF.
    // Disarm of the host guard happens later with no await after the terminal
    // dispatch; this await is still inside the turn, before that dispatch.
    end_stdio_turn(&spawned.acp.stdin, &mut spawned.child).await;
    match result {
        Ok(()) => Ok(()),
        Err(error) => Err(terminal_message(error, view, &spawned.stderr_buf)),
    }
}

async fn handshake_and_prompt(
    acp: &mut AcpProcess,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    killed: &AtomicBool,
) -> Result<(), String> {
    acp.request(
        "initialize",
        initialize_params(),
        RPC_HANDSHAKE_TIMEOUT,
        killed,
        None,
        &mut |_| {},
    )
    .await?;
    let cwd = req.workspace.to_string_lossy().to_string();
    let session_result = match req.session_id.as_deref() {
        Some(session_id) => {
            acp.request(
                "session/resume",
                json!({ "cwd": cwd, "mcpServers": [], "sessionId": session_id }),
                SESSION_RESUME_TIMEOUT,
                killed,
                None,
                &mut |_| {},
            )
            .await?
        }
        None => {
            acp.request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                SESSION_NEW_TIMEOUT,
                killed,
                None,
                &mut |_| {},
            )
            .await?
        }
    };
    let session_id = extract_session_id(&session_result)
        .or_else(|| req.session_id.clone())
        .ok_or_else(|| "Qoder session handshake returned no sessionId".to_string())?;
    core.dispatch_event(state, EngineEvent::SessionId(session_id.clone()));

    if let Some(model) = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        acp.request(
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": model }),
            RPC_HANDSHAKE_TIMEOUT,
            killed,
            None,
            &mut |_| {},
        )
        .await
        .map_err(|error| session_setting_error("model", model, error))?;
    }
    if let Some(effort) = req
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        acp.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": "reasoning_effort", "value": effort }),
            RPC_HANDSHAKE_TIMEOUT,
            killed,
            None,
            &mut |_| {},
        )
        .await
        .map_err(|error| session_setting_error("reasoning effort", effort, error))?;
    }
    acp.request(
        "session/set_mode",
        json!({ "sessionId": session_id, "modeId": "bypassPermissions" }),
        RPC_HANDSHAKE_TIMEOUT,
        killed,
        None,
        &mut |_| {},
    )
    .await?;

    let prompt_blocks = assemble_prompt_blocks(&req.prompt, &req.images, &req.workspace)?;
    let result = acp
        .request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": prompt_blocks }),
            PROMPT_TIMEOUT,
            killed,
            Some(&session_id),
            &mut |params| handle_session_update(core, state, view, params),
        )
        .await?;
    if let Some(usage) = result.get("usage").filter(|usage| !usage.is_null()) {
        view.last_usage = Some(attach_context_window(usage.clone()));
        core.dispatch_event(
            state,
            EngineEvent::Usage(attach_context_window(usage.clone())),
        );
    }
    Ok(())
}

/// One session/update notification projected to engine events.
fn handle_session_update(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    params: &Value,
) {
    match session_update_from_notification(params) {
        QoderSessionUpdate::AgentMessageChunk { text } => {
            if is_error_prefixed_text(&text) {
                view.pending_error_chunks.push(text);
                return;
            }
            core.dispatch_event(state, EngineEvent::Delta(text));
        }
        QoderSessionUpdate::AgentThoughtChunk { text } => {
            core.dispatch_event(state, EngineEvent::Thinking(text));
        }
        QoderSessionUpdate::ToolStarted {
            tool_id,
            tool_name,
            input,
        } => {
            view.tool_names.insert(tool_id, tool_name.clone());
            core.dispatch_event(state, super::tool_call_message(tool_name, input.as_ref()));
        }
        QoderSessionUpdate::ToolCompleted {
            tool_id,
            tool_name,
            output,
            error,
        } => {
            let name = tool_name
                .or_else(|| view.tool_names.get(&tool_id).cloned())
                .unwrap_or_else(|| "tool".to_string());
            let result = match (output, error) {
                (Some(output), _) => output,
                (None, Some(error)) => json!({ "text": error, "isError": true }),
                (None, None) => Value::Null,
            };
            core.dispatch_event(state, super::tool_result_patch(name, Some(&result)));
        }
        QoderSessionUpdate::Ignore => {}
    }
}

/// Terminal message precedence (reference-proven): held-back [Error] chunks
/// → the rpc error's message part → captured stderr → the raw error.
fn terminal_message(raw: String, view: &TurnView, stderr_buf: &Arc<Mutex<String>>) -> String {
    if !view.pending_error_chunks.is_empty() {
        return view.pending_error_chunks.join("\n");
    }
    let parsed = parse_rpc_error_message(&raw);
    if !parsed.trim().is_empty() {
        return parsed;
    }
    let stderr_tail = stderr_buf
        .lock()
        .map(|tail| tail.trim().to_string())
        .unwrap_or_default();
    if !stderr_tail.is_empty() {
        stderr_tail
    } else {
        raw
    }
}

// ==================== model catalog probe ====================

/// One availableModels entry from the session/new result.
pub(crate) struct QoderModelEntry {
    pub id: String,
    pub name: Option<String>,
    pub is_default: bool,
}

pub(crate) fn parse_models_from_session_new(result: &Value) -> Vec<QoderModelEntry> {
    let models_node = result.get("models").unwrap_or(result);
    let current = models_node
        .get("currentModelId")
        .or_else(|| models_node.get("current_model_id"))
        .and_then(Value::as_str);
    let mut models: Vec<QoderModelEntry> = models_node
        .get("availableModels")
        .or_else(|| models_node.get("available_models"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry
                .get("modelId")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())?
                .to_string();
            let name = entry
                .get("name")
                .or_else(|| entry.get("displayName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty() && *name != id)
                .map(str::to_string);
            let is_default = current == Some(id.as_str());
            Some(QoderModelEntry {
                id,
                name,
                is_default,
            })
        })
        .collect();
    if current.is_none() {
        if let Some(first) = models.first_mut() {
            first.is_default = true;
        }
    }
    models
}

/// Live ACP model catalog via a throwaway `qodercli --acp` handshake in the
/// temp dir (session/new scans the cwd — a real workspace could take 90s).
/// On-demand only (the model picker); failures degrade to an error so the
/// frontend keeps whatever catalog it already has.
pub(crate) async fn probe_models(bin: &str) -> Result<Vec<QoderModelEntry>, String> {
    if super::qoder::is_qoder_ide_launcher_bin(bin) {
        return Err(
            "qoderBin must point to qodercli, not the Qoder IDE launcher (`qoder`)".to_string(),
        );
    }
    let cwd = std::env::temp_dir();
    let killed = AtomicBool::new(false);
    let result = timeout(MODEL_PROBE_TOTAL, async {
        let mut spawned = spawn_acp(bin, &cwd).await?;
        let cwd_string = cwd.to_string_lossy().to_string();
        let result = async {
            spawned
                .acp
                .request(
                    "initialize",
                    initialize_params(),
                    RPC_HANDSHAKE_TIMEOUT,
                    &killed,
                    None,
                    &mut |_| {},
                )
                .await?;
            spawned
                .acp
                .request(
                    "session/new",
                    json!({ "cwd": cwd_string, "mcpServers": [] }),
                    MODEL_PROBE_TIMEOUT,
                    &killed,
                    None,
                    &mut |_| {},
                )
                .await
        }
        .await;
        teardown(&mut spawned.child).await;
        result
    })
    .await
    .map_err(|_| "Qoder 模型目录探测超时".to_string())??;
    Ok(parse_models_from_session_new(&result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_response_notification_and_agent_request() {
        let response = json!({"jsonrpc":"2.0","id":1,"result":{"ok":true}});
        match parse_acp_line(&response) {
            AcpLine::Response { id, result, error } => {
                assert_eq!(id, json!(1));
                assert_eq!(result, Some(json!({"ok":true})));
                assert!(error.is_none());
            }
            _ => panic!("expected response"),
        }
        let notification = json!({
            "jsonrpc":"2.0",
            "method":"session/update",
            "params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}
        });
        match parse_acp_line(&notification) {
            AcpLine::Notification { method, .. } => assert_eq!(method, "session/update"),
            _ => panic!("expected notification"),
        }
        // method + id = the agent is asking US (permission, fs).
        let request =
            json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}});
        match parse_acp_line(&request) {
            AcpLine::AgentRequest { id, method, .. } => {
                assert_eq!(id, json!(9));
                assert_eq!(method, "session/request_permission");
            }
            _ => panic!("expected agent request"),
        }
        // String ids key responses too.
        assert_eq!(jsonrpc_id_key(&json!("req-1")).as_deref(), Some("req-1"));
        assert_eq!(jsonrpc_id_key(&json!(7)).as_deref(), Some("7"));
        assert!(matches!(
            parse_acp_line(&json!({"hello":"world"})),
            AcpLine::Other
        ));
        assert!(matches!(
            parse_acp_line(&json!({"jsonrpc":"2.0"})),
            AcpLine::Other
        ));
        let error =
            json!({"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no such method"}});
        match parse_acp_line(&error) {
            AcpLine::Response {
                error: Some(error), ..
            } => {
                assert_eq!(error.code, -32601);
                assert_eq!(error.message, "no such method");
            }
            _ => panic!("expected error response"),
        }
    }

    #[test]
    fn maps_session_update_kinds() {
        let text =
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}});
        assert_eq!(
            map_session_update(&text),
            QoderSessionUpdate::AgentMessageChunk {
                text: "hello".to_string()
            }
        );
        let thought = json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"thinking","thinking":"hmm"}});
        assert_eq!(
            map_session_update(&thought),
            QoderSessionUpdate::AgentThoughtChunk {
                text: "hmm".to_string()
            }
        );
        let tool = json!({"sessionUpdate":"tool_call","toolCallId":"call-1","title":"read","status":"pending","rawInput":{"path":"a.rs"}});
        assert_eq!(
            map_session_update(&tool),
            QoderSessionUpdate::ToolStarted {
                tool_id: "call-1".to_string(),
                tool_name: "read".to_string(),
                input: Some(json!({"path":"a.rs"})),
            }
        );
        // A completed snapshot carries the result instead of a start.
        let done = json!({"sessionUpdate":"tool_call","toolCallId":"call-1","title":"read","status":"completed","rawOutput":"ok"});
        assert_eq!(
            map_session_update(&done),
            QoderSessionUpdate::ToolCompleted {
                tool_id: "call-1".to_string(),
                tool_name: Some("read".to_string()),
                output: Some(json!("ok")),
                error: None,
            }
        );
        let failed = json!({"sessionUpdate":"tool_call_update","toolCallId":"call-2","status":"failed","content":[{"type":"content","content":{"type":"text","text":"boom"}}]});
        assert_eq!(
            map_session_update(&failed),
            QoderSessionUpdate::ToolCompleted {
                tool_id: "call-2".to_string(),
                tool_name: None,
                output: Some(json!([{"type":"content","content":{"type":"text","text":"boom"}}])),
                error: Some("boom".to_string()),
            }
        );
        // Updates without a usable id or text are ignored.
        assert_eq!(
            map_session_update(&json!({"sessionUpdate":"tool_call","status":"pending"})),
            QoderSessionUpdate::Ignore
        );
        assert_eq!(
            map_session_update(&json!({"sessionUpdate":"agent_message_chunk","content":{}})),
            QoderSessionUpdate::Ignore
        );
        // Notifications wrap the update under params.update.
        let wrapped =
            json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"wrapped"}}});
        assert_eq!(
            session_update_from_notification(&wrapped),
            QoderSessionUpdate::AgentMessageChunk {
                text: "wrapped".to_string()
            }
        );
    }

    #[test]
    fn error_prefixed_chunks_are_detected() {
        assert!(is_error_prefixed_text("[Error] Network attempt failed"));
        assert!(is_error_prefixed_text("  [Error] boom"));
        assert!(!is_error_prefixed_text("hello [Error] later"));
    }

    #[test]
    fn rpc_error_message_strips_the_code_prefix() {
        assert_eq!(parse_rpc_error_message("rpc:-32601:no method"), "no method");
        assert_eq!(parse_rpc_error_message("plain failure"), "plain failure");
    }

    #[test]
    fn permission_auto_answer_selects_first_allow_kind() {
        let params = json!({
            "options": [
                {"kind":"reject_once","optionId":"no"},
                {"kind":"allow_always","optionId":"yes"},
            ]
        });
        let answer = permission_auto_answer(&params).unwrap();
        assert_eq!(answer["outcome"]["optionId"], json!("yes"));
        assert!(permission_auto_answer(&json!({"options":[]})).is_err());
    }

    #[test]
    fn rpc_internal_error_retains_safe_details_instead_of_hiding_the_cause() {
        let response = json!({"jsonrpc":"2.0", "id":4, "error": {
            "code":-32603, "message":"Internal error", "data": {
                "details":"Unknown model alias: missing-model; api_key=sk-private\nprivate stack trace",
                "request": {"prompt":"private conversation"}
            }
        }});
        let AcpLine::Response {
            error: Some(error), ..
        } = parse_acp_line(&response)
        else {
            panic!("expected RPC error");
        };
        assert!(error.message.contains("Unknown model alias: missing-model"));
        assert!(!error.message.contains("sk-private"));
        assert!(!error.message.contains("private stack"));
        assert!(!error.message.contains("private conversation"));
    }

    #[test]
    fn fs_sandbox_rejects_escape() {
        let root = std::env::temp_dir().join(format!("qoder-fs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let err = confine_path_to_workspace(&root, "/etc/passwd", false).expect_err("escape");
        assert!(err.contains("escapes workspace root"), "{err}");
        let nested = confine_path_to_workspace(&root, "sub/file.txt", true).unwrap();
        assert!(nested.starts_with(std::fs::canonicalize(&root).unwrap()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_agent_request_returns_method_not_found() {
        let root = std::env::temp_dir();
        let response = answer_agent_request(&root, &json!(3), "totally/unknown", &json!({}));
        assert_eq!(response["error"]["code"], json!(JSONRPC_METHOD_NOT_FOUND));
    }

    #[test]
    fn parses_models_from_session_new() {
        let result = json!({
            "sessionId": "s-1",
            "models": {
                "currentModelId": "qoder-pro",
                "availableModels": [
                    {"modelId": "qoder-pro", "name": "Qoder Pro"},
                    {"modelId": "qoder-flash"},
                ],
            },
        });
        let models = parse_models_from_session_new(&result);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "qoder-pro");
        assert_eq!(models[0].name.as_deref(), Some("Qoder Pro"));
        assert!(models[0].is_default);
        assert!(!models[1].is_default);
        assert_eq!(models[1].name, None);
        // No current model: the first entry becomes the default.
        let result = json!({"models": {"availableModels": [{"modelId": "a"}]}});
        let models = parse_models_from_session_new(&result);
        assert!(models[0].is_default);
    }

    fn test_limits() -> PumpLimits {
        PumpLimits {
            prompt_hard_cap: Duration::from_secs(5),
            trailing_idle: Duration::from_millis(20),
            trailing_cap: Duration::from_millis(100),
            cancel_settle: Duration::from_millis(200),
            kill_poll: Duration::from_millis(10),
        }
    }

    async fn streaming_acp_peer() -> SpawnedAcp {
        let peer = r#"
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const mode = request.params && request.params.mode;
  if (request.method === 'test/handshake') {
    send({jsonrpc: '2.0', id: request.id, result: {ready: true}});
  } else if (mode === 'complete') {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      if (count === 4) {
        send({jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission',
          params: {sessionId: 's', options: [{kind: 'allow_once', optionId: 'allow'}]}});
      } else {
        send({jsonrpc: '2.0', method: 'session/update', params: {sessionId: 's',
          update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'active'}}}});
      }
      if (count === 8) {
        clearInterval(timer);
        send({jsonrpc: '2.0', id: request.id, result: {stopReason: 'end_turn'}});
      }
    }, 100);
  } else if (mode === 'forever') {
    setInterval(() => send({jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's', update: {sessionUpdate: 'agent_message_chunk'}
    }}), 50);
  }
});
"#;
        let mut command = Command::new("node");
        command.args(["-e", peer]);
        let mut spawned = spawn_piped_acp(&mut command, "ACP test peer", &std::env::temp_dir())
            .expect("protocol test requires the project's Node runtime");
        spawned.acp.limits = test_limits();
        spawned
    }

    /// The Node peer needs a moment to boot, and the parallel suite makes
    /// that moment unpredictable. Answer a handshake first so the timed
    /// prompt only starts once the peer provably processes lines.
    async fn ready_streaming_acp_peer() -> SpawnedAcp {
        let mut spawned = streaming_acp_peer().await;
        spawned
            .acp
            .routed(
                "test/handshake",
                json!({}),
                Duration::from_secs(10),
                &AtomicBool::new(false),
                None,
                &mut |_| None,
            )
            .await
            .expect("ACP test peer must answer the readiness handshake");
        spawned
    }

    #[tokio::test]
    async fn acp_prompt_stays_alive_while_session_output_is_active() {
        let mut spawned = ready_streaming_acp_peer().await;
        let mut updates = 0;
        let mut permissions = 0;
        let result = timeout(
            Duration::from_secs(3),
            spawned.acp.routed(
                "session/prompt",
                json!({"mode": "complete"}),
                // 300 ms idle budget: 3x the peer's 100 ms update cadence
                // (a 200 ms margin = 20 kill-poll ticks of scheduler jitter),
                // while the 800 ms stream only survives via renewal.
                Duration::from_millis(300),
                &AtomicBool::new(false),
                Some("s"),
                &mut |line| match line {
                    AcpLine::Notification { method, .. } if method == "session/update" => {
                        updates += 1;
                        None
                    }
                    AcpLine::AgentRequest { id, method, .. }
                        if method == "session/request_permission" =>
                    {
                        permissions += 1;
                        Some(jsonrpc_result_response(id, json!({})))
                    }
                    _ => None,
                },
            ),
        )
        .await;
        end_stdio_turn(&spawned.acp.stdin, &mut spawned.child).await;
        let result = result
            .expect("active prompt must not reach the test guard")
            .unwrap();
        assert_eq!(result["stopReason"], json!("end_turn"));
        assert_eq!(updates, 7);
        assert_eq!(permissions, 1);
    }

    #[tokio::test]
    async fn acp_output_does_not_extend_rpc_or_cancel_settle_deadlines() {
        for interrupted in [false, true] {
            // Handshake first: the peer must really be streaming while the
            // fixed RPC / cancel-settle deadlines hold, otherwise the test
            // would pass vacuously on a slow peer start.
            let mut spawned = ready_streaming_acp_peer().await;
            let killed = AtomicBool::new(interrupted);
            let method = if interrupted {
                "session/prompt"
            } else {
                "initialize"
            };
            let result = timeout(
                Duration::from_secs(1),
                spawned.acp.routed(
                    method,
                    json!({"mode": "forever"}),
                    if interrupted {
                        Duration::from_secs(1)
                    } else {
                        Duration::from_millis(200)
                    },
                    &killed,
                    interrupted.then_some("s"),
                    &mut |_| None,
                ),
            )
            .await;
            end_stdio_turn(&spawned.acp.stdin, &mut spawned.child).await;
            let result = result.expect("output must not prolong the RPC or cancel deadline");
            assert_eq!(
                result.unwrap_err(),
                if interrupted {
                    CANCELLED
                } else {
                    "initialize timed out"
                }
            );
        }
    }

    #[tokio::test]
    async fn acp_idle_prompt_still_times_out() {
        let mut spawned = streaming_acp_peer().await;
        let result = timeout(
            Duration::from_secs(1),
            spawned.acp.routed(
                "session/prompt",
                json!({"mode": "idle"}),
                Duration::from_millis(100),
                &AtomicBool::new(false),
                Some("s"),
                &mut |_| None,
            ),
        )
        .await;
        end_stdio_turn(&spawned.acp.stdin, &mut spawned.child).await;
        let result = result.expect("idle prompt must time out before the test guard");
        assert_eq!(result.unwrap_err(), "session/prompt timed out");
    }

    const DUPLEX_BYTES: usize = 2 * 1024 * 1024;

    fn process_alive(pid: u32) -> bool {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        sys.process(Pid::from_u32(pid)).is_some()
    }

    fn wait_until_dead(pid: u32) {
        let started = std::time::Instant::now();
        while process_alive(pid) {
            if started.elapsed() > Duration::from_secs(2) {
                panic!("pid {pid} is still alive");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Peer that, on `session/prompt` only, asks for a large file and then
    /// writes a multi-megabyte stdout burst with `fs.writeSync` before it
    /// reads stdin again. `session` mode also answers the qoder handshake.
    fn write_duplex_peer(dir: &std::path::Path, session: bool) -> std::path::PathBuf {
        let script = dir.join("peer.js");
        let session_flag = if session { "true" } else { "false" };
        let source = format!(
            r#"
const fs = require('fs');
const session = {session_flag};
const file = process.argv[2];
const marker = process.argv[3];
const pids = process.argv[4];
if (pids) {{
  const kid = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{{}},1e9)'], {{stdio:'ignore'}});
  fs.writeFileSync(pids, JSON.stringify({{pid: process.pid, child: kid.pid}}));
}}
function readUntil(pred) {{
  let acc = Buffer.alloc(0);
  const buf = Buffer.alloc(65536);
  while (true) {{
    const n = fs.readSync(0, buf, 0, buf.length);
    if (n <= 0) return null;
    acc = Buffer.concat([acc, buf.subarray(0, n)]);
    let nl;
    while ((nl = acc.indexOf(10)) >= 0) {{
      const line = acc.subarray(0, nl).toString('utf8');
      acc = acc.subarray(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (pred(msg)) return msg;
    }}
  }}
}}
function reply(id, result) {{
  fs.writeSync(1, JSON.stringify({{jsonrpc:'2.0', id, result}}) + '\n');
}}
readUntil(msg => {{
  if (!msg.method) return false;
  if (msg.method !== 'session/prompt') {{
    if (!session) return false;
    const result = msg.method === 'session/new' ? {{sessionId: 's-test'}} : {{}};
    reply(msg.id, result);
    return false;
  }}
  if (marker) fs.writeFileSync(marker, 'burst');
  fs.writeSync(1, JSON.stringify({{jsonrpc:'2.0', id:'fs-1', method:'fs/read_text_file', params:{{path:file}}}}) + '\n');
  const chunk = 'z'.repeat(32 * 1024);
  let sent = 0;
  while (sent < {bytes}) {{
    const line = JSON.stringify({{jsonrpc:'2.0', method:'session/update', params:{{sessionId:'s-test', update:{{sessionUpdate:'agent_message_chunk', content:{{type:'text', text:chunk}}}}}}}}) + '\n';
    fs.writeSync(1, line);
    sent += Buffer.byteLength(line);
  }}
  const answer = readUntil(msg => String(msg.id) === 'fs-1');
  const ok = !!(answer && answer.result && answer.result.content && answer.result.content.length >= {bytes});
  reply(msg.id, ok ? {{stopReason:'end_turn'}} : {{stopReason:'error'}});
  return true;
}});
"#,
            session_flag = session_flag,
            bytes = DUPLEX_BYTES,
        );
        std::fs::write(&script, source).unwrap();
        script
    }

    fn temp_workspace(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ccgui-acp-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.txt");
        std::fs::write(&big, vec![b'a'; DUPLEX_BYTES]).unwrap();
        dir
    }

    #[tokio::test]
    async fn acp_full_duplex_burst_does_not_deadlock() {
        let dir = temp_workspace("duplex");
        let script = write_duplex_peer(&dir, false);
        let file = dir.join("big.txt");
        let mut command = Command::new("node");
        command.arg(&script).arg(&file);
        let mut spawned = spawn_piped_acp(&mut command, "acp-duplex", &dir).expect("node");
        spawned.acp.limits.prompt_hard_cap = Duration::from_secs(30);
        let mut updates = 0usize;
        let outcome = timeout(
            Duration::from_secs(8),
            spawned.acp.routed(
                "session/prompt",
                json!({}),
                Duration::from_secs(20),
                &AtomicBool::new(false),
                Some("s-test"),
                &mut |line| match line {
                    AcpLine::Notification { method, .. } if method == "session/update" => {
                        updates += 1;
                        None
                    }
                    AcpLine::AgentRequest { id, method, params } => {
                        Some(answer_agent_request(&dir, id, method, params))
                    }
                    _ => None,
                },
            ),
        )
        .await;
        end_stdio_turn(&spawned.acp.stdin, &mut spawned.child).await;
        let result = outcome
            .expect("full-duplex burst must not deadlock the read loop")
            .expect("prompt must complete");
        assert_eq!(result["stopReason"], json!("end_turn"));
        assert!(updates > 0, "stdout burst must be drained");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn acp_silent_peer_hits_idle_deadline_and_kills_child() {
        let dir = temp_workspace("silent");
        let pids = dir.join("pids.json");
        let peer = r#"
const fs = require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({pid: process.pid}));
setInterval(() => {}, 1e9);
"#;
        let mut command = Command::new("node");
        command.args(["-e", peer, &pids.to_string_lossy()]);
        let mut spawned = spawn_piped_acp(&mut command, "acp-silent", &dir).expect("node");
        spawned.acp.limits = test_limits();
        spawned.acp.limits.prompt_hard_cap = Duration::from_secs(30);
        let big = "a".repeat(DUPLEX_BYTES);
        let outcome = timeout(
            Duration::from_secs(3),
            spawned.acp.routed(
                "session/prompt",
                json!({ "prompt": big }),
                Duration::from_millis(200),
                &AtomicBool::new(false),
                Some("s-test"),
                &mut |_| None,
            ),
        )
        .await;
        let pid = spawned.child.id();
        end_stdio_turn(&spawned.acp.stdin, &mut spawned.child).await;
        let err = outcome
            .expect("a silent peer must hit the idle deadline, not the test guard")
            .expect_err("silent peer ends with a typed timeout");
        assert_eq!(err, "session/prompt timed out");
        if let Some(pid) = pid {
            wait_until_dead(pid);
        }
        let recorded: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pids).unwrap()).unwrap();
        wait_until_dead(recorded["pid"].as_u64().unwrap() as u32);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn acp_interrupt_during_stdio_deadlock_settles() {
        use crate::engine::registry::ChildEntry;
        use crate::engine::ProcessRegistry;
        use crate::event_sink::{Emit, EventSink};
        use std::collections::HashMap;

        struct CollectingEmitter(std::sync::Mutex<Vec<String>>);
        impl Emit for CollectingEmitter {
            fn emit_json(&self, _name: &str, raw_json: &str) {
                self.0.lock().unwrap().push(raw_json.to_string());
            }
        }

        let dir = temp_workspace("interrupt");
        let script = write_duplex_peer(&dir, true);
        let file = dir.join("big.txt");
        let marker = dir.join("marker");
        let pids = dir.join("pids.json");
        let mut command = Command::new("node");
        command.arg(&script).arg(&file).arg(&marker).arg(&pids);

        let emitter = std::sync::Arc::new(CollectingEmitter(std::sync::Mutex::new(Vec::new())));
        let registry = std::sync::Arc::new(ProcessRegistry::default());
        let killed = std::sync::Arc::new(AtomicBool::new(false));
        let virtual_pid = 4_000_000_201u32;
        let run_id = "duplex-interrupt".to_string();
        registry.insert(
            run_id.clone(),
            ChildEntry {
                child: None,
                pid: virtual_pid,
                run_id: run_id.clone(),
                killed: std::sync::Arc::clone(&killed),
                reader_abort: std::sync::Arc::new(std::sync::OnceLock::new()),
                stdin: None,
                questions: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
                plans: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
            },
        );
        let core = TurnCore {
            sink: EventSink::new(emitter.clone()),
            registry: std::sync::Arc::clone(&registry),
            engine_id: "qoder".to_string(),
            run_id: run_id.clone(),
            db: None,
        };
        let req = SendRequest {
            session_id: None,
            workspace: dir.clone(),
            prompt: "hi".into(),
            prompt_contributions: Vec::new(),
            native_compact: false,
            images: Vec::new(),
            model: None,
            effort: None,
            service_tier: None,
            permission: None,
            additional_dirs: Vec::new(),
            provider_id: None,
            computer_use: None,
            memory_bot: None,
            allowed_tools: None,
        };
        let mut task = tokio::spawn(run_prepared_turn(
            core,
            req,
            command,
            "acp-interrupt".into(),
            std::sync::Arc::clone(&killed),
            virtual_pid,
        ));
        let marked = timeout(Duration::from_secs(8), async {
            loop {
                if marker.exists() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if marked.is_err() {
            task.abort();
            let _ = task.await;
            panic!("peer never reached the stdout burst");
        }
        killed.store(true, Ordering::SeqCst);
        let started = std::time::Instant::now();
        tokio::select! {
            joined = &mut task => {
                joined.expect("turn task");
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "interrupt must settle inside the cancel window plus margin, took {:?}",
                    started.elapsed()
                );
            }
            _ = tokio::time::sleep(Duration::from_secs(6)) => {
                task.abort();
                let _ = task.await;
                panic!("turn did not settle within the cancel window plus margin");
            }
        }
        let events = {
            let raw = emitter.0.lock().unwrap();
            let mut out = Vec::new();
            for batch in raw.iter() {
                let parsed: serde_json::Value = serde_json::from_str(batch).unwrap();
                let items = parsed.as_array().cloned().unwrap_or_else(|| vec![parsed]);
                out.extend(items);
            }
            out
        };
        let terminal: Vec<_> = events
            .iter()
            .filter(|event| matches!(event["kind"].as_str(), Some("done") | Some("error")))
            .collect();
        assert_eq!(terminal.len(), 1, "exactly one terminal event: {events:?}");
        assert_eq!(terminal[0]["kind"], "done");
        assert_eq!(terminal[0]["data"]["cancelled"], json!(true));
        assert_eq!(registry.active_run_count(), 0, "registry must be drained");
        let recorded: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pids).unwrap()).unwrap();
        wait_until_dead(recorded["pid"].as_u64().unwrap() as u32);
        wait_until_dead(recorded["child"].as_u64().unwrap() as u32);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
