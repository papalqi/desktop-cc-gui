//! Frontend `invoke("command")` literals must be routed or listed here.
//! The lists are read from source at test time so a new call site fails
//! this test instead of shipping as `unknown command`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Host-only commands. Each reason says why a browser must not send it.
const DESKTOP_ONLY: &[(&str, &str)] = &[
    (
        "set_window_theme",
        "sets the native webview theme; a browser only toggles the document class",
    ),
    (
        "remote_control_active",
        "desktop badge that another browser is driving this machine",
    ),
    (
        "computer_use_open_permission_settings",
        "opens a macOS System Settings privacy pane",
    ),
    ("restart_app", "restarts the native application"),
    ("browser_create", "creates a native child webview"),
    ("browser_close", "closes a native child webview"),
    ("browser_set_bounds", "positions a native child webview"),
    (
        "browser_set_visible",
        "shows or hides a native child webview",
    ),
    ("browser_navigate", "navigates a native child webview"),
    ("browser_go_back", "native child webview history"),
    ("browser_go_forward", "native child webview history"),
    ("browser_reload", "reloads a native child webview"),
    ("browser_current_url", "reads a native child webview url"),
    ("pet_list", "desktop pet overlay catalog"),
    ("pet_import", "imports a desktop pet package"),
    ("pet_remove", "removes a desktop pet package"),
    (
        "pet_get_package",
        "reads a desktop pet package for the overlay window",
    ),
    ("pet_set_visible", "shows the native pet overlay window"),
    ("pet_set_scale", "scales the native pet overlay window"),
    ("pet_set_state", "publishes state to the native pet overlay"),
    (
        "pet_save_position",
        "stores the native pet overlay position",
    ),
    ("plugin_window_state", "native plugin window geometry"),
    (
        "plugin_window_set_normal_bounds",
        "native plugin window geometry",
    ),
    ("plugin_window_sample_wechat", "samples a native window"),
    (
        "grant_root",
        "widens the filesystem grant boundary; a remote client must not",
    ),
    (
        "grant_scope",
        "resolves a filesystem grant; a remote client must not",
    ),
    (
        "list_granted_roots",
        "lists filesystem grants; the web settings page hides them",
    ),
    (
        "revoke_granted_root",
        "revokes a filesystem grant; a remote client must not",
    ),
    (
        "rotate_web_pair_key",
        "rotating the pairing key from a phone locks the other devices out",
    ),
    ("web_access_start", "starts the desktop LAN bridge"),
    ("web_access_stop", "stops the desktop LAN bridge"),
    (
        "web_access_rotate_token",
        "rotates the desktop LAN bridge token",
    ),
    (
        "web_access_available_ips",
        "lists desktop LAN addresses for the bridge",
    ),
    (
        "mcp_inventory",
        "MCP config lives in host files; the web page shows a desktop-only notice",
    ),
    (
        "mcp_probe",
        "MCP probes run on the host; the web page shows a desktop-only notice",
    ),
    ("mcp_set_enabled", "MCP writes stay on the desktop"),
    (
        "skills_hub_query",
        "skills hub reads host skill files; the web page shows a desktop-only notice",
    ),
    (
        "skills_hub_mutate",
        "skills hub writes host skill files; the web page shows a desktop-only notice",
    ),
    (
        "plugin_install_from_path",
        "installing a plugin writes the host plugin directory",
    ),
    (
        "plugin_install_from_marketplace",
        "installing a plugin writes the host plugin directory",
    ),
    (
        "plugin_uninstall",
        "uninstalling a plugin writes the host plugin directory",
    ),
    (
        "plugin_set_enabled",
        "enabling a plugin is a host install change",
    ),
    ("plugin_quarantine", "quarantine is a host install change"),
    (
        "plugin_storage_set",
        "plugin storage writes stay on the desktop",
    ),
    (
        "plugin_storage_delete",
        "plugin storage writes stay on the desktop",
    ),
    (
        "plugin_document_storage_get_location",
        "document storage is a host directory the bridge does not expose",
    ),
    (
        "plugin_document_storage_select_location",
        "document storage selection opens a host directory picker",
    ),
    (
        "plugin_document_storage_read_text",
        "document storage reads stay on the desktop",
    ),
    (
        "plugin_document_storage_write_text_atomic",
        "document storage writes stay on the desktop",
    ),
    (
        "plugin_document_storage_remove",
        "document storage writes stay on the desktop",
    ),
    (
        "plugin_document_storage_list",
        "document storage listing stays on the desktop",
    ),
    (
        "relay_update_blackout",
        "the relay update notice returns before invoking on the web",
    ),
    ("load_baidu_tongji_script", "Linux native analytics script"),
    ("send_baidu_tongji_beacon", "Linux native analytics beacon"),
    (
        "fetch_latest_release_info",
        "desktop update check; the web shell has nothing to update",
    ),
];

/// Answered by the hub, not by executor `dispatch`.
const HUB_ONLY: &[(&str, &str)] = &[
    (
        "get_run_delivery",
        "answered by the hub via queryMachine, not executor dispatch",
    ),
    (
        "close_unreceived_run",
        "answered by the hub via queryMachine, not executor dispatch",
    ),
];

#[test]
fn unknown_command_is_recorded_once_per_process() {
    assert!(super::note_unknown_command("parity_probe_once"));
    assert!(!super::note_unknown_command("parity_probe_once"));
    assert!(super::note_unknown_command("parity_probe_other"));
}

