import { useEffect, useSyncExternalStore } from "react";
import { isWeb, listen, subscribeWebBridgeState, webBridgeFeature } from "@/lib/transport";
import { webPublicPrefix } from "@/lib/web-public-prefix";

const SEED_EVERY_MS = 60_000;
const INVOKE_TIMEOUT_MS = 8_000;
const RETRY_MAX_MS = 30_000;

/** Session key → run ids still talking on that desktop. */
export type RunTable = Map<string, Set<string>>;
const settledByTable = new WeakMap<RunTable, Set<string>>();

type WatchState = {
  stop: boolean;
  retryMs: number;
  ws: WebSocket | null;
  seedTimer: ReturnType<typeof setInterval> | null;
};

let heard: Record<string, RunTable | undefined> = {};
let snapshot: Record<string, readonly string[] | null> = {};
export type SessionActivity = { state: "running" | "awaiting-approval" | "awaiting-input"; updatedAt: number };
let activitySnapshot: Record<string, Record<string, SessionActivity>> = {};
const listeners = new Set<() => void>();
const sockets = new Map<string, WatchState>();

function emit(): void {
  for (const listener of listeners) listener();
}

function sameKeys(left: readonly string[] | null | undefined, right: readonly string[] | null): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function publish(machine: string): void {
  const table = heard[machine];
  const next = table ? runningKeysOf(table) : null;
  const activities = activitySnapshot[machine];
  const activityChanged = activities && Object.keys(activities).some((key) => !table?.has(key));
  if (sameKeys(snapshot[machine], next) && !activityChanged) return;
  snapshot = { ...snapshot, [machine]: next };
  if (activityChanged) activitySnapshot = { ...activitySnapshot, [machine]: Object.fromEntries(Object.entries(activities).filter(([key]) => table?.has(key))) };
  emit();
}

function tableFor(machine: string): RunTable {
  let table = heard[machine];
  if (!table) {
    table = new Map();
    heard[machine] = table;
  }
  return table;
}

export function runningKeysOf(table: RunTable): string[] {
  return [...table.keys()].sort();
}

export function seedRunTable(runs: unknown, previous?: RunTable): RunTable {
  const table: RunTable = new Map();
  const settled = (previous && settledByTable.get(previous)) ?? new Set<string>();
  settledByTable.set(table, settled);
  if (!Array.isArray(runs)) return table;
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const engine = (run as { engine?: unknown }).engine;
    const sessionId = (run as { sessionId?: unknown }).sessionId;
    if (typeof engine !== "string" || !engine || typeof sessionId !== "string" || !sessionId) continue;
    const key = `${engine}/${sessionId}`;
    const rawId = (run as { runId?: unknown }).runId;
    const runId = typeof rawId === "string" && rawId ? rawId : `seed:${key}`;
    if (settled.has(runId)) continue;
    let ids = table.get(key);
    if (!ids) {
      ids = new Set();
      table.set(key, ids);
    }
    ids.add(runId);
  }
  return table;
}

/** Fold one desktop's engine events into the run table. Returns whether a pin row would change. */
export function noteRunEvents(table: RunTable, events: unknown): boolean {
  if (!Array.isArray(events)) return false;
  let settled = settledByTable.get(table);
  if (!settled) settledByTable.set(table, settled = new Set());
  let changed = false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const kind = (event as { kind?: unknown }).kind;
    const engine = (event as { engine?: unknown }).engine;
    const sessionId = (event as { sessionId?: unknown }).sessionId;
    const runId = (event as { runId?: unknown }).runId;
    if (typeof kind !== "string" || typeof engine !== "string" || !engine) continue;
    if (typeof sessionId !== "string" || !sessionId || typeof runId !== "string" || !runId) continue;
    if (settled.has(runId)) continue;
    const key = `${engine}/${sessionId}`;
    if (kind === "done" || kind === "error") {
      settled.add(runId);
      if (settled.size > 256) settled.delete(settled.values().next().value!);
      const ids = table.get(key);
      if (!ids) continue;
      ids.delete(runId);
      ids.delete(`seed:${key}`);
      ids.delete(`page:${key}`);
      if (ids.size === 0) {
        table.delete(key);
        changed = true;
      }
      continue;
    }
    if (kind === "permission_denied") continue;
    let ids = table.get(key);
    if (!ids) {
      ids = new Set();
      table.set(key, ids);
      ids.add(runId);
      changed = true;
      continue;
    }
    ids.add(runId);
  }
  return changed;
}

