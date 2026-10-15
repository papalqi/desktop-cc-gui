import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ipc, type SessionPage, type SessionEventPage } from "@/lib/ipc";
import type { EngineEventPayload } from "@/lib/events";
import { useChatStore } from "./store";
import { EMPTY_SESSION, flushPendingStreams, runRouting } from "./store/stream";
import { settledRuns } from "./store/engine-events";
import i18n from "@/lib/i18n";

const hooks = vi.hoisted(() => ({
  receive: (_events: EngineEventPayload[]) => {},
  connected: (_session?: { engine: string; sessionId: string }) => {},
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async (cb, recovery) => {
    hooks.receive = cb; hooks.connected = recovery.connected;
    return () => {};
  }),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/ipc", () => ({ ipc: {
  listWorkspaces: vi.fn(async () => []), listSessions: vi.fn(async () => []),
  listArchivedSessions: vi.fn(async () => []), listEngines: vi.fn(async () => []),
  listActiveRuns: vi.fn(async () => []), getAppSettings: vi.fn(async () => ({})),
  getCliConfig: vi.fn(async () => ({})), listPlanReviews: vi.fn(async () => []),
  loadSessionPage: vi.fn(), loadSessionEvents: vi.fn(), rescanSessions: vi.fn(async () => {}),
  usageRecord: vi.fn(async () => {}),
} }));

const KEY = "codex/s";
const tab = { engine: "codex", sessionId: "s", workspacePath: "/ws" };
const run = { ...tab, runId: "r", startedAt: 2000 };
function event(cursor: number, kind: EngineEventPayload["kind"], data: unknown): EngineEventPayload {
  return { ...run, cursor, seq: cursor, kind, data, ts: 2000 + cursor };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function tick() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  flushPendingStreams(useChatStore.setState);
}
const page = (cursor: number, text = "A"): SessionPage => ({
  messages: [
    { seq: 1, role: "user", text: "test", ts: "2000", runId: "r" },
    { seq: 2, role: "assistant", text, ts: "2001", live: true, runId: "r" },
  ], nextBefore: null, subagentHistory: [], eventCursor: cursor, activeRuns: [run], settledRunIds: [],
});
const read = () => useChatStore.getState().bySession[KEY];
function seed(cursor = 10) {
  useChatStore.setState({ active: tab, openTabs: [tab], bySession: {
    [KEY]: { ...EMPTY_SESSION, messages: page(cursor).messages, eventCursor: cursor, historyLoaded: true, streaming: true },
  }, streamingByKey: { [KEY]: true } });
}

it.each([["executor", "hub"], ["hub", "executor"]] as const)("rebases %s cursors onto %s without discarding lower numbered output", async (oldSource, source) => {
  seed(900);
  useChatStore.setState((state) => ({ bySession: { ...state.bySession, [KEY]: { ...read(), historySource: oldSource, historyEpoch: 200 } } }));
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({ reset: true, source, events: [], nextCursor: 900, head: 2, hasMore: false });
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ ...page(1), source, historyEpoch: 1 });
  hooks.receive([{ ...event(2, "delta", "中文🙂"), historySource: source, historyEpoch: 1 }]);
  await tick();
  expect(ipc.loadSessionEvents).toHaveBeenCalledWith("codex", "s", 900, undefined, 200, oldSource);
  expect(read().messages[1].text).toBe("A中文🙂");
  expect(read().eventCursor).toBe(2); expect(read().historyEpoch).toBe(1); expect(read().historySource).toBe(source);
});

it("reloads an older snapshot whose cursor source was not recorded before accepting Hub output", async () => {
  seed(900);
  useChatStore.setState((state) => ({ bySession: { ...state.bySession, [KEY]: { ...read(), historyEpoch: 200 } } }));
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ ...page(1), source: "hub", historyEpoch: 1 });
  hooks.receive([{ ...event(2, "delta", "中文🙂"), historySource: "hub", historyEpoch: 1 }]);
  await tick();
  expect(ipc.loadSessionEvents).not.toHaveBeenCalled();
  expect(read().messages[1].text).toBe("A中文🙂"); expect(read().historySource).toBe("hub");
});

beforeAll(async () => { localStorage.clear(); await useChatStore.getState().init(); await tick(); });
beforeEach(() => {
  useChatStore.getState().prepareMachineSwitch();
  runRouting.clear(); settledRuns.clear(); vi.clearAllMocks();
  vi.mocked(ipc.loadSessionPage).mockReset();
  vi.mocked(ipc.listActiveRuns).mockResolvedValue([run]);
  vi.mocked(ipc.loadSessionEvents).mockResolvedValue({ events: [], nextCursor: 20, head: 20, hasMore: false });
});
afterEach(() => { useChatStore.getState().prepareMachineSwitch(); flushPendingStreams(useChatStore.setState); });

