import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import { adoptLiveRuns, handleEngineEvents, settledRuns, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    rescanSessions: vi.fn(async () => {}),
    usageRecord: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    listPlanReviews: vi.fn(async () => []),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("codex", "s-1", "/tmp/ws");

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

/** An event from a run this client never sent — the phone watching the
 *  desktop's turn, or the desktop watching the phone's. */
function observed(kind: "delta" | "session" | "done" | "error" | "usage" | "warn", seq: number, data: unknown) {
  return { runId: "run-7", sessionId: "s-1", engine: "codex", seq, kind, data };
}

describe("a turn this client did not start", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    settledRuns.clear();
    // Opened from history: no send happened here, so nothing is flagged and
    // no run routes to it.
    useChatStore.setState({
      openTabs: [],
      active: null,
      unseen: {},
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "user", text: "run the tests", ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  it("reads as running on reload, before any further event arrives", () => {
    adoptLiveRuns(
      [{ runId: "run-7", engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws" }],
      deps(),
    );

    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(true);
    expect(useChatStore.getState().streamingByKey[KEY]).toBe(true);
    expect(runRouting.get("run-7")).toBe(KEY);
  });

  it("keeps a draft tab running when the session id is not known yet", () => {
    const pending = sessionKey("codex", null, "/tmp/ws");
    useChatStore.setState({
      openTabs: [{ engine: "codex", sessionId: null, workspacePath: "/tmp/ws" }],
      bySession: {
        [pending]: { ...EMPTY_SESSION, messages: [{ seq: 1, role: "user", text: "run the tests", ts: null }] },
      },
      streamingByKey: {},
    });

    adoptLiveRuns(
      [{ runId: "run-draft", engine: "codex", sessionId: null, workspacePath: "/tmp/ws" }],
      deps(),
    );

    expect(useChatStore.getState().bySession[pending]!.streaming).toBe(true);
    expect(useChatStore.getState().streamingByKey[pending]).toBe(true);
    expect(runRouting.get("run-draft")).toBe(pending);
  });

  it("restores the original start before opening the session, including after a machine switch", () => {
    const startedAt = Date.now() - 120_000;
    const run = { runId: "run-7", engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws", startedAt };
    adoptLiveRuns([run], deps());
    expect(useChatStore.getState().active).toBeNull();
    expect(useChatStore.getState().bySession[KEY]!.turnStartedAt).toBe(startedAt);

    useChatStore.getState().prepareMachineSwitch();
    adoptLiveRuns([run], deps());
    expect(useChatStore.getState().bySession[KEY]!.turnStartedAt).toBe(startedAt);
  });

  it("uses the run timestamp on a late first event, not its delivery time", () => {
    const startedAt = Date.now() - 120_000;
    handleEngineEvents([{ ...observed("delta", 9, "still working"), startedAt, ts: startedAt + 60_000 }], deps());
    expect(useChatStore.getState().bySession[KEY]!.turnStartedAt).toBe(startedAt);
  });

  it.each([undefined, NaN, -1])("does not invent a start time when the host reports %s", (startedAt) => {
    adoptLiveRuns([{ runId: "run-7", engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws", startedAt }], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(true);
    expect(useChatStore.getState().bySession[KEY]!.turnStartedAt).toBeNull();
  });

  it.each([false, true])("uses history timestamps for an older host without overwriting a known start (%s)", async (known) => {
    const promptTime = Date.now() - 120_000;
    const startedAt = known ? promptTime - 500 : undefined;
    useChatStore.setState({ bySession: {} });
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({
      messages: [{ seq: 1, role: "user", text: "run tests", ts: new Date(promptTime).toISOString() }],
      nextBefore: null,
      subagentHistory: [],
    });
    adoptLiveRuns([{ runId: "run-7", engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws", startedAt }], deps());
    await useChatStore.getState().selectSession("codex", "s-1", "/tmp/ws");
    expect(useChatStore.getState().bySession[KEY]!.turnStartedAt).toBe(startedAt ?? promptTime);
  });

  it.each(["done", "error"] as const)("stops duration at the emitted %s time even if delivery is delayed", (kind) => {
    const startedAt = Date.now() - 120_000;
    adoptLiveRuns([{ runId: "run-7", engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws", startedAt }], deps());
    handleEngineEvents([observed("delta", 2, "finished")], deps());
    handleEngineEvents([{ ...observed(kind, 3, kind === "done" ? { usage: null } : "failed"), ts: startedAt + 30_000 }], deps());
    const state = useChatStore.getState().bySession[KEY]!;
    expect(state.streaming).toBe(false);
    expect(state.messages.at(-1)?.durationMs).toBe(30_000);
  });

  it("does not revive a run this page already saw finish", () => {
    handleEngineEvents([observed("delta", 2, "wo")], deps());
    handleEngineEvents([observed("done", 3, { usage: null })], deps());

    adoptLiveRuns(
      [{ runId: "run-7", engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws" }],
      deps(),
    );

    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);
    expect(useChatStore.getState().streamingByKey[KEY]).toBeUndefined();
  });

  it("keeps accepting output after the running flag is restored", () => {
    adoptLiveRuns(
      [{ runId: "run-7", engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws" }],
      deps(),
    );

    handleEngineEvents([observed("delta", 4, "still")], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(true);

    handleEngineEvents([observed("done", 5, { usage: null })], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);
    expect(useChatStore.getState().streamingByKey[KEY]).toBeUndefined();
  });

  it("reads as running once its events arrive", () => {
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);

    handleEngineEvents([observed("delta", 2, "wo")], deps());

    // The composer turns into Stop and the sidebar dot lights up: both read
    // these two flags, and neither is written by the send path on this client.
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(true);
    expect(useChatStore.getState().streamingByKey[KEY]).toBe(true);
    expect(useChatStore.getState().bySession[KEY]!.turnStartedAt).toBeNull();
  });

  it("lights the sidebar dot for a session this client never opened", () => {
    useChatStore.setState({ bySession: {}, streamingByKey: {} });

    handleEngineEvents([observed("session", 1, "s-1")], deps());

    expect(useChatStore.getState().streamingByKey[KEY]).toBe(true);
  });

  it("routes the observed run, so Stop reaches it", () => {
    handleEngineEvents([observed("delta", 2, "wo")], deps());

    expect(runRouting.get("run-7")).toBe(KEY);
  });

  it("keeps the turn's own start time once running", () => {
    handleEngineEvents([{ ...observed("delta", 2, "wo"), startedAt: Date.now() - 60_000 }], deps());
    const started = useChatStore.getState().bySession[KEY]!.turnStartedAt;

    handleEngineEvents([observed("delta", 3, "rld")], deps());

    expect(useChatStore.getState().bySession[KEY]!.turnStartedAt).toBe(started);
  });

  it("settles when the run reports done", () => {
    handleEngineEvents([observed("delta", 2, "wo")], deps());

    handleEngineEvents([observed("done", 3, { usage: null })], deps());

    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);
    // Clearing drops the map entry rather than storing a false (see
    // setStreamingFlag): no dot, no key.
    expect(useChatStore.getState().streamingByKey[KEY]).toBeUndefined();
  });

  it.each(["done", "error"] as const)("does not revive a %s run when its final usage arrives", (kind) => {
    const d = { ...deps(), refreshSessionUsage: vi.fn(async () => {}) };
    handleEngineEvents([observed("delta", 1, "finished")], d);
    handleEngineEvents([observed(kind, 2, kind === "done" ? { usage: null } : "failed")], d);
    handleEngineEvents([
      observed("usage", 3, { input_tokens: 89400, output_tokens: 409 }),
      observed("warn", 4, "late process warning"),
    ], d);
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);
    expect(useChatStore.getState().streamingByKey[KEY]).toBeUndefined();
    expect(runRouting.has("run-7")).toBe(false);
    expect(d.refreshSessionUsage).toHaveBeenCalledWith(KEY);
  });

  it("ignores an old completion after the next run has started", () => {
    handleEngineEvents([observed("done", 2, { usage: null })], deps());
    handleEngineEvents([{ ...observed("delta", 1, "next"), runId: "run-next" }], deps());
    handleEngineEvents([observed("done", 2, { usage: null })], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(true);
    expect(runRouting.get("run-next")).toBe(KEY);
  });
});
