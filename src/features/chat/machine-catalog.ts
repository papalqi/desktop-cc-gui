import { useSyncExternalStore } from "react";
import type { SessionMeta, Workspace, WorkspaceGroup } from "@/lib/ipc";
import { queryMachine } from "@/lib/machine-bridge";
import { isWeb } from "@/lib/platform";
import { webMachine, webMultiMachine } from "@/lib/web-machine";
import { sessionKey } from "./store/persistence";
import { localProjectName } from "./session-display-name";

/** Sessions older than this are offered to the batch archive. */
export const ARCHIVE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const STORAGE_KEY = "ccgui.machineCatalog.v1";
/** Background refresh cadence. A switch paints whatever is already stored. */
const REFRESH_AFTER_MS = 60_000;

export type MachineCatalogSnapshot = {
  at: number;
  workspaces: Workspace[];
  sessions: SessionMeta[];
  workspaceGroups: WorkspaceGroup[];
  workspaceAliases: Record<string, string>;
  archivedWorkspaces: string[];
  threadLimit: number;
  /** `engine/sessionId` values `list_active_runs` reported for this desktop. */
  runningKeys?: string[];
};

export type CatalogLists = Omit<MachineCatalogSnapshot, "at">;

export type PinnedRow = {
  machine: string;
  session: SessionMeta;
  workspaceName: string;
};

type CatalogFile = Record<string, MachineCatalogSnapshot>;

let memory: CatalogFile = readStorage();
let snapshot: CatalogFile = memory;
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

function readStorage(): CatalogFile {
  if (webMultiMachine()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CatalogFile;
  } catch {
    return {};
  }
}

function emit(): void {
  snapshot = memory;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Quota or private mode: the in-memory copy still makes this visit fast.
  }
  for (const listener of listeners) listener();
}

export function currentRelayMachine(): string | null {
  return isWeb ? webMachine() : null;
}

export function readMachineCatalog(machine: string): MachineCatalogSnapshot | null {
  if (webMultiMachine()) return null;
  return memory[machine] ?? null;
}

/** Drop a reply that started before a newer catalog was stored. */
export function writeMachineCatalog(
  machine: string,
  lists: CatalogLists,
  startedAt: number,
): boolean {
  if (webMultiMachine()) return false;
  const previous = memory[machine];
  if (previous && previous.at > startedAt) return false;
  memory = {
    ...memory,
    [machine]: {
      ...lists,
      sessions: lists.sessions.map(stripSession),
      runningKeys: lists.runningKeys ?? [],
      at: Date.now(),
    },
  };
  emit();
  return true;
}

export function publishMachineCatalog(machine: string, lists: CatalogLists): void {
  writeMachineCatalog(machine, lists, Date.now());
}