it("merges output arriving during a fresh history read without overwriting or replaying the snapshot", async () => {
  const response = deferred<SessionPage>();
  vi.mocked(ipc.loadSessionPage).mockReturnValueOnce(response.promise);
  const opening = useChatStore.getState().selectSession("codex", "s", "/ws");
  hooks.receive([event(1,"delta","A"), event(2,"delta","中文🙂")]);
  response.resolve(page(1));
  await opening; await tick();
  expect(read().messages.map((m) => m.text)).toEqual(["test", "A中文🙂"]);
  expect(read().eventCursor).toBe(2);
  expect(ipc.rescanSessions).not.toHaveBeenCalled();
});

it("uses the recovered native session identity when an older route still points at its draft", async () => {
  const response = deferred<SessionPage>();
  vi.mocked(ipc.loadSessionPage).mockReturnValueOnce(response.promise);
  runRouting.set("r", "new:codex:/ws");
  const opening = useChatStore.getState().selectSession("codex", "s", "/ws");
  hooks.receive([event(1,"delta","A"), event(2,"delta","B")]);
  response.resolve(page(1));
  await opening; await tick();
  expect(read().messages[1].text).toBe("AB");
  expect(runRouting.get("r")).toBe(KEY);
});

it("loads the opening history after a live-run snapshot created the observer's state", async () => {
  hooks.connected();
  await tick();
  hooks.receive([event(12, "delta", "tail only")]);
  await tick();
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce(page(12, "opening and tail only"));

  await useChatStore.getState().selectSession("codex", "s", "/ws");
  await tick();

  expect(ipc.loadSessionPage).toHaveBeenCalledWith("codex", "s", 100);
  expect(read().messages.map((message) => message.text)).toEqual(["test", "opening and tail only"]);
  expect(read().historyLoaded).toBe(true);
});

it("loads an observer's opening even when model preferences exist and the host has no event cursor", async () => {
  useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, activeModel: "remembered" } } });
  hooks.receive([{ ...event(12, "delta", "tail only"), cursor: undefined }]);
  await tick();
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce(page(12, "opening and tail only"));

  await useChatStore.getState().selectSession("codex", "s", "/ws");
  await tick();

  expect(read().messages.map((message) => message.text)).toEqual(["test", "opening and tail only"]);
  expect(read().activeModel).toBe("remembered");
  expect(read().historyLoaded).toBe(true);
});

it("fills a disconnect gap, deduplicates live/REST overlap and settles exactly once", async () => {
  seed();
  const response = deferred<SessionEventPage>();
  vi.mocked(ipc.loadSessionEvents).mockReturnValueOnce(response.promise);
  hooks.connected();
  hooks.receive([event(12,"delta","C🙂"), event(13,"done",{})]);
  response.resolve({ events: [event(11,"delta","中B"), event(12,"delta","C🙂")], nextCursor:12, head:12, hasMore:false });
  await tick();
  expect(read().messages.map((m) => m.text)).toEqual(["test", "A中BC🙂"]);
  expect(read().eventCursor).toBe(13);
  expect(read().streaming).toBe(false);
  expect(ipc.rescanSessions).toHaveBeenCalledTimes(1);
  hooks.receive([event(12,"delta","duplicate"), event(13,"done",{})]);
  await tick();
  expect(read().messages[1].text).toBe("A中BC🙂");
  expect(ipc.rescanSessions).toHaveBeenCalledTimes(1);
});

it("uses the first catch-up head across pages while retaining newer live output", async () => {
  seed();
  const second = deferred<SessionEventPage>();
  vi.mocked(ipc.loadSessionEvents)
    .mockResolvedValueOnce({ events:[event(11,"delta","B")], nextCursor:11, head:12, hasMore:true })
    .mockReturnValueOnce(second.promise);
  hooks.connected(); await tick();
  hooks.receive([event(13,"delta","D")]);
  second.resolve({ events:[event(12,"delta","C")], nextCursor:12, head:12, hasMore:false });
  await tick();
  expect(ipc.loadSessionEvents).toHaveBeenNthCalledWith(2,"codex","s",11,12);
  expect(read().messages[1].text).toBe("ABCD");
});

it("discards an old machine's catch-up even when the new machine has the same session id", async () => {
  seed();
  const response = deferred<SessionEventPage>();
  vi.mocked(ipc.loadSessionEvents).mockReturnValueOnce(response.promise);
  hooks.connected();
  useChatStore.getState().prepareMachineSwitch();
  seed(1);
  response.resolve({ events:[event(11,"delta","wrong machine")], nextCursor:11, head:11, hasMore:false });
  await tick();
  expect(read().messages[1].text).toBe("A");
  expect(read().eventCursor).toBe(1);
});