#[test]
fn frontend_invokes_are_routed_or_explicitly_desktop_only() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut frontend = BTreeSet::new();
    for dir in ["src", "packages"] {
        collect_invokes(&root.join(dir), &mut frontend);
    }
    let dispatch = std::fs::read_to_string(root.join("src-tauri/src/web/dispatch.rs"))
        .expect("read dispatch.rs");
    let routed = routed_commands(&dispatch);
    let desktop = reason_map(DESKTOP_ONLY);
    let hub = reason_map(HUB_ONLY);

    let mut unclassified = Vec::new();
    let mut overlap = Vec::new();
    for command in &frontend {
        let in_route = routed.contains(command);
        let in_desktop = desktop.contains_key(command);
        let in_hub = hub.contains_key(command);
        let classes = usize::from(in_route) + usize::from(in_desktop) + usize::from(in_hub);
        if classes == 0 {
            unclassified.push(command.clone());
        } else if classes > 1 {
            overlap.push(command.clone());
        }
    }
    let stale_desktop: Vec<_> = desktop
        .keys()
        .filter(|command| !frontend.contains(*command))
        .cloned()
        .collect();
    let stale_hub: Vec<_> = hub
        .keys()
        .filter(|command| !frontend.contains(*command))
        .cloned()
        .collect();
    let hub_routed: Vec<_> = hub
        .keys()
        .filter(|command| routed.contains(*command))
        .cloned()
        .collect();

    assert!(
        unclassified.is_empty() && overlap.is_empty() && stale_desktop.is_empty() && stale_hub.is_empty() && hub_routed.is_empty(),
        "unclassified={unclassified:?}\noverlap={overlap:?}\nstale_desktop={stale_desktop:?}\nstale_hub={stale_hub:?}\nhub_routed={hub_routed:?}"
    );

    // Plugin hosts can pass a runtime command name. A static scan cannot see
    // those, so keep the call shape recognizable.
    let loader = std::fs::read_to_string(root.join("src/features/plugins/runtime/loader.ts"))
        .expect("read loader");
    assert!(
        loader.contains("bridgeInvoke: (command, args) => invoke(command, args)"),
        "dynamic plugin bridgeInvoke changed; classify those commands explicitly"
    );
}

fn reason_map(rows: &[(&str, &str)]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for (command, reason) in rows {
        assert!(!command.is_empty(), "empty command");
        assert!(!reason.trim().is_empty(), "missing reason for {command}");
        assert!(
            map.insert((*command).to_string(), (*reason).to_string())
                .is_none(),
            "duplicate {command}"
        );
    }
    map
}

fn collect_invokes(dir: &Path, found: &mut BTreeSet<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "node_modules" || name == "dist" || name == "target" || name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_invokes(&path, found);
            continue;
        }
        if name.contains(".test.") || name.contains(".spec.") {
            continue;
        }
        let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if !matches!(ext, "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        for command in invoke_literals(&source) {
            found.insert(command);
        }
    }
}

fn invoke_literals(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut names = Vec::new();
    let mut i = 0;
    while i + 6 < bytes.len() {
        if bytes[i..].starts_with(b"invoke") {
            let boundary = i == 0 || {
                let prev = bytes[i - 1];
                !prev.is_ascii_alphanumeric() && prev != b'_'
            };
            if boundary {
                if let Some(name) = invoke_literal_at(source, i) {
                    names.push(name);
                }
            }
        }
        i += 1;
    }
    names
}

fn invoke_literal_at(source: &str, start: usize) -> Option<String> {
    let bytes = source.as_bytes();
    let mut j = start + "invoke".len();
    if j < bytes.len() && bytes[j] == b'<' {
        let rest = source.get(j..)?;
        let end = rest.find('>')?;
        if rest[..end].contains('\n') {
            return None;
        }
        j += end + 1;
    }
    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
        j += 1;
    }
    if j >= bytes.len() || bytes[j] != b'(' {
        return None;
    }
    j += 1;
    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
        j += 1;
    }
    quoted_ident(source.get(j..)?)
}

fn quoted_ident(source: &str) -> Option<String> {
    let bytes = source.as_bytes();
    if bytes.is_empty() || !matches!(bytes[0], b'"' | b'\'' | b'`') {
        return None;
    }
    let quote = bytes[0];
    let mut j = 1;
    let start = j;
    while j < bytes.len() && bytes[j] != quote && bytes[j] != b'\n' {
        let ch = bytes[j] as char;
        if !ch.is_ascii_alphanumeric() && ch != '_' {
            return None;
        }
        j += 1;
    }
    if j >= bytes.len() || bytes[j] != quote || start == j {
        return None;
    }
    Some(source[start..j].to_string())
}

fn routed_commands(source: &str) -> BTreeSet<String> {
    let bytes = source.as_bytes();
    let mut found = BTreeSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if matches!(bytes[i], b'"' | b'\'') {
            if let Some(name) = quoted_ident(source.get(i..).unwrap_or("")) {
                let mut k = i + name.len() + 2;
                while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k + 1 < bytes.len() && bytes[k] == b'=' && bytes[k + 1] == b'>' {
                    found.insert(name);
                }
            }
        }
        i += 1;
    }
    let mut rest = source;
    while let Some(pos) = rest.find("cmd ==") {
        rest = &rest[pos + "cmd ==".len()..];
        let trimmed = rest.trim_start();
        if let Some(name) = quoted_ident(trimmed) {
            found.insert(name);
        }
    }
    found
}
