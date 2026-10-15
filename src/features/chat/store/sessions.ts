import { normalizeOmpServiceTier } from "@/lib/omp-service-tier";
import {
  ipc,
  ipcForMachine,
  type ActiveRun,
  type EngineInfo,
  type SessionMeta,
  type Workspace,
} from "@/lib/ipc";
import type { EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { listenEngineEvents, listenSessionsChanged, listenComputerUseEscape } from "@/lib/events";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";
import { performanceRecorder } from "@/lib/performance-diagnostics";
import { subscribeTauriEvent } from "@/hooks/use-tauri-event";
import {
  CLI_CONFIG_CHANGED_EVENT,
  engineCurrents,
} from "@/features/settings/providers";
import {
  ENGINE_PREF_KEY,
  persistTabs,
  readPersistedActive,
  readPersistedTabs,
  readPersistedUnseen,
  sameTab,
  sessionKey,
  parseSessionKey,
  type ActiveSession,
} from "./persistence";
import { EMPTY_SESSION, patchSession, drainPending, applyStreamParts, runRouting, setStreamingFlag, settleLiveRows } from "./stream";
import type { EngineEventPayload } from "@/lib/events";
import { adoptLiveRuns, handleEngineEvents, settledRuns, upsertSessionMetaInto } from "./engine-events";
import { mergePlanReviewHistory } from "./plan-review";
import i18n from "@/lib/i18n";
import {
  listExternalSessionMetas,
  setSessionSourcesChangedCallback,
} from "@/features/plugins/runtime/session-source";
import { emitSessionActivated } from "@/features/plugins/runtime/events";
import {
  dispatchSessionClosed,
  dispatchSessionRestored,
} from "@/features/plugins/runtime/hooks";
import { clearScopedContributions, sessionLifecycleBase } from "./lifecycle";
import {
  currentRelayMachine,
  listsFromState,
  publishMachineCatalog,
  runningKeysFromFlags,
  sessionsToArchive,
  type MachineCatalogSnapshot,
} from "@/features/chat/machine-catalog";
import {
  mergeExternalSessions,
  preserveUnscannedSessions,
  sessionsHeldByLiveRuns,
  historyTurnStartedAt,
  visibleSessions,
} from "./session-utils";
import type { ChatStore } from "./types";
import type { LoadHistoryPage, StoreGet, StoreSet } from "./context";
import { setWebMachine, webMachine, webMultiMachine } from "@/lib/web-machine";
import { isWeb } from "@/lib/transport";

function omitKey(rec: Record<string, boolean>, key: string) {
  const next = { ...rec };
  delete next[key];
  return next;
}

function archivedKeyMap(sessions: SessionMeta[]): Record<string, true> {
  return Object.fromEntries(
    sessions.map((session) => [
      sessionKey(session.engine, session.sessionId, session.workspacePath, session.machine),
      true as const,
    ]),
  );
}

function withoutArchived(
  sessions: SessionMeta[],
  archived: Record<string, true>,
): SessionMeta[] {
  return sessions.filter(
    (session) =>
      !archived[sessionKey(session.engine, session.sessionId, session.workspacePath, session.machine)],
  );
}

/**
 * Session lifecycle: init/refresh of the session/engine catalogs, history
 * paging, and sidebar session ops (archive/delete/pin/rename).
 */

export interface SessionDeps {
  set: StoreSet;
  get: StoreGet;
  loadHistoryPage: LoadHistoryPage;
  /** Module-scope unlisteners (store.ts) init pushes into; HMR dispose runs them. */
  eventTeardowns: Array<() => void>;
  activateTab: (tab: ActiveSession | null) => void;
  removeTab: (
    engine: string,
    sessionId: string | null,
    workspacePath: string,
    machine?: string,
  ) => void;
  forgetClosedTab: (key: string) => void;
  drainQueue: (key: string) => void;
  markUnseenIfBackground: (key: string) => void;
  /** 一轮结束后的复盘计数钩子（store.ts 接记忆模块）。 */
  turnSettled: (key: string) => void;
}

export function createSessionActions(
  deps: SessionDeps,
): Pick<
  ChatStore,
  | "init"
  | "prepareMachineSwitch"
  | "applyCachedMachineCatalog"
  | "replaceMachineCatalog"
  | "archiveSessionsBefore"
  | "refreshSessions"
  | "refreshEngines"
  | "refreshMachineRuntime"
  | "setSessionScope"
  | "setSessionSort"
  | "selectSession"
  | "loadEarlier"
  | "archiveSession"
  | "deleteSession"
  | "pinSession"
  | "renameSession"
> {
  const {
    set,
    get,
    loadHistoryPage,
    eventTeardowns,
    activateTab,
    removeTab,
    forgetClosedTab,
    drainQueue,
    markUnseenIfBackground,
    turnSettled,
  } = deps;

  /** Sessions whose transcript we already tried to read after it was indexed.
   *  An empty file must not be fetched again on every later rescan. */
  const historyReadForFile = new Set<string>();
  /** Bumped when the relay page points at another desktop. A history read
   *  started on the previous machine must not land in the new catalog. */
  let machineEpoch = 0;
  /** Bumped while a batch archive is in flight so a sessions-changed
   *  refresh cannot paint half-archived rows back into the sidebar. */
  let sessionListEpoch = 0;
  let archiveBatch = 0;
  const bufferedEvents = new Map<string, EngineEventPayload[]>();
  const catchups = new Map<string, Promise<void>>();
  const needsCatchup = new Set<string>();
  const sourceResets = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  const eventDeps = {
    set, get, drainQueue, markUnseenIfBackground, turnSettled,
    upsertSessionMeta: (meta: SessionMeta) => upsertSessionMetaInto(set, meta),
    refreshSessionUsage: (key: string) => get().refreshSessionUsage(key),
  };
  const eventKey = (event: EngineEventPayload) => event.sessionId ? sessionKey(event.engine, event.sessionId, "", event.machine) :
    runRouting.get(event.runId) ?? (event.workspacePath ? sessionKey(event.engine, null, event.workspacePath, event.machine) : null);
  const deliverBuffered = (key: string, buffer: EngineEventPayload[]) => {
    if (bufferedEvents.get(key) !== buffer) return;
    bufferedEvents.delete(key);
    buffer.sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0));
    const state = get().bySession[key];
    const cursor = state?.eventCursor;
    if (state?.historyEpoch !== undefined && cursor === undefined) {
      needsCatchup.add(key);
      return;
    }
    const sameSource = buffer.filter((event) => event.historySource === undefined || state?.historySource === undefined || event.historySource === state.historySource);
    const sameVersion = sameSource.filter((event) => event.historyEpoch === undefined || state?.historyEpoch === undefined || event.historyEpoch === state.historyEpoch);
    if (sameSource.length !== buffer.length || sameSource.some((event) => event.historyEpoch !== undefined && state?.historyEpoch !== undefined && event.historyEpoch > state.historyEpoch)) needsCatchup.add(key);
    else needsCatchup.delete(key);
    handleEngineEvents(sameVersion.filter((event) => event.cursor === undefined || cursor === undefined || event.cursor > cursor), eventDeps);
  };

  function receiveEvents(events: EngineEventPayload[]) {
    const ready: EngineEventPayload[] = [];
    for (const event of events) {
      const key = eventKey(event);
      const state = key ? get().bySession[key] : undefined;
      const sourceChanged = event.historySource !== undefined && state?.historySource !== event.historySource;
      if (sourceChanged && key && state) {
        needsCatchup.add(key);
        if (state.historySource === undefined) sourceResets.add(key);
      }
      if (!sourceChanged && event.historyEpoch !== undefined && state?.historyEpoch !== undefined) {
        if (event.historyEpoch < state.historyEpoch) continue;
        if (event.historyEpoch > state.historyEpoch && key) needsCatchup.add(key);
      }
      if (key && needsCatchup.has(key) && event.sessionId) {
        void catchUp(event.engine, event.sessionId, key);
      }
      const buffer = key ? bufferedEvents.get(key) : undefined;
      if (buffer) buffer.push(event);
      else if (key && needsCatchup.has(key) && catchups.has(key)) bufferedEvents.set(key, [event]);
      else ready.push(event);
    }
    handleEngineEvents(ready, eventDeps);
  }

  function catchUp(engine: string, sessionId: string, key: string): Promise<void> {
    const machine = parseSessionKey(key)?.machine;
    const client = machine ? ipcForMachine(machine) : ipc;
    const running = catchups.get(key);
    if (running) return running;
    const state = get().bySession[key];
    const cursor = state?.eventCursor;
    // Older desktops have no journal API. Loading their native history keeps
    // the existing compatibility path; never invent a successful cursor.
    if ((cursor === undefined && state?.historyEpoch === undefined && !needsCatchup.has(key)) || bufferedEvents.has(key)) return Promise.resolve();
    const epoch = machineEpoch;
    const buffer: EngineEventPayload[] = [];
    bufferedEvents.set(key, buffer);
    const task = (async () => {
      try {
        let after = sourceResets.delete(key) ? undefined : cursor;
        let historyEpoch = state?.historyEpoch;
        let historySource = state?.historySource;
        let until: number | undefined;
        while (true) {
          if (after === undefined) {
            needsCatchup.delete(key);
            const workspace = get().openTabs.find((tab) => tab.engine === engine && tab.sessionId === sessionId && tab.machine === machine)?.workspacePath ?? "";
            await ensureSessionHistory(engine, sessionId, workspace, true, buffer, machine);
            if (epoch !== machineEpoch) return;
            sourceResets.delete(key);
            const current = get().bySession[key];
            if (!needsCatchup.has(key) || current?.eventCursor === undefined) return;
            after = current.eventCursor;
            historyEpoch = current.historyEpoch;
            historySource = current.historySource;
            until = undefined;
            bufferedEvents.set(key, buffer);
            buffer.length = 0;
            continue;
          }
          const page = await (historySource !== undefined ? client.loadSessionEvents(engine, sessionId, after, until, historyEpoch, historySource) : historyEpoch === undefined
            ? client.loadSessionEvents(engine, sessionId, after, until)
            : client.loadSessionEvents(engine, sessionId, after, until, historyEpoch));
          if (epoch !== machineEpoch) return;
          if (sourceResets.delete(key) || page.reset || page.source !== undefined && historySource !== undefined && page.source !== historySource) {
            after = undefined;
            continue;
          }
          until ??= page.head;
          handleEngineEvents(machine ? page.events.map((event) => ({ ...event, machine })) : page.events, eventDeps);
          patchSession(set, key, { eventCursor: Math.max(get().bySession[key]?.eventCursor ?? 0, page.nextCursor) });
          if (!page.hasMore) {
            needsCatchup.delete(key);
            const pending = bufferedEvents.get(key) ?? buffer;
            deliverBuffered(key, pending);
            if (!needsCatchup.has(key)) break;
            after = get().bySession[key]?.eventCursor;
            historyEpoch = get().bySession[key]?.historyEpoch;
            historySource = get().bySession[key]?.historySource;
            until = undefined;
            bufferedEvents.set(key, buffer);
            buffer.length = 0;
            continue;
          }
          if (page.nextCursor <= after) throw new Error("Chat history cursor did not advance");
          after = page.nextCursor;
        }
      } catch (error) {
        if (epoch !== machineEpoch) return;
        // Do not advance over a gap by applying buffered live events. They
        // are already durable; the next connection/event retries this cursor.
        needsCatchup.add(key);
        bufferedEvents.delete(key);
        set({ actionError: i18n.t("chat.historySyncFailed", { error: errorText(error) }) });
        if (retryTimer === undefined && retryAttempt < 5) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            recoverConnection();
          }, Math.min(1000 * 2 ** retryAttempt++, 15000));
        }
      } finally {
        if (epoch === machineEpoch) catchups.delete(key);
      }
    })();
    catchups.set(key, task);
    return task;
  }

  function recoverConnection(session?: { engine: string; sessionId: string; machine?: string }) {
    const pending: Promise<void>[] = [];
    for (const tab of get().openTabs) {
      if (session && (session.engine !== tab.engine || session.sessionId !== tab.sessionId || session.machine !== tab.machine)) continue;
      if (tab.sessionId) pending.push(catchUp(tab.engine, tab.sessionId, sessionKey(tab.engine, tab.sessionId, tab.workspacePath, tab.machine)));
    }
    const epoch = machineEpoch;
    void Promise.all(pending).then(async () => {
      if (epoch !== machineEpoch || session) return;
      const cursors = new Map(Object.entries(get().bySession).map(([key, value]) => [key, value.eventCursor]));
      const runs = await ipc.listActiveRuns?.();
      if (!runs) return;
      if (epoch !== machineEpoch) return;
      adoptLiveRuns(runs, { set, get });
      const running = new Set(runs.map((r) => sessionKey(r.engine, r.sessionId, r.workspacePath, r.machine)));
      for (const tab of get().openTabs) {
        const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath, tab.machine);
        const current = get().bySession[key];
        if (current?.eventCursor === undefined || current.eventCursor !== cursors.get(key) || running.has(key) || !current.streaming) continue;
        // A host restarted without a terminal event. Its saved partial text
        // remains, but a dead process must not leave Stop/spinners armed.
        const pending = drainPending(key);
        const messages = pending ? applyStreamParts(current.messages, pending.parts, pending.model, pending.effort) : current.messages;
        patchSession(set, key, { streaming: false, turnStartedAt: null, messages: settleLiveRows(messages), error: current.error ?? i18n.t("chat.historyTurnIncomplete") });
        set((s) => ({ streamingByKey: setStreamingFlag(s.streamingByKey, key, false) }));
      }
    }).catch(() => {});
  }

  function clearRecovery() {
    bufferedEvents.clear(); catchups.clear(); needsCatchup.clear(); sourceResets.clear();
    clearTimeout(retryTimer); retryTimer = undefined; retryAttempt = 0;
  }

  function publishHere(): void {
    if (webMultiMachine()) return;
    const machine = currentRelayMachine();
    if (!machine) return;
    const state = get();
    publishMachineCatalog(
      machine,
      listsFromState({
        workspaces: state.workspaces,
        sessions: state.sessions,
        workspaceGroups: state.workspaceGroups,
        workspaceAliases: state.workspaceAliases,
        archivedWorkspaces: state.archivedWorkspaces,
        threadLimit: state.threadLimit,
        runningKeys: runningKeysFromFlags(state.streamingByKey),
      }),
    );
  }

  /** Migrate the engine pref off a CLI that is gone or disabled in
   * settings. All CLIs disabled: leave the pref alone — the composer shows
   * the "no CLI enabled" placeholder instead of a misleading fallback. */
  function ensureUsableEngine(engines: EngineInfo[]) {
    const usable = engines.filter((e) => e.enabled);
    if (usable.length === 0 || usable.some((e) => e.id === get().activeEngine))
      return;
    get().setActiveEngine(usable.find((e) => e.available)?.id ?? usable[0].id);
  }

  /** History recovery also runs for background tabs; it must not activate them. */
  async function ensureSessionHistory(engine: string, sessionId: string, workspacePath: string, reload = false, recoveryBuffer?: EngineEventPayload[], machine?: string) {
    const key = sessionKey(engine, sessionId, workspacePath, machine);
    const client = machine ? ipcForMachine(machine) : ipc;
    const existing = get().bySession[key];
    if (existing?.loading && !reload) return;
    if (!reload && existing && existing.messages.length > 0 && existing.historyLoaded !== false) {
      await catchUp(engine, sessionId, key);
      return;
    }
    const startedAt = performance.now();
    const token = performanceRecorder.sessionToken(key);
    performanceRecorder.transition("history-start", { session: token });
    const buffer: EngineEventPayload[] = recoveryBuffer ?? [];
    bufferedEvents.set(key, buffer);
    patchSession(set, key, { loading: true });
    // 并行取计划审批历史:失败静默降级为无历史计划,绝不阻塞会话加载。
    const plansPromise = client.listPlanReviews(engine, sessionId).catch(() => null);
    const epoch = machineEpoch;
    try {
      const windowSize = reload ? Math.max(100, existing?.messages.length ?? 0) : 100;
      let page = await loadHistoryPage(engine, sessionId, workspacePath, Math.min(1000, windowSize), undefined, undefined, machine);
      while (reload && page.nextBefore != null && page.messages.length < windowSize) {
        const before = page.nextBefore;
        const older = await loadHistoryPage(engine, sessionId, workspacePath, Math.min(1000, windowSize - page.messages.length), before, undefined, machine);
        if (epoch !== machineEpoch) return;
        if (older.historyEpoch !== page.historyEpoch || older.source !== page.source) throw new Error("Chat history changed during recovery");
        if (older.nextBefore != null && older.nextBefore >= before) throw new Error("Chat history cursor did not advance");
        page = { ...page, messages: [...older.messages, ...page.messages], nextBefore: older.nextBefore, subagentHistory: older.subagentHistory };
      }
      if (epoch !== machineEpoch) {
        performanceRecorder.transition("history-discarded", { session: token, elapsedMs: performance.now() - startedAt });
        return;
      }
      drainPending(key);
      const current = get().bySession[key];
      const optimistic = reload && current?.streaming ? current.messages.findLast((message) => message.role === "user") : undefined;
      const keepOptimistic = optimistic?.runId && !settledRuns.has(optimistic.runId) &&
        !page.settledRunIds?.includes(optimistic.runId) &&
        !page.messages.some((message) => message.role === "user" && message.runId === optimistic.runId);
      const messages = keepOptimistic ? [...page.messages, { ...optimistic, seq: (page.messages.at(-1)?.seq ?? 0) + 1 }] : page.messages;
      patchSession(set, key, {
        messages,
        subagentHistory: page.subagentHistory,
        nextBefore: page.nextBefore,
        loading: false,
        historyLoaded: true,
        error: page.incompleteTurn && !page.activeRuns?.length ? i18n.t("chat.historyTurnIncomplete") : null,
        ...(page.settledRunIds === undefined ? {} : { settledRunIds: page.settledRunIds }),
        eventCursor: page.eventCursor,
        historyEpoch: page.historyEpoch,
        historySource: page.source,
        ...(page.activeRuns === undefined ? {} : {
          streaming: page.activeRuns.length > 0 || Boolean(keepOptimistic),
          turnStartedAt: page.activeRuns[0]?.startedAt ?? (keepOptimistic ? current?.turnStartedAt ?? null : null),
        }),
        ...(current?.streaming && current.turnStartedAt == null
          ? { turnStartedAt: historyTurnStartedAt(page.messages) }
          : {}),
        // Live "usage" events only cover fresh turns; a resumed session
        // adopts the newest usage snapshot carried by its history.
        usage: [...page.messages].reverse().find((m) => m.usage)?.usage ?? null,
      });
      if (page.activeRuns) {
        set((s) => ({ streamingByKey: setStreamingFlag(s.streamingByKey, key, page.activeRuns!.length > 0 || Boolean(keepOptimistic)) }));
        adoptLiveRuns(machine ? page.activeRuns.map((run) => ({ ...run, machine })) : page.activeRuns, { set, get });
      }
      deliverBuffered(key, buffer);
      if (!reload && needsCatchup.has(key)) void catchUp(engine, sessionId, key);
      const elapsedMs = performance.now() - startedAt;
      performanceRecorder.duration("sessionHistory", elapsedMs);
      performanceRecorder.transition("history-applied", { session: token, elapsedMs, messages: page.messages.length,
        active: Number(get().active?.sessionId === sessionId && get().active?.engine === engine) });
      // 历史页应用后再并入计划卡片(按 planId+revision 去重;活跃等待点
      // 可否恢复由后端状态保证,前端只按 record.status 渲染)。
      const plans = await plansPromise;
      if (epoch !== machineEpoch) return;
      if (plans && plans.length > 0) {
        set((s) => {
          const cur = s.bySession[key];
          if (!cur) return {};
          const messages = mergePlanReviewHistory(cur.messages, plans);
          if (!messages) return {};
          return { bySession: { ...s.bySession, [key]: { ...cur, messages } } };
        });
      }
    } catch (error) {
      if (epoch !== machineEpoch) return;
      performanceRecorder.transition("history-failed", { session: token, elapsedMs: performance.now() - startedAt });
      const text = String(error);
      // A new session is in the process table before its transcript is
      // indexed. That miss is not a failure — the row stays, and the
      // rescan reads the file once the CLI flushes it.
      const unindexed = text.includes("session not found") &&
        (get().streamingByKey[key] === true || get().sessions.some(
          (item) => item.engine === engine && item.sessionId === sessionId && item.machine === machine && item.filePath === "",
        ));
      patchSession(set, key, { loading: false, error: unindexed ? null : text });
      if (reload) throw error;
      deliverBuffered(key, buffer);
    }
  }

  const runtimeReads = new Map<string, Promise<void>>();
  return {
    setSessionScope: async (scope) => {
      if (scope === get().sessionScope) return;
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({ ...settings, sessionScope: scope });
      sessionListEpoch += 1;
      set({ sessionScope: scope });
      await get().refreshSessions();
    },
    setSessionSort: async (sort) => {
      if (sort === get().sessionSort) return;
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({ ...settings, sessionSort: sort });
      set({ sessionSort: sort });
    },
    refreshMachineRuntime: (machine, force = false) => {
      if (!webMultiMachine() || (!force && get().enginesByMachine[machine])) return Promise.resolve();
      const pending = runtimeReads.get(machine);
      if (pending) return pending;
      const client = ipcForMachine(machine);
      const epoch = machineEpoch;
      const task = Promise.all([client.listEngines(),client.getCliConfig(),client.getAppSettings()]).then(([engines,config,settings]) => {
        if (epoch !== machineEpoch) return;
        const providers = engineCurrents(config);
        const tiers = { omp: normalizeOmpServiceTier(settings.ompOpenaiServiceTier), codex: normalizeOmpServiceTier(settings.codexServiceTier) };
        set((state) => ({ enginesByMachine:{ ...state.enginesByMachine,[machine]:engines },providersByMachine:{ ...state.providersByMachine,[machine]:providers },
          serviceTiersByMachine: { ...state.serviceTiersByMachine, [machine]: tiers },
          ...(state.active?.machine === machine ? { engines,providers } : {}) }));
        if (get().active?.machine === machine && !get().active?.sessionId) ensureUsableEngine(engines);
      }).catch((error) => { if (epoch === machineEpoch) set({ actionError:errorText(error) }); })
        .finally(() => { if (runtimeReads.get(machine) === task) runtimeReads.delete(machine); });
      runtimeReads.set(machine,task);
      return task;
    },
    init: async () => {
      if (get().initialized) return;
      set({ initialized: true });
      eventTeardowns.push(
        subscribeTauriEvent(() =>
          listenEngineEvents(receiveEvents, {
            connected: recoverConnection,
            failed: () => set({ actionError: i18n.t("chat.historySaveFailed") }),
          }),
        ),
        subscribeTauriEvent(() =>
          listenSessionsChanged(() => void get().refreshSessions()),
        ),
        // Global Esc during a computer-use run: the backend arms that hotkey
        // only while a run is active, so this fires exactly when the user
        // needs the escape hatch out of a machine-driving turn.
        subscribeTauriEvent(() =>
          listenComputerUseEscape(() => void get().interrupt()),
        ),
      );
      const onVisible = () => { if (document.visibilityState === "visible") recoverConnection(); };
      document.addEventListener("visibilitychange", onVisible);
      eventTeardowns.push(() => { document.removeEventListener("visibilitychange", onVisible); machineEpoch += 1; clearRecovery(); });
      // Settings' CLI enable switch / channel edits: re-filter history and
      // picker options without a restart.
      const onCliConfigChanged = () => void get().refreshEngines();
      window.addEventListener(CLI_CONFIG_CHANGED_EVENT, onCliConfigChanged);
      eventTeardowns.push(() =>
        window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, onCliConfigChanged),
      );
      const bootEpoch = machineEpoch;
      const startupSettings = await ipc.getAppSettings().catch(() => null);
      if (bootEpoch !== machineEpoch) return;
      const scope = startupSettings?.sessionScope ?? (isWeb ? "remote" : "all");
      set({ sessionScope: scope, sessionSort: startupSettings?.sessionSort ?? "workspace", unseen: readPersistedUnseen() });
      const activeRunsPromise =
        ipc.listActiveRuns?.() ?? Promise.resolve([] as ActiveRun[]);
      const [workspaces, sessions, archivedSessions, engines, activeRuns] = await Promise.all([
        ipc.listWorkspaces().catch(() => [] as Workspace[]),
        ipc.listSessions(scope).catch(() => [] as SessionMeta[]),
        ipc.listArchivedSessions(scope).catch(() => [] as SessionMeta[]),
        ipc.listEngines().catch(() => [] as EngineInfo[]),
        activeRunsPromise.catch(() => [] as ActiveRun[]),
      ]);
      // Plugin session sources (remote/容器内 CLI) merge under the local
      // scan so WSL 等远端会话进侧栏,且重启时已开标签不至于因“会话表无
      // 此会话”被清掉。
      setSessionSourcesChangedCallback(() => void get().refreshSessions());
      if (bootEpoch !== machineEpoch) return;
      const external = await listExternalSessionMetas();
      const archivedSessionKeys = archivedKeyMap(archivedSessions);
      const allSessions = sessionsHeldByLiveRuns(
        withoutArchived(
          mergeExternalSessions(sessions, external, workspaces.map((w) => w.path)),
          archivedSessionKeys,
        ),
        activeRuns,
      );
      if (bootEpoch !== machineEpoch) return;
      set({
        workspaces,
        sessions: visibleSessions(allSessions, engines),
        archivedSessionKeys,
        engines,
      });
      ensureUsableEngine(engines);
      // Restore persisted tabs; drop ones whose workspace/session is gone.
      const restoredTabs = readPersistedTabs().filter(
        (t) =>
          workspaces.some((w) => w.path === t.workspacePath && w.machine === t.machine) &&
          (t.sessionId === null || scope === "remote" ||
            allSessions.some(
              (s) => s.engine === t.engine && s.sessionId === t.sessionId && s.machine === t.machine,
            )),
      );
      let routedTab: ActiveSession | null = null;
      if (webMultiMachine()) {
        const route = new URLSearchParams(window.location.search);
        const machine = route.get("machine"), engine = route.get("engine"), sessionId = route.get("session"), workspacePath = route.get("workspace");
        if (machine && engine) {
          const meta = sessionId ? allSessions.find((row) => row.machine === machine && row.engine === engine && row.sessionId === sessionId) : undefined;
          const workspace = workspaces.find((row) => row.machine === machine && row.path === workspacePath);
          if (meta || !sessionId && workspace) {
            routedTab = { machine, engine, sessionId, workspacePath:meta?.workspacePath ?? workspace!.path };
            if (!restoredTabs.some((tab) => sameTab(tab, engine, sessionId, routedTab!.workspacePath, machine))) restoredTabs.push(routedTab);
          } else set({ actionError:i18n.t("chat.sessionRouteUnavailable") });
        }
      }
      if (bootEpoch !== machineEpoch) return;
      set({ openTabs: restoredTabs });
      publishHere();
      const persistedActive = readPersistedActive();
      const activeTab = routedTab ?? (
        persistedActive &&
        restoredTabs.some((t) =>
          sameTab(
            t,
            persistedActive.engine,
            persistedActive.sessionId,
            persistedActive.workspacePath,
            persistedActive.machine,
          ),
        )
          ? persistedActive
          : (restoredTabs[0] ?? null));
      if (bootEpoch !== machineEpoch) return;
      if (activeTab) activateTab(activeTab);
      // The process table outlives this page. A refresh or a machine switch
      // would otherwise paint a live turn as idle until the next event.
      adoptLiveRuns(activeRuns, { set, get });
      const settingsEpoch = machineEpoch;
      Promise.resolve(startupSettings)
        .then((settings) => {
          if (!settings || settingsEpoch !== machineEpoch) return;
          set({
            efforts: (settings.defaultEfforts ?? {}) as Record<
              string,
              EffortLevel
            >,
            ompServiceTier: normalizeOmpServiceTier(
              settings.ompOpenaiServiceTier,
            ),
            codexServiceTier: normalizeOmpServiceTier(
              settings.codexServiceTier,
            ),
            models: settings.defaultModels ?? {},
            threadLimit: settings.sidebarThreadLimit ?? 5,
            workspaceGroups: settings.workspaceGroups ?? [],
            workspaceAliases: settings.workspaceAliases ?? {},
            archivedWorkspaces: settings.archivedWorkspaces ?? [],
            sendShortcut: settings.composerSendShortcut ?? "enter",
            thinkingAutoCollapse: settings.thinkingAutoCollapse ?? true,
          });
          publishHere();
        })
        .catch(() => {});
      ipc
        .getCliConfig?.()
        ?.then((config) => {
          if (settingsEpoch !== machineEpoch) return;
          set({ providers: engineCurrents(config) });
        })
        .catch(() => {});
    },

    prepareMachineSwitch: () => {
      machineEpoch += 1;
      runtimeReads.clear();
      clearRecovery();
      historyReadForFile.clear();
      set({
        workspaces: [],
        sessions: [],
        engines: [],
        active: null,
        openTabs: [],
        bySession: {},
        streamingByKey: {},
        retryingByKey: {},
        unseen: {},
        drafts: {},
        pendingMention: null,
        pendingRuntimeSwitch: null,
        actionError: null,
        sessionContributions: {},
        restoredSessionKeys: {},
        createdSessionKeys: {},
      });
    },

    applyCachedMachineCatalog: (snapshot: MachineCatalogSnapshot) => {
      machineEpoch += 1;
      clearRecovery();
      historyReadForFile.clear();
      set({
        workspaces: snapshot.workspaces,
        sessions: snapshot.sessions,
        engines: [],
        workspaceGroups: snapshot.workspaceGroups,
        workspaceAliases: snapshot.workspaceAliases,
        archivedWorkspaces: snapshot.archivedWorkspaces,
        threadLimit: snapshot.threadLimit,
        active: null,
        openTabs: [],
        bySession: {},
        streamingByKey: {},
        retryingByKey: {},
        unseen: readPersistedUnseen(),
        drafts: {},
        pendingMention: null,
        pendingRuntimeSwitch: null,
        actionError: null,
        sessionContributions: {},
        restoredSessionKeys: {},
        createdSessionKeys: {},
      });
    },

    replaceMachineCatalog: async (isCurrent = () => true, machine?: string) => {
      const epoch = machineEpoch;
      const startedAt = performance.now();
      performanceRecorder.transition("catalog-start");
      const still = () => epoch === machineEpoch && isCurrent();
      historyReadForFile.clear();
      // Engine detection walks PATH and can sit on a missing network drive.
      // Workspaces and sessions are a SQL read; show those first.
      const enginesPromise = ipc.listEngines().catch(() => [] as EngineInfo[]);
      const activeRunsPromise =
        ipc.listActiveRuns?.() ?? Promise.resolve([] as ActiveRun[]);
      const settingsPromise = ipc.getAppSettings();
      const startupSettings = await settingsPromise.catch(() => null);
      if (!still()) return;
      const scope = startupSettings?.sessionScope ?? (isWeb ? "remote" : "all");
      set({ sessionScope: scope, sessionSort: startupSettings?.sessionSort ?? "workspace", unseen: readPersistedUnseen() });
      const [workspaces, sessions, archivedSessions, activeRuns] = await Promise.all([
        ipc.listWorkspaces().catch(() => [] as Workspace[]),
        ipc.listSessions(scope).catch(() => [] as SessionMeta[]),
        ipc.listArchivedSessions(scope).catch(() => [] as SessionMeta[]),
        activeRunsPromise.catch(() => [] as ActiveRun[]),
      ]);
      if (!still()) return;
      const external = await listExternalSessionMetas();
      if (!still()) return;
      const archivedSessionKeys = archivedKeyMap(archivedSessions);
      const allSessions = sessionsHeldByLiveRuns(
        withoutArchived(
          mergeExternalSessions(sessions, external, workspaces.map((w) => w.path)),
          archivedSessionKeys,
        ),
        activeRuns,
      );
      const catalogSessions = withoutArchived(
        preserveUnscannedSessions(allSessions, get().sessions, get().bySession),
        archivedSessionKeys,
      );
      const restoredTabs = readPersistedTabs().filter(
        (tab) =>
          workspaces.some((workspace) => workspace.path === tab.workspacePath) &&
          (tab.sessionId === null || scope === "remote" ||
            catalogSessions.some(
              (session) =>
                session.engine === tab.engine && session.sessionId === tab.sessionId,
            )),
      );
      const persistedActive = readPersistedActive();
      const activeTab =
        persistedActive &&
        restoredTabs.some((tab) =>
          sameTab(
            tab,
            persistedActive.engine,
            persistedActive.sessionId,
            persistedActive.workspacePath,
          ),
        )
          ? persistedActive
          : (restoredTabs[0] ?? null);
      set({
        workspaces,
        sessions: visibleSessions(catalogSessions, []),
        archivedSessionKeys,
        openTabs: get().openTabs.length > 0 ? get().openTabs : restoredTabs,
      });
      if (still()) {
        // The cached list is clickable while this request is pending. A
        // newer user selection and its loaded history own the foreground.
        if (!get().active) {
          if (activeTab) activateTab(activeTab);
          else persistTabs(get().openTabs, null);
        }
        adoptLiveRuns(activeRuns, { set, get });
      }
      const elapsedMs = performance.now() - startedAt;
      performanceRecorder.duration("sessionCatalog", elapsedMs);
      performanceRecorder.transition("catalog-applied", { elapsedMs, session: performanceRecorder.sessionToken(
        get().active ? sessionKey(get().active!.engine, get().active!.sessionId, get().active!.workspacePath, get().active!.machine) : null,
      ) });
      const engines = await enginesPromise;
      if (!still()) return;
      set((s) => ({ engines, sessions: visibleSessions(s.sessions, engines) }));
      ensureUsableEngine(engines);
      try {
        const settings = await settingsPromise;
        if (!still()) return;
        set({
          efforts: (settings.defaultEfforts ?? {}) as Record<string, EffortLevel>,
          ompServiceTier: normalizeOmpServiceTier(settings.ompOpenaiServiceTier),
          codexServiceTier: normalizeOmpServiceTier(settings.codexServiceTier),
          models: settings.defaultModels ?? {},
          threadLimit: settings.sidebarThreadLimit ?? 5,
          workspaceGroups: settings.workspaceGroups ?? [],
          workspaceAliases: settings.workspaceAliases ?? {},
          archivedWorkspaces: settings.archivedWorkspaces ?? [],
          sendShortcut: settings.composerSendShortcut ?? "enter",
          thinkingAutoCollapse: settings.thinkingAutoCollapse ?? true,
          sessionScope: settings.sessionScope ?? (isWeb ? "remote" : "all"),
          sessionSort: settings.sessionSort ?? "workspace",
        });
      } catch {
        // The cached groups stay until the next successful read.
      }
      if (machine && still()) publishHere();
      ipc
        .getCliConfig?.()
        ?.then((config) => {
          if (!still()) return;
          set({ providers: engineCurrents(config) });
        })
        .catch(() => {});
    },

    refreshSessions: async () => {
      if (archiveBatch > 0) return;
      const startedAt = performance.now();
      performanceRecorder.transition("refresh-start");
      const stamp = sessionListEpoch;
      const epoch = machineEpoch;
      const activeRunsPromise =
        ipc.listActiveRuns?.() ?? Promise.resolve([] as ActiveRun[]);
      const [sessions, external, archivedSessions, activeRuns] = await Promise.all([
        ipc.listSessions(get().sessionScope).catch(() => null),
        listExternalSessionMetas(),
        ipc.listArchivedSessions(get().sessionScope).catch(() => null),
        activeRunsPromise.catch(() => [] as ActiveRun[]),
      ]);
      if (!sessions || !archivedSessions) return;
      if (archiveBatch > 0 || stamp !== sessionListEpoch || epoch !== machineEpoch) return;
      const archivedSessionKeys = archivedKeyMap(archivedSessions);
      const merged = sessionsHeldByLiveRuns(
        withoutArchived(
          mergeExternalSessions(sessions, external, get().workspaces.map((w) => w.path)),
          archivedSessionKeys,
        ),
        activeRuns,
        get().sessions,
      );
      // The file showed up after this page loaded an empty placeholder.
      // Read it once so the prompt is not stuck missing until the next click.
      const historyReads: ActiveSession[] = [];
      for (const meta of merged) {
        if (!meta.filePath) continue;
        const key = sessionKey(meta.engine, meta.sessionId, meta.workspacePath, meta.machine);
        if (historyReadForFile.has(key)) continue;
        const current = get().bySession[key];
        if (!current || current.loading || current.messages.length > 0) continue;
        const tab = get().openTabs.find(
          (candidate) =>
            sessionKey(candidate.engine, candidate.sessionId, candidate.workspacePath, candidate.machine) === key,
        );
        if (!tab?.sessionId) continue;
        historyReadForFile.add(key);
        historyReads.push(tab);
      }
      for (const session of archivedSessions) {
        clearScopedContributions(set, session.engine, session.sessionId, session.workspacePath, session.machine);
        const tab = get().openTabs.find((candidate) =>
          sameTab(candidate, session.engine, session.sessionId, session.workspacePath, session.machine),
        );
        if (tab) dispatchSessionClosed(sessionLifecycleBase(get, tab));
      }
      set((s) => {
        const visible = visibleSessions(
          withoutArchived(
            preserveUnscannedSessions(merged, s.sessions, s.bySession),
            archivedSessionKeys,
          ),
          s.engines,
        );
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        const unseen = { ...s.unseen };
        const streamingByKey = { ...s.streamingByKey };
        const retryingByKey = { ...s.retryingByKey };
        for (const key of Object.keys(archivedSessionKeys)) {
          delete bySession[key];
          delete drafts[key];
          delete unseen[key];
          delete streamingByKey[key];
          delete retryingByKey[key];
        }
        for (const meta of merged) {
          const key = sessionKey(meta.engine, meta.sessionId, meta.workspacePath, meta.machine);
          const current = bySession[key];
          if (!current) continue;
          bySession[key] = {
            ...current,
            // Saved selectors drive the next send, not the model already running.
            activeModel: current.streaming && current.activeModel
              ? current.activeModel
              : meta.model ?? current.activeModel,
            activeEffort: meta.effort ?? current.activeEffort,
            activeProvider: meta.provider ?? current.activeProvider,
          };
        }
        const openTabs = s.openTabs.filter(
          (tab) =>
            tab.sessionId === null ||
            !archivedSessionKeys[sessionKey(tab.engine, tab.sessionId, tab.workspacePath, tab.machine)],
        );
        const active =
          s.active?.sessionId &&
          archivedSessionKeys[
            sessionKey(s.active.engine, s.active.sessionId, s.active.workspacePath, s.active.machine)
          ]
            ? (openTabs[0] ?? null)
            : s.active;
        persistTabs(openTabs, active);
        return {
          sessions: visible,
          archivedSessionKeys,
          bySession,
          drafts,
          unseen,
          streamingByKey,
          retryingByKey,
          openTabs,
          active,
        };
      });
      adoptLiveRuns(activeRuns.filter((run) =>
        !run.sessionId || !archivedSessionKeys[sessionKey(run.engine, run.sessionId, run.workspacePath, run.machine)],
      ), { set, get });
      for (const tab of historyReads) {
        if (!tab.sessionId) continue;
        void ensureSessionHistory(tab.engine, tab.sessionId, tab.workspacePath, false, undefined, tab.machine);
      }
      performanceRecorder.transition("refresh-applied", { elapsedMs: performance.now() - startedAt,
        session: performanceRecorder.sessionToken(get().active ? sessionKey(get().active!.engine, get().active!.sessionId, get().active!.workspacePath, get().active!.machine) : null) });
    },

    refreshEngines: async () => {
      if (webMultiMachine()) {
        const machine = get().active?.machine ?? webMachine();
        if (machine) await get().refreshMachineRuntime(machine,true);
        await get().refreshSessions();
        return;
      }
      const epoch = machineEpoch;
      const activeRunsPromise =
        ipc.listActiveRuns?.() ?? Promise.resolve([] as ActiveRun[]);
      const [engines, sessions, external, archivedSessions, config, activeRuns] = await Promise.all([
        ipc.listEngines().catch(() => null),
        ipc.listSessions(get().sessionScope).catch(() => null),
        listExternalSessionMetas(),
        ipc.listArchivedSessions(get().sessionScope).catch(() => null),
        ipc.getCliConfig?.().catch(() => null) ?? Promise.resolve(null),
        activeRunsPromise.catch(() => [] as ActiveRun[]),
      ]);
      if (!engines || epoch !== machineEpoch) return;
      set((s) => {
        const keys = archivedSessions
          ? archivedKeyMap(archivedSessions)
          : s.archivedSessionKeys;
        return {
          engines,
          archivedSessionKeys: keys,
          ...(sessions
            ? {
                sessions: visibleSessions(
                  sessionsHeldByLiveRuns(
                    withoutArchived(
                      preserveUnscannedSessions(
                        mergeExternalSessions(
                          sessions,
                          external,
                          s.workspaces.map((w) => w.path),
                        ),
                        s.sessions,
                        s.bySession,
                      ),
                      keys,
                    ),
                    activeRuns,
                  ),
                  engines,
                ),
              }
            : {}),
          ...(config ? { providers: engineCurrents(config) } : {}),
        };
      });
      ensureUsableEngine(engines);
    },

    selectSession: async (engine, sessionId, workspacePath, machine) => {
      const key = sessionKey(engine, sessionId, workspacePath, machine);
      if (machine && webMultiMachine()) setWebMachine(machine);
      performanceRecorder.transition("session-select", { session: performanceRecorder.sessionToken(key) });
      // The session remembers the model it ran, and our own record is the
      // only place that carries the provider ("agentrouter qunyou/x", while
      // the engine transcript keeps the bare "x"). Without it a session
      // reopened here — after a restart, or in another window — showed the
      // engine default and sent that instead.
      const remembered = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId && x.machine === machine,
      )?.model;
      if (remembered && !get().bySession[key]?.activeModel) {
        patchSession(set, key, { activeModel: remembered });
      }
      // Same for the reasoning level: the picker and the next send follow the
      // session, so an unset level adopts the one this session last ran.
      const rememberedEffort = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId && x.machine === machine,
      )?.effort;
      if (rememberedEffort && !get().bySession[key]?.activeEffort) {
        patchSession(set, key, { activeEffort: rememberedEffort });
      }
      const rememberedProvider = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId && x.machine === machine,
      )?.provider;
      if (rememberedProvider && !get().bySession[key]?.activeProvider) {
        patchSession(set, key, { activeProvider: rememberedProvider });
      }
      const syncEngine = engine !== get().activeEngine;
      if (syncEngine) writeStored(ENGINE_PREF_KEY, engine);
      set((s) => {
        // Native sessions read effort from SessionState/database. Strip the
        // legacy per-tab field so an old localStorage value cannot shadow it.
        const stored = s.openTabs.find((t) =>
          sameTab(t, engine, sessionId, workspacePath, machine),
        );
        const tab: ActiveSession = stored
          ? { ...stored, effort: undefined, provider: undefined }
          : { engine, sessionId, workspacePath, ...(machine ? { machine } : {}) };
        const openTabs = stored
          ? s.openTabs.map((t) => (t === stored ? tab : t))
          : [...s.openTabs, tab];
        persistTabs(openTabs, tab);
        const unseen = key in s.unseen ? omitKey(s.unseen, key) : s.unseen;
        return { openTabs, active: tab, unseen, activeEngine: engine };
      });
      if (machine) void get().refreshMachineRuntime(machine);
      // A selection restores the session whether or not its messages are
      // already cached (e.g. reopened after a tab close): the hook fires once
      // per frontend lifetime, before any load.
      if (!get().restoredSessionKeys[key]) {
        set((s) => ({ restoredSessionKeys: { ...s.restoredSessionKeys, [key]: true } }));
        dispatchSessionRestored({ ...sessionLifecycleBase(get, { engine, sessionId, workspacePath, machine }), sessionId });
      }
      emitSessionActivated(engine, sessionId);
      await ensureSessionHistory(engine, sessionId, workspacePath, false, undefined, machine);
    },

    loadEarlier: async (key) => {
      const epoch = machineEpoch;
      const { active, bySession, openTabs } = get();
      // 分屏里每格各自向上加载历史：不带 key 时仍按激活会话。
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath, active.machine)
          : "");
      if (!targetKey) return;
      const tab = openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath, t.machine) === targetKey,
      );
      if (!tab?.sessionId) return;
      const state = bySession[targetKey];
      if (!state?.nextBefore || state.loading) return;
      patchSession(set, targetKey, { loading: true });
      try {
        const page = await loadHistoryPage(
          tab.engine,
          tab.sessionId,
          tab.workspacePath,
          100,
          state.nextBefore,
          undefined,
          tab.machine,
        );
        if (epoch !== machineEpoch) return;
        if (page.historyEpoch !== state.historyEpoch || get().bySession[targetKey]?.historyEpoch !== state.historyEpoch || page.source !== state.historySource || get().bySession[targetKey]?.historySource !== state.historySource) {
          patchSession(set, targetKey, { loading: false });
          await catchUp(tab.engine, tab.sessionId, targetKey);
          return;
        }
        patchSession(set, targetKey, {
          messages: [
            ...page.messages,
            ...(get().bySession[targetKey] ?? EMPTY_SESSION).messages,
          ],
          nextBefore: page.nextBefore,
          subagentHistory: page.subagentHistory,
          loading: false,
        });
      } catch {
        if (epoch !== machineEpoch) return;
        patchSession(set, targetKey, { loading: false });
      }
    },

    archiveSessionsBefore: async (beforeMs) => {
      const epoch = machineEpoch;
      archiveBatch += 1;
      sessionListEpoch += 1;
      const done: SessionMeta[] = [];
      let stopped = false;
      try {
        const runs = await (
          ipc.listActiveRuns?.() ?? Promise.resolve([] as ActiveRun[])
        ).catch(() => [] as ActiveRun[]);
        if (epoch !== machineEpoch) {
          stopped = true;
          return 0;
        }
        const running = new Set(
          Object.entries(get().streamingByKey)
            .filter(([, on]) => on)
            .map(([key]) => key),
        );
        for (const run of runs) {
          if (run.sessionId) running.add(sessionKey(run.engine, run.sessionId, run.workspacePath, run.machine));
        }
        const targets = sessionsToArchive(get().sessions, beforeMs, running);
        let cursor = 0;
        const worker = async () => {
          for (;;) {
            if (epoch !== machineEpoch) {
              stopped = true;
              return;
            }
            const index = cursor;
            cursor += 1;
            if (index >= targets.length) return;
            const session = targets[index];
            try {
              await (session.machine ? ipcForMachine(session.machine) : ipc).archiveSession(session);
            } catch {
              // This row stays. A later refresh shows it again.
              continue;
            }
            if (epoch !== machineEpoch) {
              stopped = true;
              return;
            }
            done.push(session);
          }
        };
        if (targets.length > 0) {
          await Promise.all(
            Array.from({ length: Math.min(6, targets.length) }, () => worker()),
          );
        }
        if (stopped || epoch !== machineEpoch) return done.length;
        if (done.length > 0) {
          const gone = new Set(done.map((session) => sessionKey(session.engine, session.sessionId, session.workspacePath, session.machine)));
          set((s) => {
            const archivedSessionKeys = { ...s.archivedSessionKeys };
            const bySession = { ...s.bySession };
            const drafts = { ...s.drafts };
            let unseen = s.unseen;
            for (const session of done) {
              const key = sessionKey(session.engine, session.sessionId, session.workspacePath, session.machine);
              archivedSessionKeys[key] = true;
              delete bySession[key];
              delete drafts[key];
              if (key in unseen) unseen = omitKey(unseen, key);
            }
            return {
              sessions: s.sessions.filter(
                (item) => !gone.has(sessionKey(item.engine, item.sessionId, item.workspacePath, item.machine)),
              ),
              archivedSessionKeys,
              bySession,
              drafts,
              unseen,
              actionError: null,
            };
          });
          for (const session of done) {
            const key = sessionKey(session.engine, session.sessionId, session.workspacePath, session.machine);
            forgetClosedTab(key);
            const tab = get().openTabs.find(
              (item) => item.engine === session.engine && item.sessionId === session.sessionId && item.machine === session.machine,
            );
            if (tab) get().closeTab(session.engine, session.sessionId, tab.workspacePath, session.machine);
            else clearScopedContributions(set, session.engine, session.sessionId, session.workspacePath, session.machine);
          }
        }
      } finally {
        archiveBatch -= 1;
      }
      if (stopped || epoch !== machineEpoch) return done.length;
      await get().refreshSessions();
      publishHere();
      return done.length;
    },

    archiveSession: async (session) => {
      const { engine, sessionId, workspacePath, machine } = session;
      const key = sessionKey(engine, sessionId, workspacePath, machine);
      const client = machine ? ipcForMachine(machine) : ipc;
      if (get().streamingByKey[key]) {
        set({ actionError: i18n.t("chat.archiveRunning") });
        return;
      }
      try {
        await client.archiveSession(session);
      } catch (error) {
        set({ actionError: errorText(error) });
        return;
      }
      set((s) => {
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        delete bySession[key];
        delete drafts[key];
        return {
          sessions: s.sessions.filter(
            (item) => !(item.engine === engine && item.sessionId === sessionId && item.machine === machine),
          ),
          archivedSessionKeys: { ...s.archivedSessionKeys, [key]: true },
          bySession,
          drafts,
          unseen: omitKey(s.unseen, key),
          actionError: null,
        };
      });
      forgetClosedTab(key);
      const tab = get().openTabs.find(
        (item) => item.engine === engine && item.sessionId === sessionId && item.machine === machine,
      );
      if (tab) get().closeTab(engine, sessionId, tab.workspacePath, machine);
      else clearScopedContributions(set, engine, sessionId, workspacePath, machine);
    },

    deleteSession: async (engine, sessionId, machine) => {
      const client = machine ? ipcForMachine(machine) : ipc;
      // 远程(插件会话源,如 WSL 发行版内 CLI)会话没有本地 db 行,本地
      // delete_session 只会 "session not found";走远程通道删 remotePath。
      const meta = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId && x.machine === machine,
      );
      try {
        if (meta?.remote && meta.remotePath) {
          await client.deleteRemoteSession(meta.workspacePath, engine, sessionId, meta.remotePath);
        } else {
          await client.deleteSession(engine, sessionId);
        }
      } catch (error) {
        set({ actionError: errorText(error) });
        return;
      }
      set({ actionError: null });
      const key = sessionKey(engine, sessionId, "", machine);
      const tab = get().openTabs.find(
        (t) => t.engine === engine && t.sessionId === sessionId && t.machine === machine,
      );
      // The session is gone: its remembered contributions go with it.
      clearScopedContributions(set, engine, sessionId, "", machine);
      set((s) => {
        // Permanent delete: the cached session state is dead weight.
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        const streamingByKey = { ...s.streamingByKey };
        const retryingByKey = { ...s.retryingByKey };
        delete bySession[key];
        delete drafts[key];
        // Deleting a running session must clear its flat-map flags too:
        // nothing re-scans a deleted key later (archive is swept by
        // refreshSessions; a delete is gone for good).
        delete streamingByKey[key];
        delete retryingByKey[key];
        return {
          sessions: s.sessions.filter(
            (x) => !(x.engine === engine && x.sessionId === sessionId && x.machine === machine),
          ),
          bySession,
          drafts,
          streamingByKey,
          retryingByKey,
          unseen: omitKey(s.unseen, key),
        };
      });
      // The closed-tab reopen cache must not keep the dead key either.
      forgetClosedTab(key);
      if (tab) {
        // removeTab activates the neighboring tab when the deleted one was active.
        removeTab(engine, sessionId, tab.workspacePath, machine);
      } else {
        set((s) => ({
          active:
            s.active?.sessionId === sessionId && s.active.engine === engine && s.active.machine === machine
              ? null
              : s.active,
        }));
      }
    },

    pinSession: async (engine, sessionId, pinned, machine) => {
      const client = machine ? ipcForMachine(machine) : ipc;
      const epoch = machineEpoch;
      try {
        await client.pinSession(engine, sessionId, pinned,
          get().sessions.find((session) => session.engine === engine && session.sessionId === sessionId && session.machine === machine));
        if (epoch !== machineEpoch) return;
        // Keep an unindexed row responsive; an indexed catalog can then apply
        // the executor's newer value instead of being overwritten by this request.
        set((s) => ({
          sessions: s.sessions.map((session) =>
            session.engine === engine && session.sessionId === sessionId && session.machine === machine
              ? { ...session, pinned }
              : session,
          ),
          actionError: null,
        }));
        await get().refreshSessions();
        if (epoch !== machineEpoch) return;
        publishHere();
      } catch (error) {
        if (epoch === machineEpoch) set({ actionError: errorText(error) });
      }
    },

    renameSession: async (engine, sessionId, title, machine) => {
      const client = machine ? ipcForMachine(machine) : ipc;
      const epoch = machineEpoch;
      try {
        await client.renameSession(engine, sessionId, title,
          get().sessions.find((session) => session.engine === engine && session.sessionId === sessionId && session.machine === machine));
        if (epoch !== machineEpoch) return;
        await get().refreshSessions();
        if (epoch !== machineEpoch) return;
        set({ actionError: null });
      } catch (error) {
        if (epoch === machineEpoch) set({ actionError: errorText(error) });
      }
    },
  };
}