it("does not advance over a failed catch-up and retries from the last saved cursor", async () => {
  seed();
  vi.mocked(ipc.loadSessionEvents).mockRejectedValueOnce(new Error("disconnected"));
  hooks.connected(); await tick();
  expect(read().eventCursor).toBe(10);
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({ events:[event(11,"delta","B"),event(12,"delta","C")], nextCursor:12, head:12, hasMore:false });
  hooks.receive([event(12,"delta","C")]);
  await tick();
  expect(ipc.loadSessionEvents).toHaveBeenLastCalledWith("codex","s",10,undefined);
  expect(read().messages[1].text).toBe("ABC");
});

it("pairs identical commands by call id when results arrive after recovery", async () => {
  seed();
  hooks.receive([
    event(11,"message",{role:"tool",text:"exec",toolCallId:"one",args:{command:"git status"}}),
    event(12,"message",{role:"tool",text:"exec",toolCallId:"two",args:{command:"git status"}}),
    event(13,"message",{role:"tool",text:"exec",toolCallId:"one",patch:true,result:{text:"first"}}),
    event(14,"message",{role:"tool",text:"exec",toolCallId:"two",patch:true,result:{text:"second"}}),
  ]);
  expect(read().messages.filter((m) => m.role === "tool").map((m) => m.result)).toEqual([{text:"first"},{text:"second"}]);
});

it("stops a saved partial turn after the host restarted without a terminal event", async () => {
  seed();
  vi.mocked(ipc.listActiveRuns).mockResolvedValue([]);
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({events:[event(11,"delta","partial")],nextCursor:11,head:11,hasMore:false});
  hooks.connected(); await tick();
  expect(read().messages[1].text).toBe("Apartial");
  expect(read().streaming).toBe(false);
  expect(read().messages.every((m) => !m.live)).toBe(true);
  expect(read().error).toBe(i18n.t("chat.historyTurnIncomplete"));
});

it("explains an unfinished historical turn while preserving its saved output", async () => {
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ ...page(22, "saved progress 中文🙂"), activeRuns: [], incompleteTurn: true });
  await useChatStore.getState().selectSession("codex", "s", "/ws");
  expect(read().messages[1].text).toBe("saved progress 中文🙂");
  expect(read().streaming).toBe(false);
  expect(read().error).toBe(i18n.t("chat.historyTurnIncomplete"));
  hooks.receive([event(23, "launch", { model: "model" })]);
  await tick();
  expect(read().streaming).toBe(true);
  expect(read().error).toBeNull();
});

it("does not warn about a historical turn while the host is still running it", async () => {
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ ...page(22), incompleteTurn: true });
  await useChatStore.getState().selectSession("codex", "s", "/ws");
  expect(read().streaming).toBe(true);
  expect(read().error).toBeNull();
});

it("rebases an invalidated journal onto a snapshot even after the old run settled", async () => {
  seed();
  useChatStore.setState((state) => ({ bySession: { ...state.bySession, [KEY]: { ...read(), historyEpoch: 1 } } }));
  settledRuns.set("r", "done");
  const response = deferred<SessionPage>();
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({ reset: true, historyEpoch: 2, events: [], nextCursor: 10, head: 13, hasMore: false });
  vi.mocked(ipc.loadSessionPage).mockReturnValueOnce(response.promise);
  hooks.receive([{ ...event(13, "delta", "C"), historyEpoch: 2 }]);
  await tick();
  const restored = { ...page(13, "A中B🙂C"), historyEpoch: 2, activeRuns: [], settledRunIds: ["r"] };
  response.resolve(restored);
  await tick();
  expect(ipc.loadSessionEvents).toHaveBeenCalledWith("codex", "s", 10, undefined, 1);
  expect(read().messages.map((message) => message.text)).toEqual(["test", "A中B🙂C"]);
  expect(read().historyEpoch).toBe(2);
  expect(read().eventCursor).toBe(13);
  expect(read().streaming).toBe(false);
  expect(ipc.rescanSessions).not.toHaveBeenCalled();
  hooks.receive([{ ...event(14, "delta", "old version"), historyEpoch: 1 }]);
  await tick();
  expect(read().messages[1].text).toBe("A中B🙂C");
});

