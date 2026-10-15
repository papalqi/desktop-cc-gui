import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { bridgeRecovery, relayDesktopUp } from "./web-bridge-recovery";
import { webPublicPrefix } from "./web-public-prefix";
import { performanceRecorder } from "./performance-diagnostics";
import { setWebMachine, webMachine, webMultiMachine } from "./web-machine";
import i18n from "./i18n";

/**
 * Transport layer: identical invoke/listen surface as the Tauri IPC API, but
 * routed over the web-access WebSocket bridge when the app runs in a plain
 * browser (no __TAURI_INTERNALS__). See src-tauri/src/web.rs for the protocol.
 */
export const isWeb =
  typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

/** Token issued by the desktop on web-access start, carried in the URL. */
export const webToken: string | null = isWeb
  ? new URLSearchParams(window.location.search).get("token")
  : null;

type Listener = (payload: unknown, machine?: string) => void;

interface PendingReq {
  machine: string | null;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number | null;
  sent: boolean;
  historyTiming?: { startedAt: number; session: number };
}

const RETRY_MAX_MS = 10_000;
const LONG_COMMANDS = new Set(["add_workspace", "plugin_add_workspace", "read_file", "read_font_file", "plugin_read_file", "plugin_read_artwork", "rescan_sessions"]);
const GLOBAL_COMMANDS = new Set(["list_sessions", "list_archived_sessions", "list_workspaces", "list_active_runs", "get_app_settings", "update_app_settings", "search_messages"]);
const requestTimeout = (cmd: string) => cmd === "send_message" ? null : LONG_COMMANDS.has(cmd) || cmd.startsWith("git_") ? 120_000 : 30_000;
const HEARTBEAT_CHECK_MS = 5_000;
const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_DEADLINE_MS = 10_000;
/** A tab back from the background or a network change asks sooner. */
const RESUME_DEADLINE_MS = 5_000;
/** Pushed right after hello, before late subscribers exist; the latest replays to them. */
const STICKY_EVENTS = new Set(["machines://status"]);
let bridgeGeneration = 0;

/** `reconnecting` follows a connection that had said hello. A half-open
 *  socket only becomes `reconnecting` when the server answers pings. */
export type WebBridgeState = "connecting" | "open" | "reconnecting";
let bridgeState: WebBridgeState = "connecting";
const bridgeStateListeners = new Set<() => void>();

function setBridgeState(next: WebBridgeState): void {
  if (bridgeState === next) return;
  bridgeState = next;
  for (const listener of bridgeStateListeners) listener();
}

export function webBridgeState(): WebBridgeState {
  return bridgeState;
}

export function subscribeWebBridgeState(listener: () => void): () => void {
  bridgeStateListeners.add(listener);
  return () => {
    bridgeStateListeners.delete(listener);
  };
}

/** `sent` is false when the request never left this page, so it cannot have run. */
export class WebBridgeDisconnectedError extends Error {
  readonly sent: boolean;

  constructor(sent: boolean) {
    super("web bridge disconnected");
    this.sent = sent;
  }
}

export class WebBridgeTimeoutError extends Error {
  constructor(readonly command: string) {
    super(i18n.t("chat.webRequestTimeout", { command }));
  }
}

/** Identifies the connection that owns cached data and pending writes. */
export function webBridgeGeneration(): number {
  return bridgeGeneration;
}
/** Suppress a second reload for a short while, so a gate page cannot bounce. */
const BRIDGE_RELOAD_AT = "ccgui.bridgeGateReload";
const BRIDGE_RELOAD_COOLDOWN_MS = 15_000;

/** Show the relay login or pairing page. A missing sessionStorage skips the
 *  reload: without a cooldown the next close would bounce the SPA forever. */
function reloadForAccessGate(): void {
  try {
    const previous = Number(sessionStorage.getItem(BRIDGE_RELOAD_AT) || "0");
    if (Number.isFinite(previous) && Date.now() - previous < BRIDGE_RELOAD_COOLDOWN_MS) return;
    sessionStorage.setItem(BRIDGE_RELOAD_AT, String(Date.now()));
  } catch {
    return;
  }
  location.reload();
}

