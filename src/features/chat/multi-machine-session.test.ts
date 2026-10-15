import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EngineInfo, SessionMeta, SessionPage } from "@/lib/ipc";
import { useChatStore, sessionKey } from "./store";
import { handleEngineEvents, settledRuns, upsertSessionMetaInto } from "./store/engine-events";
import { EMPTY_SESSION, runRouting } from "./store/stream";

const rpc = vi.hoisted(() => {
  const make = () => ({ loadSessionPage: vi.fn(), listPlanReviews: vi.fn(async () => []),
    listEngines: vi.fn<() => Promise<EngineInfo[]>>(async () => []),getCliConfig: vi.fn(async () => ({})),
    rescanSessions: vi.fn(async () => {}), listActiveRuns: vi.fn(async () => []), usageRecord: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}), deleteSession: vi.fn(async () => {}),
    listSessions: vi.fn<(scope?: "remote" | "all") => Promise<SessionMeta[]>>(async () => []), listArchivedSessions: vi.fn(async () => []),
    getAppSettings: vi.fn(async () => ({})), updateAppSettings: vi.fn(async (_settings: unknown) => {}),
    answerQuestion: vi.fn(async () => {}), interruptSession: vi.fn(async (_sessionId: string) => true),
  });
  return { base: make(), PC0: make(), PC6: make() };
});
vi.mock("@/lib/ipc", () => ({ ipc: rpc.base, ipcForMachine: (machine: "PC0" | "PC6") => rpc[machine] }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}), listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const tab = (machine: string, sessionId: string | null = "same") => ({ machine, engine: "codex", sessionId, workspacePath: "E:/same" });
const meta = (machine: string): SessionMeta => ({ ...tab(machine), sessionId: "same", filePath: "same.jsonl", fileSize: 1, fileMtimeMs: 1,
  title: machine, preview: "", createdAt: 1, updatedAt: 1, messageCount: 1, pinned: false, customTitle: null });
const page = (machine: string): SessionPage => ({ messages: [{ seq: 1, role: "user", text: `${machine} 中文🙂`, ts: null }], nextBefore: null, subagentHistory: [] });
const key = (machine: string, sessionId: string | null = "same") => sessionKey("codex", sessionId, "E:/same", machine);

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); runRouting.clear(); settledRuns.clear();
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC0");
  useChatStore.getState().prepareMachineSwitch();
  useChatStore.setState({ activeEngine: "codex", workspaces: [], sessions: [meta("PC0"), meta("PC6")],
    sessionScope: "all", sessionSort: "workspace",
    openTabs: [], active: null, bySession: {}, streamingByKey: {}, retryingByKey: {},enginesByMachine:{},providersByMachine:{},serviceTiersByMachine:{},
  });
  rpc.PC0.loadSessionPage.mockResolvedValue(page("PC0"));
  rpc.PC6.loadSessionPage.mockResolvedValue(page("PC6"));
});
afterEach(() => { useChatStore.getState().prepareMachineSwitch(); window.history.replaceState(null, "", "/"); });

it("loads identical sessions independently when the first page completes after another machine was selected", async () => {
  let resolve!: (page: SessionPage) => void;
  rpc.PC0.loadSessionPage.mockReturnValueOnce(new Promise<SessionPage>((r) => { resolve = r; }));
  const first = useChatStore.getState().selectSession("codex", "same", "E:/same", "PC0");
  await useChatStore.getState().selectSession("codex", "same", "E:/same", "PC6");
  resolve(page("PC0")); await first;
  const state = useChatStore.getState();
  expect(state.active).toMatchObject(tab("PC6"));
  expect(state.openTabs).toHaveLength(2);
  expect(state.bySession[key("PC0")].messages[0].text).toBe("PC0 中文🙂");
  expect(state.bySession[key("PC6")].messages[0].text).toBe("PC6 中文🙂");
  expect(rpc.base.loadSessionPage).not.toHaveBeenCalled();
  state.closeTab("codex", "same", "E:/same", "PC0");
  expect(useChatStore.getState().openTabs).toEqual([state.openTabs[1]]);
});

it("keeps a late machine's engine catalog from replacing the foreground machine's catalog", async () => {
  const pc0 = [{ id: "claude", available: true }] as EngineInfo[];
  const pc6 = [{ id: "codex", available: true }] as EngineInfo[];
  let resolve!: (engines: EngineInfo[]) => void;
  rpc.PC0.listEngines.mockReturnValueOnce(new Promise<EngineInfo[]>((done) => { resolve = done; }));
  rpc.PC6.listEngines.mockResolvedValueOnce(pc6);
  useChatStore.setState({ active: tab("PC0") });
  const first = useChatStore.getState().refreshMachineRuntime("PC0");
  expect(useChatStore.getState().refreshMachineRuntime("PC0")).toBe(first);
  useChatStore.setState({ active: tab("PC6") });
  await useChatStore.getState().refreshMachineRuntime("PC6");
  resolve(pc0);
  await first;
  const state = useChatStore.getState();
  expect(state.engines).toEqual(pc6);
  expect(state.enginesByMachine).toEqual({ PC0: pc0, PC6: pc6 });
  expect(rpc.PC0.listEngines).toHaveBeenCalledTimes(1);
  expect(rpc.base.listEngines).not.toHaveBeenCalled();
});

