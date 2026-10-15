import { readStoredJson, writeStored } from "@/lib/storage";
import type { EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { setWebSessionRoute, webMachine, webMultiMachine } from "@/lib/web-machine";

/**
 * Tab/active-session persistence (localStorage) plus the session-key helpers
 * every chat module shares. Leaf module: no store imports, so stream and
 * engine-events can both build on it without cycles.
 */

export interface ActiveSession {
  machine?: string;
  engine: string;
  /** null => not yet created (first message not sent) */
  sessionId: string | null;
  workspacePath: string;
  /** Per-tab model override; undefined => follow the engine's global default. */
  model?: string;
  /** Per-tab effort override; undefined => follow the engine's global default. */
  effort?: EffortLevel;
  /** Per-tab channel override; undefined => follow the engine's `current`.
   *  Only a pending (sessionId === null) tab may carry this; native sessions
   *  own the channel in SessionState / session_providers. */
  provider?: string;
}

export function sessionKey(
  engine: string,
  sessionId: string | null,
  workspacePath: string,
  machine?: string,
) {
  const key = sessionId
    ? `${engine}/${sessionId}`
    : `new:${engine}:${workspacePath}`;
  return machine ? `${encodeURIComponent(machine)}/${key}` : key;
}

export function parseSessionKey(key: string): { machine?: string; engine: string; sessionId: string } | null {
  const parts = key.split("/");
  if (parts.length < 2 || key.startsWith("new:") || parts[1].startsWith("new:")) return null;
  if (parts.length === 2 || !webMultiMachine()) return { engine: parts[0], sessionId: parts.slice(1).join("/") };
  try { return { machine: decodeURIComponent(parts[0]), engine: parts[1], sessionId: parts.slice(2).join("/") }; }
  catch { return null; }
}

/** `sessionKey` 待发键的逆：插件轮次（ctx.sessions.startRun）不占标签页，
 *  会话事件里的工作区只能从路由键取（见 engine-events onSession）。非待发
 *  键返回 ""，调用方继续走原来的回落。 */
export function pendingWorkspaceOfKey(engine: string, key: string): string {
  const draft = parseDraftSessionKey(key);
  return draft?.engine === engine ? draft.workspacePath : "";
}

/** Inverse of `sessionKey` for pending (never-sent) tabs. */
export function parseDraftSessionKey(
  key: string,
): { machine?: string; engine: string; workspacePath: string } | null {
  let machine: string | undefined;
  if (!key.startsWith("new:")) {
    const slash = key.indexOf("/");
    if (slash < 1 || !key.slice(slash + 1).startsWith("new:")) return null;
    try { machine = decodeURIComponent(key.slice(0, slash)); } catch { return null; }
    key = key.slice(slash + 1);
  }
  const rest = key.slice(4);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  return { ...(machine ? { machine } : {}), engine: rest.slice(0, colon), workspacePath: rest.slice(colon + 1) };
}

export const OPEN_TABS_KEY = "ccgui-next.openTabs:v1";
const ACTIVE_SESSION_KEY = "ccgui-next.activeSession:v1";
const LEGACY_OPEN_TABS_KEY = "ccgui-next.openTabs";
const LEGACY_ACTIVE_SESSION_KEY = "ccgui-next.activeSession";
export const ENGINE_PREF_KEY = "ccgui-next.enginePref";
export const PERMISSION_PREF_KEY = "ccgui-next.permissionPref";

export function sameTab(
  tab: ActiveSession,
  engine: string,
  sessionId: string | null,
  workspacePath: string,
  machine?: string,
) {
  return (
    tab.engine === engine &&
    tab.sessionId === sessionId &&
    tab.workspacePath === workspacePath && tab.machine === machine
  );
}
/** Drop duplicate tabs (same engine+sessionId+workspacePath), keeping the
 * first occurrence. Duplicates render with identical React keys and break
 * the tab strip's reconciliation. */
export function dedupeTabs(tabs: ActiveSession[]): ActiveSession[] {
  const out: ActiveSession[] = [];
  for (const tab of tabs) {
    if (
      out.some((t) => sameTab(t, tab.engine, tab.sessionId, tab.workspacePath, tab.machine))
    )
      continue;
    out.push(tab);
  }
  return out;
}

/** Relay browser: each desktop keeps its own tabs. */
function relayTabScope(): string {
  if (webMultiMachine()) return ":global";
  const name = webMachine();
  return name ? `:${name}` : "";
}

const UNSEEN_KEY = "ccgui-next.unseen:v1";

export function readPersistedUnseen(): Record<string, boolean> {
  const value = readStoredJson<unknown>(UNSEEN_KEY + relayTabScope(), (value) => value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, unread]) => unread === true).slice(-1000));
}