export function patchCachedPin(
  machine: string,
  engine: string,
  sessionId: string,
  pinned: boolean,
): void {
  const current = memory[machine];
  if (!current) return;
  memory = {
    ...memory,
    [machine]: {
      ...current,
      at: Date.now(),
      sessions: current.sessions.map((session) =>
        session.engine === engine && session.sessionId === sessionId
          ? { ...session, pinned }
          : session,
      ),
    },
  };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMachineCatalogMap(): CatalogFile {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function sessionStamp(session: SessionMeta): number {
  return session.updatedAt ?? session.createdAt ?? session.fileMtimeMs ?? 0;
}

/** Unpinned, idle sessions whose last activity is strictly before `beforeMs`. */
export function sessionsToArchive(
  sessions: readonly SessionMeta[],
  beforeMs: number,
  running: ReadonlySet<string>,
): SessionMeta[] {
  return sessions.filter((session) => {
    if (session.pinned) return false;
    if (!session.engine || !session.sessionId || !session.workspacePath) return false;
    const when = sessionStamp(session);
    if (when <= 0 || when >= beforeMs) return false;
    return !running.has(sessionKey(session.engine, session.sessionId, session.workspacePath, session.machine));
  });
}

/** Workspace paths plus session ids. Two replies with the same print came
 *  from one desktop, which happens when the relay ignores `?machine=`. */
export function catalogFingerprint(lists: CatalogLists): string {
  const paths = lists.workspaces.map((workspace) => workspace.path).sort().join("\n");
  const ids = lists.sessions.map((session) => `${session.engine}/${session.sessionId}`).sort().join("\n");
  const running = [...(lists.runningKeys ?? [])].sort().join("\n");
  return `${paths}\n--\n${ids}\n--\n${running}`;
}

/** Session ids still present in a desktop's process table. */
export function runningKeysFrom(runs: unknown): string[] {
  if (!Array.isArray(runs)) return [];
  const keys: string[] = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const engine = (run as { engine?: unknown }).engine;
    const sessionId = (run as { sessionId?: unknown }).sessionId;
    if (typeof engine !== "string" || !engine || typeof sessionId !== "string" || !sessionId) continue;
    keys.push(`${engine}/${sessionId}`);
  }
  return keys;
}

/** `engine/sessionId` keys the page still has marked running. */
export function runningKeysFromFlags(flags: Record<string, unknown> | undefined): string[] {
  if (!flags) return [];
  return Object.entries(flags)
    .filter(([, on]) => on)
    .map(([key]) => key);
}

export function catalogSessionRunning(
  keys: readonly string[] | undefined,
  engine: string,
  sessionId: string,
): boolean {
  return Boolean(keys?.includes(`${engine}/${sessionId}`));
}

function workspaceName(workspaces: readonly Workspace[], path: string, aliases: Record<string, string>): string {
  const workspace = workspaces.find((item) => item.path === path);
  return localProjectName({
    alias: workspace ? aliases[workspace.id] : undefined,
    workspaceName: workspace?.name,
    workspacePath: path,
  });
}

/** Pinned sessions from every machine that already has a catalog, newest first. */
export function collectPinnedRows(catalogs: CatalogFile, order: readonly string[]): PinnedRow[] {
  const rows: PinnedRow[] = [];
  const seen = new Set<string>();
  const names = [...order, ...Object.keys(catalogs)];
  for (const machine of names) {
    if (seen.has(machine)) continue;
    seen.add(machine);
    const catalog = catalogs[machine];
    if (!catalog) continue;
    for (const session of catalog.sessions) {
      if (!session.pinned) continue;
      rows.push({
        machine,
        session,
        workspaceName: workspaceName(catalog.workspaces, session.workspacePath, catalog.workspaceAliases),
      });
    }
  }
  rows.sort((a, b) => sessionStamp(b.session) - sessionStamp(a.session));
  return rows;
}

function stripSession(session: SessionMeta): SessionMeta {
  return session.preview ? { ...session, preview: "" } : session;
}

export function listsFromState(state: CatalogLists): CatalogLists {
  return {
    workspaces: state.workspaces,
    sessions: state.sessions.map(stripSession),
    workspaceGroups: state.workspaceGroups,
    workspaceAliases: state.workspaceAliases,
    archivedWorkspaces: state.archivedWorkspaces,
    threadLimit: state.threadLimit,
    runningKeys: state.runningKeys ?? [],
  };
}

type SettingsSlice = {
  workspaceGroups?: WorkspaceGroup[];
  workspaceAliases?: Record<string, string>;
  archivedWorkspaces?: string[];
  sidebarThreadLimit?: number;
};

function snapshotFromReplies(
  workspaces: Workspace[],
  sessions: SessionMeta[],
  settings: SettingsSlice | null,
  runs: unknown,
): CatalogLists {
  return {
    workspaces,
    sessions: sessions.map(stripSession),
    workspaceGroups: settings?.workspaceGroups ?? [],
    workspaceAliases: settings?.workspaceAliases ?? {},
    archivedWorkspaces: settings?.archivedWorkspaces ?? [],
    threadLimit: settings?.sidebarThreadLimit ?? 5,
    runningKeys: runningKeysFrom(runs),
  };
}

export function prefetchMachineCatalog(machine: string, sameAs?: string | null): Promise<void> {
  if (webMultiMachine()) return Promise.resolve();
  const existing = inflight.get(machine);
  if (existing) return existing;
  const startedAt = Date.now();
  const job = queryMachine(machine, async (invoke) => {
    const [workspaces, sessions, settings, runs] = await Promise.all([
      invoke<Workspace[]>("list_workspaces"),
      invoke<SessionMeta[]>("list_sessions"),
      invoke<SettingsSlice>("get_app_settings"),
      invoke<unknown>("list_active_runs").then(
        (value) => ({ known: true as const, value }),
        () => ({ known: false as const, value: [] as unknown }),
      ),
    ]);
    const lists = snapshotFromReplies(workspaces, sessions, settings, runs.known ? runs.value : []);
    // An older desktop has no process table command. Wiping the keys noted
    // when this page left that machine would show a live turn as stopped.
    if (!runs.known) lists.runningKeys = readMachineCatalog(machine)?.runningKeys ?? [];
    return lists;
  })
    .then((lists) => {
      // A socket that ignored `?machine=` answers with the page's desktop.
      // Storing that under another name would paint the wrong workspaces.
      if (sameAs && catalogFingerprint(lists) === sameAs) return;
      writeMachineCatalog(machine, lists, startedAt);
    })
    .catch(() => {
      // Keep the previous snapshot. The switch still reads it, or loads live.
    })
    .finally(() => {
      inflight.delete(machine);
    });
  inflight.set(machine, job);
  return job;
}

/** Test hook. Production code does not call this. */
export function resetMachineCatalogsForTests(): void {
  memory = {};
  snapshot = memory;
  inflight.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The in-memory map is already empty.
  }
  for (const listener of listeners) listener();
}

export function catalogIsFresh(machine: string): boolean {
  const cached = memory[machine];
  return Boolean(cached && Date.now() - cached.at < REFRESH_AFTER_MS);
}