class WebBridge {
  private readonly page = window;
  private ws: WebSocket | null = null;
  private openGate: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingReq>();
  private listeners = new Map<string, Set<Listener>>();
  private retryMs = 1000;
  private versionValue: string | null = null;
  private versionWaiters: ((v: string | null) => void)[] = [];
  /** Hello on the attempt in progress. A previous connection does not count. */
  private helloSeen = false;
  private everOpen = false;
  private capabilityError: Error | null = null;
  private probeTimer: number | null = null;
  private retryTimer: number | null = null;
  /** Hello features of the current connection; `ping` enables the heartbeat. */
  private features = new Set<string>();
  private heartbeat: number | null = null;
  private pingDeadline: number | null = null;
  private lastFrameAt = 0;
  private sticky = new Map<string, unknown>();

  constructor() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.probeLiveness();
    });
    window.addEventListener("online", () => this.probeLiveness());
  }

  private pageGone(): boolean {
    if (typeof window !== "undefined" && window === this.page && this.page.document) return false;
    this.stopHeartbeat();
    if (this.retryTimer !== null) this.page.clearTimeout(this.retryTimer);
    if (this.probeTimer !== null) this.page.clearTimeout(this.probeTimer);
    this.retryTimer = this.probeTimer = null;
    return true;
  }

  /** Connect if needed; resolves once the socket is open. */
  private ensure(): Promise<void> {
    if (this.capabilityError) return Promise.resolve();
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return this.openGate!;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.helloSeen = false;
    const machine = webMultiMachine() ? null : webMachine();
    const ws = new WebSocket(
      `${proto}://${location.host}${webPublicPrefix(location.pathname)}/ws?hub=1&token=${encodeURIComponent(webToken ?? "")}${webMultiMachine() ? "&global=1" : machine ? `&machine=${encodeURIComponent(machine)}` : ""}`,
    );
    this.ws = ws;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.openGate = promise;
    this.openResolve = resolve;
    ws.onopen = () => {
      this.retryMs = 1000;
      resolve();
    };
    // Frames arrive as text through the relay only after the Worker learns the
    // frame type; until then they come back as bytes, and String(blob) is
    // "[object Blob]" — every response was being dropped on the floor.
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      // A socket we already replaced can still deliver a buffered hello.
      // Treating that as the new connection makes the next catalog calls
      // leave before the desktop is attached, and those calls never return.
      if (this.ws !== ws) return;
      this.noteFrame();
      this.onMessage(
        typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer),
        typeof e.data === "string" ? undefined : (e.data as ArrayBuffer).byteLength,
      );
    };
    ws.onclose = () => this.onClose(ws);
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
    return promise;
  }

  private onMessage(text: string, bytes?: number) {
    const parseStartedAt = performanceRecorder.isEnabled() ? performance.now() : 0;
    let msg: {
      type?: string;
      version?: string;
      machine?: string | null;
      global?: boolean;
      id?: unknown;
      ok?: boolean;
      payload?: unknown;
      error?: unknown;
      name?: string;
      features?: unknown;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const features = new Set(
        Array.isArray(msg.features) ? msg.features.filter((item): item is string => typeof item === "string") : [],
      );
      if (webMultiMachine() && (msg.global !== true || !features.has("multi-machine"))) {
        this.capabilityError = new Error(i18n.t("settings.betaMultiMachineUnavailable"));
        for (const id of this.pending.keys()) this.takeRequest(id)!.reject(this.capabilityError);
        for (const waiter of this.versionWaiters.splice(0)) waiter(null);
        this.ws?.close();
        return;
      }
      if (typeof msg.machine === "string" && msg.machine) setWebMachine(msg.machine);
      this.helloSeen = true;
      this.everOpen = true;
      this.versionValue = typeof msg.version === "string" ? msg.version : null;
      this.features = features;
      if (this.features.has("ping")) this.startHeartbeat();
      setBridgeState("open");
      try {
        sessionStorage.removeItem(BRIDGE_RELOAD_AT);
      } catch {
        // sessionStorage can throw in private mode; hello still stands.
      }
      for (const w of this.versionWaiters.splice(0)) w(this.versionValue);
      for (const cb of this.listeners.get("bridge://connected") ?? []) cb(null);
      return;
    }
    if (msg.type === "response") {
      const id = Number(msg.id);
      if (webMultiMachine() && msg.machine !== this.pending.get(id)?.machine) return;
      const entry = this.takeRequest(id);
      if (!entry) return;
      if (entry.historyTiming && performanceRecorder.isEnabled()) {
        const parseMs = performance.now() - parseStartedAt;
        const elapsedMs = performance.now() - entry.historyTiming.startedAt;
        performanceRecorder.duration("historyRoundTrip", elapsedMs);
        performanceRecorder.duration("historyParse", parseMs);
        performanceRecorder.transition("history-response", {
          request: id, session: entry.historyTiming.session, elapsedMs, parseMs, bytes, textUnits: text.length,
        });
      }
      if (msg.ok) entry.resolve(msg.payload);
      else entry.reject(new Error(msg.error === "executor_history_offline" ? i18n.t("chat.executorHistoryOffline") : String(msg.error ?? "unknown error")));
      return;
    }
    if (msg.type === "event" && typeof msg.name === "string") {
      if (STICKY_EVENTS.has(msg.name)) this.sticky.set(msg.name, msg.payload);
      const subs = this.listeners.get(msg.name);
      if (subs) for (const cb of subs) cb(msg.payload, typeof msg.machine === "string" ? msg.machine : undefined);
    }
  }

  private noteFrame(): void {
    this.lastFrameAt = Date.now();
    if (this.pingDeadline !== null) {
      this.page.clearTimeout(this.pingDeadline);
      this.pingDeadline = null;
    }
  }

  private takeRequest(id: number): PendingReq | undefined {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer !== null) this.page.clearTimeout(entry.timer);
    return entry;
  }

  /** A half-open socket never fires close on its own; ask after quiet time. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ws = this.ws;
    if (!ws) return;
    const timer = this.page.setInterval(() => {
      if (this.ws !== ws) {
        this.page.clearInterval(timer);
        return;
      }
      if (Date.now() - this.lastFrameAt >= HEARTBEAT_IDLE_MS) this.ping(ws, HEARTBEAT_DEADLINE_MS);
    }, HEARTBEAT_CHECK_MS);
    this.heartbeat = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.page.clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.pingDeadline !== null) this.page.clearTimeout(this.pingDeadline);
    this.pingDeadline = null;
  }

  private ping(ws: WebSocket, deadlineMs: number): void {
    if (this.pingDeadline !== null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      // The deadline below treats an unsendable socket as dead.
    }
    this.pingDeadline = this.page.setTimeout(() => {
      this.pingDeadline = null;
      if (this.ws !== ws) return;
      try {
        ws.close(4000, "heartbeat timeout");
      } catch {
        // onClose below already released this socket.
      }
      // The browser can sit in the closing handshake for a minute on a dead path.
      this.onClose(ws);
    }, deadlineMs);
  }

  private probeLiveness(): void {
    const ws = this.ws;
    if (ws && this.helloSeen && this.features.has("ping")) this.ping(ws, RESUME_DEADLINE_MS);
  }

  private onClose(ws: WebSocket) {
    if (this.ws !== ws) return;
    bridgeGeneration += 1;
    this.stopHeartbeat();
    setBridgeState(this.everOpen ? "reconnecting" : "connecting");
    this.ws = null;
    this.openGate = null;
    // Release waiters parked in ensure(); invoke re-checks readyState and
    // throws instead of hanging when the socket never opened.
    this.openResolve?.();
    this.openResolve = null;
    for (const id of this.pending.keys()) {
      const entry = this.takeRequest(id)!;
      entry.reject(new WebBridgeDisconnectedError(entry.sent));
    }
    // If no hello ever arrived (e.g. wrong token → 403), release version
    // waiters so the About/status bar UI does not hang on "…".
    if (this.versionValue === null) {
      for (const w of this.versionWaiters.splice(0)) w(null);
    }
    if (this.capabilityError) return;
    // Keep retrying: the desktop may have restarted the bridge.
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = this.page.setTimeout(() => {
      this.retryTimer = null;
      if (!this.pageGone()) void this.ensure();
    }, delay);
    // A relay restart drops the in-memory login while this page stays up.
    // The socket then fails forever and every call surfaces as disconnected.
    this.scheduleAccessProbe();
  }

  /** Coalesce the burst of closes from a reconnect storm into one probe. */
  private scheduleAccessProbe() {
    if (this.probeTimer !== null) return;
    this.probeTimer = this.page.setTimeout(() => {
      this.probeTimer = null;
      if (!this.pageGone()) void this.probeAccessGate();
    }, 200);
  }

  private async probeAccessGate() {
    const prefix = webPublicPrefix(location.pathname);
    let healthRes: Response;
    try {
      const machine = webMachine();
      healthRes = await fetch(`${prefix}/health${machine ? `?machine=${encodeURIComponent(machine)}` : ""}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      return;
    }
    if (!(healthRes.headers.get("content-type") ?? "").includes("json")) return;
    const healthBody = await healthRes.text();
    let pageBody: string | null = null;
    // Only look at the document when this attempt never became a bridge.
    // A live session that later blips should keep retrying the socket.
    if (!this.helloSeen && relayDesktopUp(healthBody)) {
      try {
        const page = await fetch(`${location.pathname}${location.search}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        pageBody = await page.text();
      } catch {
        pageBody = null;
      }
    }
    if (bridgeRecovery(healthBody, pageBody) === "reload") reloadForAccessGate();
  }

  invoke<T>(cmd: string, args?: Record<string, unknown>, target?: string | null): Promise<T> {
    if (this.capabilityError) return Promise.reject(this.capabilityError);
    const machine = target === undefined ? webMultiMachine() && GLOBAL_COMMANDS.has(cmd) ? null : webMachine() : target;
    if (!webMultiMachine() && target && target !== webMachine()) return Promise.reject(new Error("machine does not match this connection"));
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timeout = requestTimeout(cmd);
    this.pending.set(id, {
      machine,
      resolve: resolve as (v: unknown) => void,
      reject,
      sent: false,
      timer: timeout === null ? null : this.page.setTimeout(() => {
        this.takeRequest(id)?.reject(new WebBridgeTimeoutError(cmd));
      }, timeout),
      ...(performanceRecorder.isEnabled() && (cmd === "load_session_page" || cmd === "load_remote_session_page") ? {
        historyTiming: { startedAt: performance.now(), session: performanceRecorder.sessionToken(`${args?.engine}/${args?.sessionId}`) },
      } : {}),
    });
    const fail = (error: Error) => this.takeRequest(id)?.reject(error);
    try {
      const ready = this.ensure();
      const ws = this.ws;
      const connected = webMultiMachine() ? ready.then(() => this.waitForHello(8_000)) : ready;
      void connected.then(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        if (!ws || this.ws !== ws || ws.readyState !== WebSocket.OPEN) { fail(new WebBridgeDisconnectedError(false)); return; }
        try {
          ws.send(JSON.stringify({ type: "invoke", id, cmd, args: args ?? {}, ...(webMultiMachine() ? { machine } : {}) }));
          entry.sent = true;
        } catch { fail(new WebBridgeDisconnectedError(false)); }
      }, fail);
    } catch { fail(new WebBridgeDisconnectedError(false)); }
    return promise;
  }

  async listen(name: string, cb: Listener): Promise<UnlistenFn> {
    void this.ensure();
    let subs = this.listeners.get(name);
    if (!subs) {
      subs = new Set();
      this.listeners.set(name, subs);
    }
    subs.add(cb);
    if (this.sticky.has(name)) {
      const payload = this.sticky.get(name);
      queueMicrotask(() => {
        if (this.listeners.get(name)?.has(cb)) cb(payload);
      });
    }
    return () => {
      const set = this.listeners.get(name);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(name);
    };
  }

  /** From the latest hello; kept across a reconnect until the next hello. */
  hasFeature(name: string): boolean {
    return this.features.has(name);
  }

  serverVersion(): Promise<string | null> {
    if (this.capabilityError) return Promise.resolve(null);
    if (this.versionValue !== null) return Promise.resolve(this.versionValue);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    this.versionWaiters.push(resolve);
    void this.ensure();
    return promise;
  }

  /** Resolves once this socket has said hello, or rejects if it never does.
   *  Catalog calls sent before hello sit on a desktop that is not attached yet. */
  private waitForHello(timeoutMs: number): Promise<void> {
    if (this.capabilityError) return Promise.reject(this.capabilityError);
    if (this.helloSeen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.page.clearTimeout(timer);
        if (ok && this.helloSeen) resolve();
        else reject(this.capabilityError ?? new Error("web bridge hello timed out"));
      };
      const onHello = () => finish(this.helloSeen);
      this.versionWaiters.push(onHello);
      const timer = this.page.setTimeout(() => {
        const index = this.versionWaiters.indexOf(onHello);
        if (index >= 0) this.versionWaiters.splice(index, 1);
        finish(false);
      }, timeoutMs);
    });
  }

  /** Drop the socket and open another for this page's machine. */
  reconnect(): Promise<void> {
    this.capabilityError = null;
    bridgeGeneration += 1;
    this.stopHeartbeat();
    if (this.retryTimer !== null) this.page.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    setBridgeState("connecting");
    if (this.probeTimer !== null) {
      this.page.clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    const previous = this.ws;
    this.ws = null;
    this.openGate = null;
    this.openResolve?.();
    this.openResolve = null;
    this.helloSeen = false;
    this.versionValue = null;
    for (const waiter of this.versionWaiters.splice(0)) waiter(null);
    for (const id of this.pending.keys()) {
      const entry = this.takeRequest(id)!;
      entry.reject(new WebBridgeDisconnectedError(entry.sent));
    }
    try {
      previous?.close();
    } catch {
      // The close handler ignores a socket we already dropped.
    }
    return this.ensure().then(() => this.waitForHello(8_000));
  }
}