it("adopts a native session on its own machine without stealing the other machine's pending tab or draft", () => {
  const first = tab("PC0", null), second = tab("PC6", null);
  useChatStore.setState({ sessions: [], openTabs: [first, second], active: second,
    bySession: { [key("PC0", null)]: { ...EMPTY_SESSION, messages: page("PC0").messages },
      [key("PC6", null)]: { ...EMPTY_SESSION, messages: page("PC6").messages } },
    drafts: { [key("PC0", null)]: "PC0 draft", [key("PC6", null)]: "PC6 draft" },
  });
  runRouting.set("run-0", key("PC0", null));
  handleEngineEvents([{ ...tab("PC0", null), runId: "run-0", seq: 0, kind: "session", data: "same" }], {
    set: useChatStore.setState, get: useChatStore.getState,
    drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(),
    upsertSessionMeta: (row) => upsertSessionMetaInto(useChatStore.setState, row),
  });
  const state = useChatStore.getState();
  expect(state.openTabs.map((t) => [t.machine, t.sessionId])).toEqual([["PC0", "same"], ["PC6", null]]);
  expect(state.active).toEqual(second);
  expect(state.bySession[key("PC0")].messages[0].text).toBe("PC0 中文🙂");
  expect(state.bySession[key("PC6", null)].messages[0].text).toBe("PC6 中文🙂");
  expect(state.drafts[key("PC6", null)]).toBe("PC6 draft");
  expect(state.sessions[0].machine).toBe("PC0");
});

it("archives only the selected machine's identical session", async () => {
  useChatStore.setState({ openTabs: [tab("PC0"), tab("PC6")], active: tab("PC6"),
    bySession: { [key("PC0")]: { ...EMPTY_SESSION }, [key("PC6")]: { ...EMPTY_SESSION } },
    sessionContributions: { [key("PC0")]:{ remembered:{},resets:{},overflowed:false }, [key("PC6")]:{ remembered:{},resets:{},overflowed:false } },
  });
  await useChatStore.getState().archiveSession(meta("PC0"));
  expect(rpc.PC0.archiveSession).toHaveBeenCalledWith(meta("PC0"));
  expect(rpc.PC6.archiveSession).not.toHaveBeenCalled();
  expect(useChatStore.getState().sessions.map((s) => s.machine)).toEqual(["PC6"]);
  expect(useChatStore.getState().bySession[key("PC6")]).toBeDefined();
  expect(useChatStore.getState().active?.machine).toBe("PC6");
  expect(Object.keys(useChatStore.getState().sessionContributions)).toEqual([key("PC6")]);
});

it("answers and stops a background pane on its own machine", async () => {
  useChatStore.setState({ openTabs: [tab("PC0"), tab("PC6")], active: tab("PC0"),
    bySession: { [key("PC6")]: { ...EMPTY_SESSION, messages: [{ seq: 4, role: "question", text: "choose", ts: null,
      question: { runId: "run-6", requestId: "ask-6", questions: [], status: "pending" } }] } },
  });
  await useChatStore.getState().respondToQuestion(key("PC6"), 4, null);
  expect(rpc.PC6.answerQuestion).toHaveBeenCalledWith("run-6", "ask-6", null);
  expect(rpc.PC0.answerQuestion).not.toHaveBeenCalled();
  runRouting.set("run-6", key("PC6"));
  await useChatStore.getState().interrupt(tab("PC6"));
  expect(rpc.PC6.interruptSession.mock.calls.map((call) => call[0])).toEqual(["same", "run-6"]);
  expect(rpc.PC0.interruptSession).not.toHaveBeenCalled();
});

it("keeps a late all-sessions response from replacing the remote-work view", async () => {
  let resolve!: (rows: SessionMeta[]) => void;
  const remote = { ...meta("PC6"), origin: "hub" as const };
  rpc.base.listSessions.mockReturnValueOnce(new Promise<SessionMeta[]>((done) => { resolve = done; })).mockResolvedValueOnce([remote]);
  const loading = useChatStore.getState().refreshSessions();
  await useChatStore.getState().setSessionScope("remote");
  resolve([meta("PC0")]);
  await loading;
  expect(useChatStore.getState().sessions).toEqual([remote]);
  expect(useChatStore.getState().sessionScope).toBe("remote");
  expect(rpc.base.listSessions.mock.calls.map(([scope]) => scope)).toEqual(["all", "remote"]);
  expect(rpc.base.updateAppSettings).toHaveBeenCalledWith({ sessionScope: "remote" });
});

it("does not switch scope when saving the preference fails", async () => {
  rpc.base.updateAppSettings.mockRejectedValueOnce(new Error("offline"));
  await expect(useChatStore.getState().setSessionScope("remote")).rejects.toThrow("offline");
  expect(useChatStore.getState().sessionScope).toBe("all");
  expect(rpc.base.listSessions).not.toHaveBeenCalled();
});
