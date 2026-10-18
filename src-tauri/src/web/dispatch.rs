use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;

use super::{web_access_status, web_device_approve, web_device_revoke, web_devices};

// ==================== Command dispatch ====================

#[derive(Deserialize)]
struct RelayArgs {
    url: String,
    key: String,
}

#[derive(Deserialize)]
struct RelayDeployPackArgs {
    path: String,
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayDeployArgs {
    token: String,
    /// Absent for user tokens, which can list their accounts; required in
    /// practice for account-owned ones (`cfat_…`).
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct DeviceIdArgs {
    id: String,
}

#[derive(Deserialize)]
struct DiagnosticsEnabledArgs {
    enabled: bool,
}

fn parse_args<T: serde::de::DeserializeOwned>(raw: &Value) -> Result<T, String> {
    serde_json::from_value(raw.clone()).map_err(|e| format!("invalid args: {e}"))
}

fn ser<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// First time this process sees an unknown command, log it. Repeats are the
/// same permanent gap (an old page, or a command this build does not route)
/// and must not fill the error log on every poll.
fn note_unknown_command(cmd: &str) -> bool {
    static SEEN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    let mut seen = match SEEN
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
        .lock()
    {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    seen.insert(cmd.to_string())
}

/// 记忆写入失败保持结构化：错误以 JSON 字符串过桥，前端 memoryErrorMessage
/// 按 code/kind 本地化。
fn memory_ser<T: serde::Serialize>(
    r: Result<T, crate::memory::MemoryError>,
) -> Result<Value, String> {
    match r {
        Ok(value) => serde_json::to_value(value).map_err(|e| e.to_string()),
        Err(error) => Err(
            serde_json::to_string(&error).unwrap_or_else(|_| error.message),
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineIdArgs {
    engine: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginReadFileArgs {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginReadArtworkArgs {
    id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginIdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStorageGetArgs {
    id: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginAssetIdArgs {
    plugin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginAssetPathArgs {
    plugin_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginAssetRevokeArgs {
    plugin_id: String,
    grant_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertProviderArgs {
    engine: String,
    id: String,
    json: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderProvidersArgs {
    engine: String,
    ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEngineEnabledArgs {
    engine: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashArgs {
    hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportCcSwitchFromPathArgs {
    path: String,
    engine: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchProviderModelsArgs {
    base_url: String,
    #[serde(default)]
    api_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettingsArgs {
    settings: crate::settings::AppSettings,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageArgs {
    origin: Option<String>,
    run_id: Option<String>,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    #[serde(default)]
    prompt_contributions: Vec<crate::engine::PromptContribution>,
    /// ccgui 内置 `/compact`：OMP 走原生 compact RPC 命令。默认值让旧客户端保持可用。
    #[serde(default)]
    native_compact: Option<bool>,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    provider_id: Option<String>,
    /// Desktop-only feature; default keeps older web clients compatible.
    #[serde(default)]
    computer_use: Option<bool>,
    /// 记忆工具挂载（memory/mcp.rs）：默认值让旧客户端保持可用。
    #[serde(default)]
    memory_bot: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerQuestionArgs {
    session_id: String,
    request_id: String,
    /// Question text → chosen label(s); `None` is the user's skip/dismiss.
    #[serde(default)]
    answers: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineArgs {
    engine: String,
    workspace: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliEngineArgs {
    engine: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliUpdateArgs {
    engine: String,
    run_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginHostArgs {
    plugin_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEngineArgs {
    plugin_id: String,
    engine: String,
    workspace: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginCatalogArgs {
    plugin_id: String,
    workspace: Option<String>,
    #[serde(default)]
    refresh_providers: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialConfigWriteArgs {
    engine: String,
    files: Vec<crate::provider_files::OfficialConfigDraft>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePastedImageArgs {
    data_base64: String,
    extension: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathsArgs {
    paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadSessionPageArgs {
    engine: String,
    session_id: String,
    limit: Option<usize>,
    before_seq: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadSessionEventsArgs {
    engine: String,
    session_id: String,
    after_cursor: i64,
    until_cursor: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadRemoteSessionPageArgs {
    workspace_path: String,
    engine: String,
    session_id: String,
    remote_path: String,
    limit: Option<usize>,
    before_seq: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRemoteSessionArgs {
    workspace_path: String,
    engine: String,
    session_id: String,
    remote_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummaryArgs {
    days: u32,
    tz_offset_minutes: i32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageRecordArgs {
    entry: crate::usage::UsageEntry,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineSessionArgs {
    engine: String,
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordAcceptedFrameArgs {
    engine: String,
    session_id: String,
    frame: String,
    workspace_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveSessionArgs {
    session: crate::history::SessionMeta,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinSessionArgs {
    engine: String,
    session_id: String,
    pinned: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameSessionArgs {
    engine: String,
    session_id: String,
    title: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberModelArgs {
    engine: String,
    session_id: String,
    model: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberEffortArgs {
    engine: String,
    session_id: String,
    effort: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberProviderArgs {
    engine: String,
    session_id: String,
    provider_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
    /// Optional workspace meta passthrough (plugin workspaces.add keeps
    /// transport descriptions alive on the web runtime too).
    meta: Option<serde_json::Value>,
    /// Optional worktree registration (host UI: 新建/恢复 worktree 子工作区).
    kind: Option<String>,
    parent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIndexArgs {
    path: String,
    /// Optional: include gitignored entries (chat file-link fallback).
    #[serde(default)]
    include_ignored: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginAddWorkspaceArgs {
    plugin_id: String,
    path: String,
    meta: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdsArgs {
    ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotCreateArgs {
    input: crate::bots::BotCreate,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotUpdateArgs {
    id: String,
    patch: crate::bots::BotPatch,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryListArgs {
    bot_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryAddArgs {
    bot_id: Option<String>,
    target: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryUpdateArgs {
    id: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryClearArgs {
    bot_id: Option<String>,
    target: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryReviewArgs {
    bot_id: String,
    engine: String,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    transcript: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleArgs {
    locale: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltInAgentIdArgs {
    agent_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltInAgentEnabledArgs {
    agent_id: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltInAgentDivisionEnabledArgs {
    division_id: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptsCreateArgs {
    path: String,
    scope: String,
    name: String,
    description: Option<String>,
    argument_hint: Option<String>,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptPathArgs {
    path: String,
    prompt_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptUpdateArgs {
    path: String,
    prompt_path: String,
    updates: crate::prompts::PromptUpdates,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptMoveArgs {
    path: String,
    prompt_path: String,
    scope: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetWorkspaceGroupArgs {
    id: String,
    group_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileArgs {
    path: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameItemArgs {
    from: String,
    to: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasteItemArgs {
    source: String,
    target_dir: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchTextArgs {
    path: String,
    query: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchMessagesArgs {
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
    scope: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffArgs {
    path: String,
    file: String,
    staged: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitFilesArgs {
    path: String,
    files: Vec<String>,
}
#[derive(Deserialize)]
struct GitTreeArgs {
    levels: Vec<crate::git::GitTreeLevel>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitArgs {
    path: String,
    message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCheckoutArgs {
    path: String,
    branch: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCreateBranchArgs {
    path: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceArgs {
    path: String,
    app: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCustomProgramArgs {
    executable_path: String,
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetProgramIconArgs {
    executable_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOpenArgs {
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWriteArgs {
    id: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeArgs {
    id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanReviewArgs {
    engine: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondPlanReviewArgs {
    plan_id: String,
    expected_revision: i64,
    decision: crate::engine::plan_review::PlanDecision,
    #[serde(default)]
    feedback: Option<String>,
}

#[derive(Deserialize)]
struct ActiveArgs {
    active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoPathArgs {
    repo_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktreeCreateCall {
    creation_id: String,
    args: crate::git_worktree::WorktreeCreateArgs,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreationIdArgs {
    creation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktreeRemoveArgs {
    repo_path: String,
    worktree_path: String,
    branch: Option<String>,
    delete_branch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchMergedArgs {
    repo_path: String,
    branch: String,
    base: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitResolvePrArgs {
    repo_path: String,
    input: String,
    suggested_branch: String,
    worktree_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MissionStartArgs {
    engine: String,
    prompt: String,
    workspace_path: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    run_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MissionInterruptArgs {
    run_id: String,
}

#[derive(Deserialize)]
struct FontPathArgs {
    path: String,
}

#[derive(Deserialize)]
struct DeviceRenameArgs {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiProviderArgs {
    engine: String,
    provider_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiKeyArgs {
    engine: String,
    provider_id: String,
    key: String,
}

#[derive(Deserialize)]
struct PiModelsWriteArgs {
    engine: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMetadataArgs {
    plugin_id: String,
    workspace_path: String,
}

#[derive(Deserialize)]
struct EngineOnlyArgs {
    engine: String,
}

/// Routes a bridge invoke to the same command functions the Tauri handler
/// uses. Sync commands run inline: the heaviest (git diff, config writes) are
/// milliseconds-scale, and the per-invoke tokio task keeps the read loop
/// unblocked. Commands that genuinely need a thread pool already
/// spawn_blocking internally (git_status, read_file, search_text…).
pub(super) async fn dispatch(
    app: &tauri::AppHandle,
    cmd: &str,
    raw: Value,
) -> Result<Value, String> {
    if cmd == "relay_update_check" { return crate::relay_update::relay_update_check(app.clone()); }
    if cmd == "relay_update_complete" {
        let version = raw["version"].as_str().ok_or("missing update version")?.to_string();
        let token = raw["token"].as_str().ok_or("missing update receipt")?.to_string();
        return ser(crate::relay_update::relay_update_complete(app.clone(), version, token));
    }
    if cmd == "relay_update_abort" {
        return ser(crate::relay_update::abort(&app.state::<crate::AppState>(), raw["token"].as_str().ok_or("missing update receipt")?, raw["version"].as_str().ok_or("missing update version")?));
    }
    let _activity = if cmd == "list_active_runs" { app.state::<crate::AppState>().relay.update.idle_query() } else { Some(app.state::<crate::AppState>().relay.update.activity(false)?) };
    if cmd == "debug_logs" { return dispatch_inner(app, cmd, raw).await; }
    let started = std::time::Instant::now();
    let secrets = crate::diagnostics::private_values(&raw);
    let identity = (raw["engine"].as_str().map(str::to_owned), raw["sessionId"].as_str().map(str::to_owned), raw["runId"].as_str().map(str::to_owned));
    let result = dispatch_inner(app, cmd, raw).await;
    let unknown = result
        .as_ref()
        .err()
        .is_some_and(|error| error.starts_with("unknown command:"));
    if unknown && !note_unknown_command(cmd) {
        return result;
    }
    crate::diagnostics::record(crate::diagnostics::Entry {
        category: if result.is_ok() { "performance" } else { "error" }, level: if result.is_ok() { "info" } else { "error" },
        source: "rpc", operation: Some(cmd), message: result.as_ref().err().map(String::as_str),
        engine: identity.0.as_deref(), session_id: identity.1.as_deref(), run_id: identity.2.as_deref(),
        duration_ms: Some(started.elapsed().as_millis() as u64), ..crate::diagnostics::Entry::default()
    }, &secrets);
    result
}

async fn dispatch_inner(app: &tauri::AppHandle, cmd: &str, raw: Value) -> Result<Value, String> {
    match cmd {
        "relay_update_status" => ser(Ok::<_, String>(crate::relay_update::relay_update_status(app.state()))),
        "relay_update_defer" => ser(crate::relay_update::relay_update_defer(app.state())),
        // config
        "get_cli_config" => ser(crate::config::get_cli_config()),
        "upsert_provider" => {
            let a: UpsertProviderArgs = parse_args(&raw)?;
            ser(crate::config::upsert_provider(
                app.state(),
                a.engine,
                a.id,
                a.json,
            ))
        }
        "delete_provider" => {
            let a: EngineIdArgs = parse_args(&raw)?;
            ser(crate::config::delete_provider(app.state(), a.engine, a.id))
        }
        "set_current_provider" => {
            let a: EngineIdArgs = parse_args(&raw)?;
            ser(crate::config::set_current_provider(
                app.state(),
                a.engine,
                a.id,
            ))
        }
        "provider_file_paths" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(Ok::<_, String>(crate::provider_files::provider_file_paths(
                a.engine,
            )))
        }
        "official_config_read" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::provider_files::official_config_read(a.engine))
        }
        "official_config_write" => {
            let a: OfficialConfigWriteArgs = parse_args(&raw)?;
            ser(crate::provider_files::official_config_write(
                app.state(),
                a.engine,
                a.files,
            ))
        }
        "reorder_providers" => {
            let a: ReorderProvidersArgs = parse_args(&raw)?;
            ser(crate::config::reorder_providers(
                app.state(),
                a.engine,
                a.ids,
            ))
        }
        "set_engine_enabled" => {
            let a: SetEngineEnabledArgs = parse_args(&raw)?;
            ser(crate::config::set_engine_enabled(
                app.state(),
                a.engine,
                a.enabled,
            ))
        }
        // cc-switch interop
        "check_cc_switch" => ser(crate::cc_switch::check_cc_switch().await),
        "dismiss_cc_switch" => {
            let a: HashArgs = parse_args(&raw)?;
            ser(crate::cc_switch::dismiss_cc_switch(a.hash))
        }
        "import_cc_switch" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::cc_switch::import_cc_switch(app.state(), a.engine))
        }
        "import_cc_switch_from_path" => {
            let a: ImportCcSwitchFromPathArgs = parse_args(&raw)?;
            ser(crate::cc_switch::import_cc_switch_from_path(
                app.state(),
                a.path,
                a.engine,
            ))
        }
        "fetch_provider_models" => {
            let a: FetchProviderModelsArgs = parse_args(&raw)?;
            ser(crate::provider_models::fetch_provider_models(a.base_url, a.api_key).await)
        }
        // settings
        "get_app_settings" => ser(crate::settings::get_app_settings()),
        "update_app_settings" => {
            let a: UpdateSettingsArgs = parse_args(&raw)?;
            ser(crate::settings::update_app_settings(
                app.clone(),
                a.settings,
            ))
        }
        // engine
        "send_message" => {
            let a: SendMessageArgs = parse_args(&raw)?;
            ser(crate::engine::send_message(
                app.state(),
                a.engine,
                a.workspace_path,
                a.session_id,
                a.prompt,
                a.prompt_contributions,
                a.native_compact,
                a.image_paths,
                a.model,
                a.effort,
                a.permission,
                a.provider_id,
                a.run_id,
                a.computer_use,
                a.memory_bot,
                a.origin,
            )
            .await)
        }
        "interrupt_session" => {
            let a: SessionIdArgs = parse_args(&raw)?;
            ser(crate::engine::interrupt_session(app.state(), a.session_id).await)
        }
        // A browser refresh or a machine switch loads a new page. The turn
        // keeps running on this desktop; the page asks who is still live
        // and paints that session as running again.
        "list_active_runs" => ser(Ok(app.state::<crate::AppState>().processes.active_runs())),
        "run_status" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args { run_ids: Vec<String> }
            let a: Args = parse_args(&raw)?;
            ser(crate::history::journal::run_status(app.state(), a.run_ids))
        }
        "set_session_origin" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args { engine: String, session_id: String, origin: String }
            let a: Args = parse_args(&raw)?;
            ser(crate::history::journal::set_session_origin(app.state(), a.engine, a.session_id, a.origin))
        }
        // The remote UI renders the same AskUserQuestion card as the desktop
        // (events already reach it); without this case its 提交/忽略 buttons
        // failed with `unknown command: answer_question`.
        "answer_question" => {
            let a: AnswerQuestionArgs = parse_args(&raw)?;
            ser(
                crate::engine::answer_question(app.state(), a.session_id, a.request_id, a.answers)
                    .await,
            )
        }
        "list_engines" => ser(crate::engine::list_engines().await),
        // Settings → CLI 管理 is the same page on the remote web UI. The
        // install runs on this desktop (the machine the browser selected),
        // and cli://update-progress already rides the web event broadcast.
        "cli_version_status" => {
            let a: CliEngineArgs = parse_args(&raw)?;
            ser(crate::cli_lifecycle::cli_version_status(a.engine).await)
        }
        "cli_update_plan" => {
            let a: CliEngineArgs = parse_args(&raw)?;
            ser(crate::cli_lifecycle::cli_update_plan(a.engine).await)
        }
        "cli_update" => {
            let a: CliUpdateArgs = parse_args(&raw)?;
            ser(crate::cli_lifecycle::cli_update(a.engine, a.run_id, app.state()).await)
        }
        "list_engine_models" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::engine::models::list_engine_models(app.state(), a.engine, a.workspace).await)
        }
        // Plugin model discovery is safe for remote hosts: the desktop that
        // owns the engines performs the authoritative probes and re-checks
        // host:models. Window control remains desktop-Tauri only.
        "plugin_list_engines" => {
            let a: PluginHostArgs = parse_args(&raw)?;
            ser(crate::plugin_host::plugin_list_engines(a.plugin_id).await)
        }
        "plugin_list_engine_models" => {
            let a: PluginEngineArgs = parse_args(&raw)?;
            ser(crate::plugin_host::plugin_list_engine_models(
                app.state(),
                a.plugin_id,
                a.engine,
                a.workspace,
            )
            .await)
        }
        "plugin_model_catalog" => {
            let a: PluginCatalogArgs = parse_args(&raw)?;
            ser(crate::plugin_host::plugin_model_catalog(
                app.state(),
                a.plugin_id,
                a.workspace,
                a.refresh_providers,
            )
            .await)
        }
        "save_pasted_image" => {
            let a: SavePastedImageArgs = parse_args(&raw)?;
            ser(crate::engine::images::save_pasted_image(
                a.data_base64,
                a.extension,
            ))
        }
        "import_attachments" => {
            let a: PathsArgs = parse_args(&raw)?;
            ser(crate::engine::images::import_attachments(a.paths))
        }
        // history
        "write_session_field" => {
            let args: crate::history::metadata::FieldWrite = parse_args(&raw)?;
            ser(crate::history::metadata::apply(&app.state(), args))
        }
        "list_sessions" => ser(crate::history::reader::list_sessions(app.state())),
        "list_archived_sessions" => {
            ser(crate::history::reader::list_archived_sessions(app.state()))
        }
        "archive_session" => {
            let a: ArchiveSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::archive_session(
                app.state(),
                a.session,
            ))
        }
        "restore_session" => {
            let a: EngineSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::restore_session(
                app.state(),
                a.engine,
                a.session_id,
            ))
        }
        // Usage ledger: the mobile/web client renders the same page, so the
        // bridge must route it like every other settings surface.
        "usage_summary" => {
            let a: UsageSummaryArgs = parse_args(&raw)?;
            ser(crate::usage::usage_summary(
                app.state(),
                a.days,
                a.tz_offset_minutes,
            ))
        }
        "usage_record" => {
            let a: UsageRecordArgs = parse_args(&raw)?;
            ser(crate::usage::usage_record(
                app.clone(),
                app.state(),
                a.entry,
            ))
        }
        "usage_clear" => ser(crate::usage::usage_clear(app.state())),
        "load_session_events" => {
            let a: LoadSessionEventsArgs = parse_args(&raw)?;
            ser(crate::history::journal::load_session_events(app.state(), a.engine, a.session_id, a.after_cursor, a.until_cursor).await)
        }
        "session_log_since" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args { engine:String, session_id:String, after_rev:i64, epoch:Option<i64>, until_rev:Option<i64>, limit:Option<usize>, workspace_path:Option<String>, remote_path:Option<String> }
            let a: Args = parse_args(&raw)?;
            ser(crate::history::log::session_log_since(app.state(),a.engine,a.session_id,a.after_rev,a.epoch,a.until_rev,a.limit,a.workspace_path,a.remote_path).await)
        }
        "load_session_page" => {
            let a: LoadSessionPageArgs = parse_args(&raw)?;
            ser(crate::history::reader::load_session_page(
                app.state(),
                a.engine,
                a.session_id,
                a.limit,
                a.before_seq,
            )
            .await)
        }
        "load_remote_session_page" => {
            let a: LoadRemoteSessionPageArgs = parse_args(&raw)?;
            ser(crate::history::reader::load_remote_session_page(
                app.state(),
                a.workspace_path,
                a.engine,
                a.session_id,
                a.remote_path,
                a.limit,
                a.before_seq,
            )
            .await)
        }
        "delete_session" => {
            let a: EngineSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::delete_session(app.state(), a.engine, a.session_id).await)
        }
        "delete_remote_session" => {
            let a: DeleteRemoteSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::delete_remote_session(
                app.state(),
                a.workspace_path,
                a.engine,
                a.session_id,
                a.remote_path,
            )
            .await)
        }
        "pin_session" => {
            let a: PinSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::pin_session(
                app.state(),
                a.engine,
                a.session_id,
                a.pinned,
            ))
        }
        "rename_session" => {
            let a: RenameSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::rename_session(
                app.state(),
                a.engine,
                a.session_id,
                a.title,
            ))
        }
        "remember_session_model" => {
            let a: RememberModelArgs = parse_args(&raw)?;
            ser(crate::history::reader::remember_session_model(
                app.state(),
                a.engine,
                a.session_id,
                a.model,
            ))
        }
        "add_workspace" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::history::reader::add_workspace(
                app.state(),
                a.path,
                a.meta,
                a.kind,
                a.parent_id,
            ))
        }
        "plugin_add_workspace" => {
            let a: PluginAddWorkspaceArgs = parse_args(&raw)?;
            ser(
                crate::plugin_caps::plugin_add_workspace(app.state(), a.plugin_id, a.path, a.meta)
                    .await,
            )
        }
        "remember_session_effort" => {
            let a: RememberEffortArgs = parse_args(&raw)?;
            ser(crate::history::reader::remember_session_effort(
                app.state(),
                a.engine,
                a.session_id,
                a.effort,
            ))
        }
        "remember_session_provider" => {
            let a: RememberProviderArgs = parse_args(&raw)?;
            ser(crate::history::reader::remember_session_provider(
                app.state(),
                a.engine,
                a.session_id,
                a.provider_id,
            ))
        }
        "rescan_sessions" => {
            crate::history::reader::rescan_sessions(app.state());
            Ok(Value::Null)
        }
        "record_accepted_internal_frame" => {
            let a: RecordAcceptedFrameArgs = parse_args(&raw)?;
            ser(crate::history::reader::record_accepted_internal_frame(
                app.state(),
                a.engine,
                a.session_id,
                a.frame,
                a.workspace_path,
            )
            .await)
        }
        "list_workspaces" => ser(crate::history::reader::list_workspaces(app.state())),
        "reorder_workspaces" => {
            let a: IdsArgs = parse_args(&raw)?;
            ser(crate::history::reader::reorder_workspaces(
                app.state(),
                a.ids,
            ))
        }
        "remove_workspace" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::history::reader::remove_workspace(app.state(), a.id))
        }
        "set_workspace_group" => {
            let a: SetWorkspaceGroupArgs = parse_args(&raw)?;
            ser(crate::history::reader::set_workspace_group(
                app.state(),
                a.id,
                a.group_id,
            ))
        }
        // files
        "list_dir" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::list_dir(app.state(), a.path))
        }
        "read_file" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::read_file(app.state(), a.path).await)
        }
        "write_file" => {
            let a: WriteFileArgs = parse_args(&raw)?;
            ser(crate::files::write_file(app.state(), a.path, a.content))
        }
        "create_dir" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::create_dir(app.state(), a.path))
        }
        "create_file" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::create_file(app.state(), a.path))
        }
        "rename_item" => {
            let a: RenameItemArgs = parse_args(&raw)?;
            ser(crate::files::rename_item(app.state(), a.from, a.to))
        }
        "trash_item" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::trash_item(app.state(), a.path))
        }
        "duplicate_item" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::duplicate_item(app.state(), a.path))
        }
        "paste_item" => {
            let a: PasteItemArgs = parse_args(&raw)?;
            ser(crate::files::paste_item(
                app.state(),
                a.source,
                a.target_dir,
            ))
        }
        "search_text" => {
            let a: SearchTextArgs = parse_args(&raw)?;
            ser(crate::files::search_text(app.state(), a.path, a.query).await)
        }
        "search_messages" => {
            let a: SearchMessagesArgs = parse_args(&raw)?;
            ser(
                crate::history::search::search_messages(app.state(), a.query, a.limit, a.offset, a.scope)
                    .await,
            )
        }
        "list_file_index" => {
            let a: FileIndexArgs = parse_args(&raw)?;
            ser(crate::files::list_file_index(app.state(), a.path, a.include_ignored).await)
        }
        "list_slash_commands" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::slash_commands::list_slash_commands(app.state(), a.path).await)
        }
        // bots & prompts (composer `#`/`!` pickers)
        "bot_list" => ser(crate::bots::bot_list().await),
        "bot_create" => {
            let a: BotCreateArgs = parse_args(&raw)?;
            ser(crate::bots::bot_create(a.input).await)
        }
        "bot_update" => {
            let a: BotUpdateArgs = parse_args(&raw)?;
            ser(crate::bots::bot_update(a.id, a.patch).await)
        }
        "bot_delete" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::bots::bot_delete(app.state(), a.id).await)
        }
        "bot_duplicate" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::bots::bot_duplicate(a.id).await)
        }
        // 记忆（memory/mcp.rs）：写入错误保持结构化（JSON 字符串过桥），
        // 远程界面才能和桌面一致地本地化「超限 / 安全扫描」。
        "memory_list" => {
            let a: MemoryListArgs = parse_args(&raw)?;
            memory_ser(crate::memory::view(&app.state(), a.bot_id.as_deref()))
        }
        "memory_add" => {
            let a: MemoryAddArgs = parse_args(&raw)?;
            let target = crate::memory::Target::parse(&a.target)
                .map_err(|error| serde_json::to_string(&error).unwrap_or(error.message))?;
            memory_ser(
                crate::memory::add(&app.state(), target, a.bot_id.as_deref(), &a.content, "user")
                    .map(|(entry, _created)| entry),
            )
        }
        "memory_update" => {
            let a: MemoryUpdateArgs = parse_args(&raw)?;
            memory_ser(crate::memory::update(&app.state(), &a.id, &a.content))
        }
        "memory_remove" => {
            let a: IdArgs = parse_args(&raw)?;
            memory_ser(crate::memory::remove_by_id(&app.state(), &a.id))
        }
        "memory_clear" => {
            let a: MemoryClearArgs = parse_args(&raw)?;
            let target = crate::memory::Target::parse(&a.target)
                .map_err(|error| serde_json::to_string(&error).unwrap_or(error.message))?;
            memory_ser(crate::memory::clear(&app.state(), target, a.bot_id.as_deref()))
        }
        "memory_pending_approve" => {
            let a: IdArgs = parse_args(&raw)?;
            memory_ser(crate::memory::pending::approve(&app.state(), &a.id))
        }
        "memory_pending_reject" => {
            let a: IdArgs = parse_args(&raw)?;
            memory_ser(crate::memory::pending::reject(&app.state(), &a.id))
        }
        "memory_review" => {
            let a: MemoryReviewArgs = parse_args(&raw)?;
            let state = app.state();
            let outcome = crate::memory::review::review(
                &state,
                &a.bot_id,
                &a.engine,
                a.provider_id.as_deref(),
                a.model.as_deref(),
                &a.transcript,
            )
            .await;
            serde_json::to_value(outcome).map_err(|e| e.to_string())
        }
        // built-in agent catalog (agency-agents pack)
        "list_built_in_agents" => {
            let a: LocaleArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::list_built_in_agents(a.locale, app.clone()).await)
        }
        "set_built_in_agent_enabled" => {
            let a: BuiltInAgentEnabledArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::set_built_in_agent_enabled(
                a.agent_id,
                a.enabled,
                app.clone(),
            )
            .await)
        }
        "set_built_in_agent_division_enabled" => {
            let a: BuiltInAgentDivisionEnabledArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::set_built_in_agent_division_enabled(
                a.division_id,
                a.enabled,
                app.clone(),
            )
            .await)
        }
        "get_built_in_agent_prompt" => {
            let a: BuiltInAgentIdArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::get_built_in_agent_prompt(a.agent_id, app.clone()).await)
        }
        "resolve_enabled_built_in_agent" => {
            let a: BuiltInAgentIdArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::resolve_enabled_built_in_agent(a.agent_id, app.clone()).await)
        }
        "prompts_list" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_list(app.state(), a.path).await)
        }
        "prompts_dirs" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_dirs(app.state(), a.path).await)
        }
        "prompts_create" => {
            let a: PromptsCreateArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_create(
                app.state(),
                a.path,
                a.scope,
                a.name,
                a.description,
                a.argument_hint,
                a.content,
            )
            .await)
        }
        "prompts_update" => {
            let a: PromptUpdateArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_update(app.state(), a.path, a.prompt_path, a.updates).await)
        }
        "prompts_delete" => {
            let a: PromptPathArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_delete(app.state(), a.path, a.prompt_path).await)
        }
        "prompts_move" => {
            let a: PromptMoveArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_move(app.state(), a.path, a.prompt_path, a.scope).await)
        }
        // NB: grant_scope/grant_root/revoke_granted_root are intentionally
        // absent — remote clients must not widen the filesystem boundary.
        // git
        "git_status" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_status(a.path).await)
        }
        "git_repository_summaries" => {
            let a: PathsArgs = parse_args(&raw)?;
            ser(Ok(crate::git::git_repository_summaries(a.paths).await))
        }
        "git_file_colors" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_file_colors(a.path, a.files).await)
        }
        "git_tree_status" => {
            let a: GitTreeArgs = parse_args(&raw)?;
            ser(crate::git::git_tree_status(a.levels).await)
        }
        "git_diff" => {
            let a: GitDiffArgs = parse_args(&raw)?;
            ser(crate::git::git_diff(a.path, a.file, a.staged).await)
        }
        "git_stage" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_stage(a.path, a.files))
        }
        "git_unstage" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_unstage(a.path, a.files))
        }
        // Same shared changes panel as the desktop, so the remote client's
        // 「撤销更改」 must route too (it falls through to unknown otherwise).
        "git_discard" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_discard(a.path, a.files))
        }
        "git_commit" => {
            let a: GitCommitArgs = parse_args(&raw)?;
            ser(crate::git::git_commit(a.path, a.message))
        }
        "git_push" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_push(a.path).await)
        }
        "git_pull" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_pull(a.path).await)
        }
        "git_branches" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_branches(a.path))
        }
        "git_checkout" => {
            let a: GitCheckoutArgs = parse_args(&raw)?;
            ser(crate::git::git_checkout(a.path, a.branch))
        }
        "git_create_branch" => {
            let a: GitCreateBranchArgs = parse_args(&raw)?;
            ser(crate::git::git_create_branch(a.path, a.name))
        }
        // open-app
        "open_workspace_in" => {
            let a: OpenWorkspaceArgs = parse_args(&raw)?;
            ser(crate::open_app::open_workspace_in(a.path, a.app, a.args).await)
        }
        "open_custom_program" => {
            let a: OpenCustomProgramArgs = parse_args(&raw)?;
            ser(crate::open_app::open_custom_program(a.executable_path, a.path).await)
        }
        "get_program_icon" => {
            let a: GetProgramIconArgs = parse_args(&raw)?;
            ser(crate::open_app::get_program_icon(a.executable_path).await)
        }
        "reveal_in_file_manager" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::open_app::reveal_in_file_manager(a.path).await)
        }
        // terminal
        "terminal_open" => {
            let a: TerminalOpenArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_open(a.id, a.cwd, a.cols, a.rows, app.state()).await)
        }
        "terminal_write" => {
            let a: TerminalWriteArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_write(a.id, a.data, app.state()).await)
        }
        "terminal_resize" => {
            let a: TerminalResizeArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_resize(a.id, a.cols, a.rows, app.state()).await)
        }
        "terminal_close" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_close(a.id, app.state()).await)
        }
        // metrics
        "debug_snapshot" => Ok(super::debug::snapshot(app)),
        "debug_logs" => crate::diagnostics::query(&parse_args::<crate::diagnostics::LogQuery>(&raw)?),
        "app_metrics" => ser(crate::metrics::app_metrics(app.state())),
        "performance_diagnostics" => ser(crate::metrics::performance_diagnostics(app.state())),
        "performance_diagnostics_enabled" => {
            ser(crate::metrics::performance_diagnostics_enabled(app.state()))
        }
        "performance_diagnostics_set_enabled" => {
            let args: DiagnosticsEnabledArgs = parse_args(&raw)?;
            ser(crate::metrics::performance_diagnostics_set_enabled(
                args.enabled,
                app.state(),
                app.state(),
            ))
        }
        // web access: phones may read status; start/stop stay desktop-only.
        "web_access_status" => ser(Ok(web_access_status(app.clone()))),
        // The relay has no bootstrap problem (unlike the bridge, which cannot
        // start itself over itself), so an approved device may manage it too.
        "web_relay_status" => ser(Ok(crate::relay::web_relay_status(app.clone()))),
        "web_relay_start" => {
            let a: RelayArgs = parse_args(&raw)?;
            ser(crate::relay::web_relay_start(app.clone(), a.url, a.key).await)
        }
        "web_relay_stop" => ser(crate::relay::web_relay_stop(app.clone())),
        "relay_deploy_pack" => {
            let a: RelayDeployPackArgs = parse_args(&raw)?;
            ser(crate::relay::relay_deploy_pack(a.path, a.key))
        }
        "relay_deploy" => {
            let a: RelayDeployArgs = parse_args(&raw)?;
            ser(crate::relay::relay_deploy(a.token, a.account_id).await)
        }
        // Device approval is the one management action a phone may take: it
        // is already device-scoped, and the desktop page would otherwise be
        // the only way to approve a browser the user is holding.
        "web_devices" => ser(web_devices(app.clone())),
        "web_device_approve" => {
            let a: DeviceIdArgs = parse_args(&raw)?;
            ser(web_device_approve(app.clone(), a.id))
        }
        "web_device_revoke" => {
            let a: DeviceIdArgs = parse_args(&raw)?;
            ser(web_device_revoke(app.clone(), a.id))
        }
        // plugins (plan §9 risk table ruling): read-only commands ride the
        // bridge so web clients render plugin UI; install/uninstall/enable/
        // storage writes stay desktop-only and fall through to unknown.
        "plugin_list" => ser(crate::plugins::plugin_list(app.state()).await),
        "plugin_read_artwork" => {
            let a: PluginReadArtworkArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_read_artwork(a.id, a.path))
        }
        "plugin_read_file" => {
            let a: PluginReadFileArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_read_file(a.id, a.name))
        }
        "plugin_storage_get" => {
            let a: PluginStorageGetArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_storage_get(app.state(), a.id, a.key))
        }
        // Asset capabilities use the same authenticated bridge and the same
        // backend permission gates as desktop; they grant no general file
        // access, so unlike document-storage writes they are routed here.
        "plugin_asset_grant_directory" => {
            let a: PluginAssetPathArgs = parse_args(&raw)?;
            ser(crate::plugins::assets::plugin_asset_grant_directory(a.plugin_id, a.path).await)
        }
        "plugin_asset_list_directories" => {
            let a: PluginAssetIdArgs = parse_args(&raw)?;
            ser(crate::plugins::assets::plugin_asset_list_directories(a.plugin_id))
        }
        "plugin_asset_revoke_directory" => {
            let a: PluginAssetRevokeArgs = parse_args(&raw)?;
            ser(crate::plugins::assets::plugin_asset_revoke_directory(a.plugin_id, a.grant_id))
        }
        "plugin_reveal_path" => {
            let a: PluginAssetPathArgs = parse_args(&raw)?;
            ser(crate::plugins::assets::plugin_reveal_path(a.plugin_id, a.path).await)
        }
        // Marketplace browsing is read-only too, so the web client renders
        // the market page; plugin_install_from_marketplace stays desktop-only.
        "plugin_fetch_index" => ser(crate::plugins::market::plugin_fetch_index(false).await),
        "plugin_fetch_featured" => ser(crate::plugins::market::plugin_fetch_featured(false).await),
        "plugin_fetch_market_readme" => {
            let a: PluginIdArgs = parse_args(&raw)?;
            ser(crate::plugins::market::plugin_fetch_market_readme(a.id).await)
        }
        "plugin_check_updates" => ser(crate::plugins::market::plugin_check_updates().await),
        // Plan reviews are session state. The remote card lists them and
        // submits the same decision the desktop card does.
        "list_plan_reviews" => {
            let a: PlanReviewArgs = parse_args(&raw)?;
            ser(crate::engine::list_plan_reviews(app.state(), a.engine, a.session_id).await)
        }
        "respond_plan_review" => {
            let a: RespondPlanReviewArgs = parse_args(&raw)?;
            ser(crate::engine::respond_plan_review(
                app.state(),
                a.plan_id,
                a.expected_revision,
                a.decision,
                a.feedback,
            )
            .await)
        }
        // A remote-started computer-use run still executes on this desktop.
        // Arming Esc is the person-at-the-machine stop, not a browser window.
        "computer_use_set_active" => {
            let a: ActiveArgs = parse_args(&raw)?;
            ser(crate::computer_use::computer_use_set_active(app.clone(), a.active))
        }
        "computer_use_permission_status" => {
            ser(Ok(crate::computer_use::computer_use_permission_status()))
        }
        // Worktree dialogs operate on the executor's repos.
        "git_worktree_list" => {
            let a: RepoPathArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_worktree_list(a.repo_path).await)
        }
        "git_worktree_create" => {
            let a: GitWorktreeCreateCall = parse_args(&raw)?;
            ser(crate::git_worktree::git_worktree_create(
                app.clone(),
                app.state(),
                a.creation_id,
                a.args,
            )
            .await)
        }
        "git_worktree_create_cancel" => {
            let a: CreationIdArgs = parse_args(&raw)?;
            ser(Ok(crate::git_worktree::git_worktree_create_cancel(
                app.state(),
                a.creation_id,
            )))
        }
        "git_worktree_remove" => {
            let a: GitWorktreeRemoveArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_worktree_remove(
                a.repo_path,
                a.worktree_path,
                a.branch,
                a.delete_branch,
            )
            .await)
        }
        "git_branch_merged" => {
            let a: GitBranchMergedArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_branch_merged(a.repo_path, a.branch, a.base).await)
        }
        "git_resolve_pr" => {
            let a: GitResolvePrArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_resolve_pr(
                a.repo_path,
                a.input,
                a.suggested_branch,
                a.worktree_path,
            )
            .await)
        }
        // Mission nodes use the same engine pipeline as send_message.
        "mission_agent_start" => {
            let a: MissionStartArgs = parse_args(&raw)?;
            ser(crate::mission::mission_agent_start(
                app.clone(),
                a.engine,
                a.prompt,
                a.workspace_path,
                a.model,
                a.effort,
                a.provider_id,
                a.session_id,
                a.allowed_tools,
                a.run_id,
            )
            .await)
        }
        "mission_agent_interrupt" => {
            let a: MissionInterruptArgs = parse_args(&raw)?;
            ser(crate::mission::mission_agent_interrupt(app.clone(), a.run_id).await)
        }
        // Font bytes cross the JSON bridge. Callers pass a font-picker path.
        "read_font_file" => {
            let a: FontPathArgs = parse_args(&raw)?;
            ser(crate::fonts::read_font_file(a.path))
        }
        "web_device_rename" => {
            let a: DeviceRenameArgs = parse_args(&raw)?;
            ser(super::web_device_rename(app.clone(), a.id, a.name))
        }
        // The DSH host process lives on the executor. Settings drives it.
        "dsh_host_status" => ser(crate::dsh_host::dsh_host_status(app.state()).await),
        "dsh_host_start" => ser(crate::dsh_host::dsh_host_start(app.state()).await),
        "dsh_host_stop" => ser(crate::dsh_host::dsh_host_stop(app.state()).await),
        // Same trust class as upsert_provider. Keys stay in the redacted args.
        "pi_family_auth_list" => {
            let a: EngineOnlyArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_auth_list(a.engine))
        }
        "pi_family_auth_set_api_key" => {
            let a: PiKeyArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_auth_set_api_key(
                a.engine,
                a.provider_id,
                a.key,
            ))
        }
        "pi_family_auth_delete_credential" => {
            let a: PiProviderArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_auth_delete_credential(
                a.engine,
                a.provider_id,
            ))
        }
        "pi_family_models_config_read" => {
            let a: EngineOnlyArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_models_config_read(a.engine))
        }
        "pi_family_models_config_write" => {
            let a: PiModelsWriteArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_models_config_write(
                a.engine,
                a.text,
            ))
        }
        // Read of a registered workspace's facts for a plugin that already
        // holds workspace.metadata.read. Not a filesystem grant.
        "workspace_metadata" => {
            let a: WorkspaceMetadataArgs = parse_args(&raw)?;
            ser(crate::db::workspace_metadata(
                app.state(),
                a.plugin_id,
                a.workspace_path,
            ))
        }
        // The built-in creator skill is installed into the executor's engines.
        "creator_skill_install" => ser(Ok(crate::creator_skill::creator_skill_install(app.clone()))),
        _ => Err(format!("unknown command: {cmd}")),
    }
}

#[cfg(test)]
#[path = "dispatch_parity_test.rs"]
mod dispatch_parity_test;