let bridge: WebBridge | null = null;

/** Drop-in for @tauri-apps/api/core invoke. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>, machine?: string | null): Promise<T> {
  if (!isWeb) return tauriInvoke<T>(cmd, args);
  return (bridge ??= new WebBridge()).invoke<T>(cmd, args, machine);
}

/** Drop-in for @tauri-apps/api/event listen (same payload-wrapped shape). */
export function listen<T>(
  name: string,
  cb: (e: { payload: T; machine?: string }) => void,
): Promise<UnlistenFn> {
  if (!isWeb) return tauriListen<T>(name, cb);
  return (bridge ??= new WebBridge()).listen(name, (payload, machine) => cb({ payload: payload as T, ...(machine ? { machine } : {}) }));
}

/** Whether the server behind the bridge advertised a hub feature in hello. */
export function webBridgeFeature(name: string): boolean {
  return isWeb && (bridge?.hasFeature(name) ?? false);
}

/** Version reported by the bridge hello frame; null when unavailable. */
export function serverVersion(): Promise<string | null> {
  if (!isWeb) return Promise.resolve(null);
  return (bridge ??= new WebBridge()).serverVersion();
}

/** Reconnect the web bridge for an explicit machine, retaining it on retries. */
export function reconnectWebBridge(machine?: string): Promise<void> {
  if (!isWeb) return Promise.resolve();
  if (machine) setWebMachine(machine);
  return (bridge ??= new WebBridge()).reconnect();
}