it("does not advance a settled gapped snapshot and reloads it when backfill arrives", async () => {
  seed();
  useChatStore.setState((state) => ({ bySession: { ...state.bySession, [KEY]: { ...read(), historyEpoch: 1 } } }));
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({ reset: true, historyEpoch: 2, events: [], nextCursor: 10, head: 12, hasMore: false });
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ ...page(12, "saved prefix"), eventCursor: undefined, historyEpoch: 2, activeRuns: [], settledRunIds: ["r"], incompleteTurn: true });
  vi.mocked(ipc.listActiveRuns).mockResolvedValue([]);
  hooks.connected(); await tick();
  expect(read().eventCursor).toBeUndefined();
  expect(read().error).toBe(i18n.t("chat.historyTurnIncomplete"));
  vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ ...page(14, "saved prefix中🙂"), historyEpoch: 3, activeRuns: [], settledRunIds: ["r"] });
  hooks.connected(); await tick();
  expect(read().eventCursor).toBe(14);
  expect(read().messages[1].text).toBe("saved prefix中🙂");
  expect(read().error).toBeNull();
});

it("preserves a new optimistic prompt and live output received during a version reset", async () => {
  seed();
  const optimistic = { seq: 3, role: "user", text: "next question", runId: "next", ts: "3000" };
  useChatStore.setState((state) => ({ bySession: { ...state.bySession, [KEY]: { ...read(), historyEpoch: 1, messages: [...read().messages, optimistic] } } }));
  runRouting.set("next", KEY);
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({ reset: true, historyEpoch: 2, events: [], nextCursor: 10, head: 12, hasMore: false });
  const response = deferred<SessionPage>();
  vi.mocked(ipc.loadSessionPage).mockReturnValueOnce(response.promise);
  hooks.connected(); await tick();
  hooks.receive([{ ...event(13, "delta", "new reply🙂"), runId: "next", historyEpoch: 2 }]);
  response.resolve({ ...page(12, "old answer"), historyEpoch: 2, activeRuns: [], settledRunIds: ["r"] });
  await tick();
  expect(read().messages.map((message) => message.text)).toEqual(["test", "old answer", "next question", "new reply🙂"]);
  expect(read().streaming).toBe(true);
  expect(read().eventCursor).toBe(13);
});

it("rebuilds the already loaded history window across pages with one snapshot version", async () => {
  seed();
  const messages = Array.from({ length: 1200 }, (_, index) => ({ seq: index + 1, role: "assistant", text: String(index), ts: null }));
  useChatStore.setState((state) => ({ bySession: { ...state.bySession, [KEY]: { ...read(), historyEpoch: 1, messages } } }));
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({ reset: true, historyEpoch: 2, events: [], nextCursor: 10, head: 12, hasMore: false });
  vi.mocked(ipc.loadSessionPage)
    .mockResolvedValueOnce({ ...page(12), messages: messages.slice(200), nextBefore: 201, historyEpoch: 2 })
    .mockResolvedValueOnce({ ...page(12), messages: messages.slice(0, 200), nextBefore: null, historyEpoch: 2 });
  hooks.connected(); await tick();
  expect(ipc.loadSessionPage).toHaveBeenNthCalledWith(1, "codex", "s", 1000);
  expect(ipc.loadSessionPage).toHaveBeenNthCalledWith(2, "codex", "s", 200, 201);
  expect(read().messages).toEqual(messages);
  expect(read().historyEpoch).toBe(2);
});

it("discards an older page from a previous version and reloads the current window", async () => {
  seed();
  useChatStore.setState((state) => ({ bySession: { ...state.bySession, [KEY]: { ...read(), nextBefore: 5, historyEpoch: 1 } } }));
  vi.mocked(ipc.loadSessionPage)
    .mockResolvedValueOnce({ ...page(12, "wrong older page"), historyEpoch: 2 })
    .mockResolvedValueOnce({ ...page(14, "current full text"), historyEpoch: 2 });
  vi.mocked(ipc.loadSessionEvents).mockResolvedValueOnce({ reset: true, historyEpoch: 2, events: [], nextCursor: 10, head: 14, hasMore: false });
  await useChatStore.getState().loadEarlier(KEY); await tick();
  expect(read().messages.map((message) => message.text)).toEqual(["test", "current full text"]);
  expect(read().historyEpoch).toBe(2);
});

it("limits a transcript resync to the open session that changed", async () => {
  seed();
  hooks.connected({ engine: "codex", sessionId: "unopened" }); await tick();
  expect(ipc.loadSessionEvents).not.toHaveBeenCalled();
  expect(ipc.listActiveRuns).not.toHaveBeenCalled();
  hooks.connected({ engine: "codex", sessionId: "s" }); await tick();
  expect(ipc.loadSessionEvents).toHaveBeenCalledTimes(1);
  expect(ipc.listActiveRuns).not.toHaveBeenCalled();
});