export function persistUnseen(unseen: Record<string, boolean>): void {
  writeStored(UNSEEN_KEY + relayTabScope(), JSON.stringify(Object.fromEntries(
    Object.entries(unseen).filter(([, unread]) => unread === true).slice(-1000),
  )));
}

const TABS_SCOPED_FLAG = "ccgui-next.tabsScoped:v1";

export function persistTabs(
  openTabs: ActiveSession[],
  active: ActiveSession | null,
) {
  const scope = relayTabScope();
  setWebSessionRoute(active);
  writeStored(OPEN_TABS_KEY + scope, JSON.stringify(openTabs));
  const activeKey = ACTIVE_SESSION_KEY + scope;
  if (active) writeStored(activeKey, JSON.stringify(active));
  else localStorage.removeItem(activeKey);
}

/** Read a persisted JSON value, migrating the pre-versioned key on first read. */
function readPersistedValue<T>(
  key: string,
  legacyKey: string,
  validate: (value: unknown) => T | null,
): T | null {
  const current = readStoredJson(key, validate);
  if (current !== null) return current;
  const legacy = readStoredJson(legacyKey, validate);
  if (legacy === null) return null;
  // One-time migration: the validated legacy value moves to the versioned key.
  writeStored(key, JSON.stringify(legacy));
  localStorage.removeItem(legacyKey);
  return legacy;
}

function isActiveSession(t: unknown): t is ActiveSession {
  const tab = t as ActiveSession;
  return (
    !!tab &&
    typeof tab.engine === "string" &&
    (tab.machine === undefined || typeof tab.machine === "string") &&
    typeof tab.workspacePath === "string" &&
    (tab.sessionId === null || typeof tab.sessionId === "string") &&
    (tab.model === undefined || typeof tab.model === "string") &&
    (tab.effort === undefined || typeof tab.effort === "string") &&
    (tab.provider === undefined || typeof tab.provider === "string")
  );
}

function readScopedOrLegacy<T>(
  key: string,
  legacyKey: string,
  validate: (value: unknown) => T | null,
): T | null {
  const scope = relayTabScope();
  if (!scope) return readPersistedValue(key, legacyKey, validate);
  const scoped = readStoredJson(key + scope, validate);
  if (scoped !== null) return scoped;
  // The unscoped list belongs to whichever machine was open when scoping
  // started. Later machines start empty instead of inheriting it.
  if (localStorage.getItem(TABS_SCOPED_FLAG)) return null;
  const legacy = readPersistedValue(key, legacyKey, validate);
  if (legacy !== null) writeStored(key + scope, JSON.stringify(legacy));
  localStorage.setItem(TABS_SCOPED_FLAG, scope);
  return legacy;
}

export function readPersistedTabs(): ActiveSession[] {
  if (webMultiMachine()) {
    const stored = readStoredJson(OPEN_TABS_KEY + ":global", (raw) => Array.isArray(raw) ? raw.filter(isActiveSession) : null);
    if (stored !== null) return dedupeTabs(stored);
    const machine = webMachine();
    if (!machine) return [];
    const legacy = readStoredJson(OPEN_TABS_KEY + ":" + machine, (raw) => Array.isArray(raw) ? raw.filter(isActiveSession) : null) ?? [];
    return dedupeTabs(legacy.map((tab) => ({ ...tab, machine })));
  }
  return dedupeTabs(
    readScopedOrLegacy(OPEN_TABS_KEY, LEGACY_OPEN_TABS_KEY, (raw) =>
      Array.isArray(raw) ? raw.filter(isActiveSession) : null,
    ) ?? [],
  );
}

export function readPersistedActive(): ActiveSession | null {
  if (webMultiMachine()) {
    const stored = readStoredJson(ACTIVE_SESSION_KEY + ":global", (raw) => isActiveSession(raw) ? raw : null);
    if (stored !== null || localStorage.getItem(OPEN_TABS_KEY + ":global") !== null) return stored;
    const machine = webMachine();
    if (!machine) return null;
    const legacy = readStoredJson(ACTIVE_SESSION_KEY + ":" + machine, (raw) => isActiveSession(raw) ? raw : null);
    return legacy ? { ...legacy, machine } : null;
  }
  return readScopedOrLegacy(ACTIVE_SESSION_KEY, LEGACY_ACTIVE_SESSION_KEY, (raw) =>
    isActiveSession(raw) ? raw : null,
  );
}