/** Remember runs the page already saw, without dropping runs heard from the socket. */
export function noteMachineRunningKeys(machine: string, keys: readonly string[]): void {
  if (!machine || keys.length === 0) return;
  const table = tableFor(machine);
  let changed = false;
  for (const key of keys) {
    if (!key) continue;
    let ids = table.get(key);
    if (!ids) {
      ids = new Set();
      table.set(key, ids);
      changed = true;
    }
    const mark = `page:${key}`;
    if (!ids.has(mark)) {
      ids.add(mark);
      changed = true;
    }
  }
  if (changed) publish(machine);
}

export function watchedRunningKeys(machine: string): readonly string[] | null {
  return snapshot[machine] ?? null;
}

export function applyWatchedRunEvents(machine: string, events: unknown): void {
  if (!machine) return;
  if (noteRunEvents(tableFor(machine), events)) publish(machine);
}

/** The hub's `machines://status`: active runs of every machine on one socket.
 *  An offline machine keeps what was last heard, as a closed watcher did. */
export function applyMachineStatus(payload: unknown): void {
  const machines = payload && typeof payload === "object" ? (payload as { machines?: unknown }).machines : null;
  if (!Array.isArray(machines)) return;
  for (const machine of machines) {
    if (!machine || typeof machine !== "object") continue;
    const { name, online, runs } = machine as { name?: unknown; online?: unknown; runs?: unknown };
    if (typeof name !== "string" || !name || online !== true || !Array.isArray(runs)) continue;
    heard[name] = seedRunTable(runs, heard[name]);
    publish(name);
    const activities: Record<string, SessionActivity> = {};
    const priority = { running: 0, "awaiting-input": 1, "awaiting-approval": 2 };
    for (const run of runs) {
      if (!run || typeof run !== "object" || typeof run.engine !== "string" || !run.engine || typeof run.sessionId !== "string" || !run.sessionId) continue;
      const state: SessionActivity["state"] = run.state === "awaiting-approval" || run.state === "awaiting-input" ? run.state : "running";
      const key = `${run.engine}/${run.sessionId}`;
      const runId = typeof run.runId === "string" && run.runId ? run.runId : `seed:${key}`;
      if (!heard[name]?.get(key)?.has(runId)) continue;
      if (activities[key] && priority[activities[key].state] > priority[state]) continue;
      activities[key] = { state, updatedAt: typeof run.updatedAt === "number" ? run.updatedAt : 0 };
    }
    if (JSON.stringify(activitySnapshot[name]) !== JSON.stringify(activities)) {
      activitySnapshot = { ...activitySnapshot, [name]: activities };
      emit();
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWatchedRunningMap(): Record<string, readonly string[] | null> {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function watchedSessionActivities(): typeof activitySnapshot {
  return activitySnapshot;
}

export function useWatchedSessionActivities(): typeof activitySnapshot {
  return useSyncExternalStore(subscribe, watchedSessionActivities, watchedSessionActivities);
}

export function resetMachineRunWatchersForTests(): void {
  for (const state of sockets.values()) {
    state.stop = true;
    if (state.seedTimer !== null) clearInterval(state.seedTimer);
    state.ws?.close();
  }
  sockets.clear();
  heard = {};
  snapshot = {};
  activitySnapshot = {};
  emit();
}

export function machineWatchUrl(machine: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const prefix = webPublicPrefix(location.pathname);
  const token = new URLSearchParams(location.search).get("token") ?? "";
  return (
    `${proto}://${location.host}${prefix}/ws?token=${encodeURIComponent(token)}` +
    `&machine=${encodeURIComponent(machine)}`
  );
}

function decodeFrame(data: unknown): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
}

function connectWatcher(machine: string, state: WatchState): void {
  if (state.stop) return;
  const ws = new WebSocket(machineWatchUrl(machine));
  state.ws = ws;
  ws.binaryType = "arraybuffer";
  let hello = false;
  let nextId = 1;
  let seeding = false;
  const buffer: unknown[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const failPending = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const invoke = (cmd: string) =>
    new Promise<unknown>((resolve, reject) => {
      if (!hello || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("machine watch is not ready"));
        return;
      }
      const id = nextId++;
      const slow = setTimeout(() => {
        pending.delete(id);
        reject(new Error("machine watch timed out"));
      }, INVOKE_TIMEOUT_MS);
      pending.set(id, {
        resolve: (payload) => {
          clearTimeout(slow);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(slow);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ type: "invoke", id, cmd, args: {} }));
    });

  const seed = () => {
    if (state.stop || state.ws !== ws || seeding) return;
    seeding = true;
    void invoke("list_active_runs").then(
      (value) => {
        if (state.stop || state.ws !== ws) return;
        heard[machine] = seedRunTable(value, heard[machine]);
        seeding = false;
        for (const events of buffer.splice(0)) noteRunEvents(heard[machine]!, events);
        publish(machine);
      },
      () => {
        if (state.stop || state.ws !== ws) return;
        const table = tableFor(machine);
        seeding = false;
        for (const events of buffer.splice(0)) noteRunEvents(table, events);
        publish(machine);
      },
    );
  };

  ws.onmessage = (event) => {
    if (state.ws !== ws) return;
    let msg: { type?: string; id?: unknown; ok?: boolean; payload?: unknown; error?: unknown; name?: string };
    try {
      msg = JSON.parse(decodeFrame(event.data));
    } catch {
      return;
    }
    if (msg.type === "hello") {
      if (hello) return;
      hello = true;
      state.retryMs = 1000;
      seed();
      if (state.seedTimer !== null) clearInterval(state.seedTimer);
      state.seedTimer = setInterval(seed, SEED_EVERY_MS);
      return;
    }
    if (msg.type === "response") {
      const entry = pending.get(Number(msg.id));
      if (!entry) return;
      pending.delete(Number(msg.id));
      if (msg.ok) entry.resolve(msg.payload);
      else entry.reject(new Error(String(msg.error ?? "unknown error")));
      return;
    }
    if (msg.type === "event" && msg.name === "engine://event") {
      if (seeding) buffer.push(msg.payload);
      else applyWatchedRunEvents(machine, msg.payload);
    }
  };
  ws.onerror = () => {
    // onclose retries.
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.seedTimer !== null) {
      clearInterval(state.seedTimer);
      state.seedTimer = null;
    }
    failPending(new Error("machine watch closed"));
    if (state.stop) return;
    const delay = state.retryMs;
    state.retryMs = Math.min(state.retryMs * 2, RETRY_MAX_MS);
    setTimeout(() => connectWatcher(machine, state), delay);
  };
}

/** Keep a socket open to every connected desktop. The page socket stays where it is. */
export function syncMachineRunWatchers(names: readonly string[]): void {
  if (import.meta.env.VITEST) return;
  const want = new Set(names);
  for (const [name, state] of sockets) {
    if (want.has(name)) continue;
    state.stop = true;
    if (state.seedTimer !== null) clearInterval(state.seedTimer);
    state.ws?.close();
    sockets.delete(name);
  }
  for (const name of names) {
    if (!name || sockets.has(name)) continue;
    const state: WatchState = { stop: false, retryMs: 1000, ws: null, seedTimer: null };
    sockets.set(name, state);
    connectWatcher(name, state);
  }
}

function hubPushesStatus(): boolean {
  return webBridgeFeature("machines");
}

/** Listen to every desktop the relay currently has, whichever one the page is on.
 *  A hub that pushes machine status needs no socket per machine. */
export function useMachineRunWatchers(list: { names: readonly string[] } | null): void {
  const hubStatus = useSyncExternalStore(subscribeWebBridgeState, hubPushesStatus, () => false);
  const online = list?.names.join("\0") ?? "";
  const relay = list !== null;
  useEffect(() => {
    if (import.meta.env.VITEST) return;
    syncMachineRunWatchers(online && !hubStatus ? online.split("\0") : []);
  }, [online, hubStatus]);
  useEffect(() => {
    if (import.meta.env.VITEST || !isWeb || !relay) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    void listen<unknown>("machines://status", (event) => applyMachineStatus(event.payload)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [relay]);
  useEffect(() => {
    if (import.meta.env.VITEST) return;
    return () => syncMachineRunWatchers([]);
  }, []);
}
