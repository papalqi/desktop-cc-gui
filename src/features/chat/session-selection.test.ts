import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc, type SessionMeta, type SessionPage } from "@/lib/ipc";
import { pluginBus, resetPluginBusForTests, SESSION_ACTIVATED_TOPIC } from "@/features/plugins/runtime/events";
import { useChatStore } from "./store";
import { persistTabs } from "./store/persistence";
import { EMPTY_SESSION } from "./store/stream";

vi.mock("@/lib/ipc", () => ({ ipc: {
  listWorkspaces: vi.fn(async () => [{ id: "ws", path: "/ws", name: "ws", lastOpenedAt: null, sortOrder: null, groupId: null }]),
  listSessions: vi.fn(async () => []), listArchivedSessions: vi.fn(async () => []),
  listEngines: vi.fn(async () => [{ id: "codex", available: true, enabled: true, supportsImages: false }]),
  listActiveRuns: vi.fn(async () => []), getAppSettings: vi.fn(async () => ({})),
  getCliConfig: vi.fn(async () => ({})), listPlanReviews: vi.fn(async () => []),
  loadSessionPage: vi.fn(), rescanSessions: vi.fn(async () => {}),
} }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}), listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const tab = (sessionId: string) => ({ engine: "codex", sessionId, workspacePath: "/ws" });
const meta = (sessionId: string): SessionMeta => ({ ...tab(sessionId), filePath: `/ws/${sessionId}.jsonl`,
  fileSize: 1, fileMtimeMs: 1, title: "fixture", preview: "", createdAt: 1, updatedAt: 1,
  messageCount: 1, pinned: false, customTitle: null });
const page = (text = "完整历史 中文🙂"): SessionPage => ({
  messages: [{ seq: 1, role: "user", text, ts: "2000" }], nextBefore: null, subagentHistory: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

beforeEach(() => {
  localStorage.clear(); resetPluginBusForTests(); vi.clearAllMocks();
  useChatStore.getState().prepareMachineSwitch();
  useChatStore.setState({ activeEngine: "codex", archivedSessionKeys: {},
    workspaces: [{ id: "ws", path: "/ws", name: "ws", lastOpenedAt: null, sortOrder: null, groupId: null }],
    sessions: [meta("a"), meta("b"), meta("c")],
    openTabs: [tab("a"), tab("b")], active: tab("b"),
    bySession: {
      "codex/a": { ...EMPTY_SESSION, historyLoaded: false },
      "codex/b": { ...EMPTY_SESSION, messages: page("正在看的会话").messages, historyLoaded: true },
    }, drafts: { "codex/b": "未发送草稿" },
  });
  persistTabs(useChatStore.getState().openTabs, useChatStore.getState().active);
  vi.mocked(ipc.loadSessionPage).mockReset().mockResolvedValue(page());
  vi.mocked(ipc.listSessions).mockReset().mockResolvedValue([meta("a"), meta("b"), meta("c")]);
});
afterEach(() => useChatStore.getState().prepareMachineSwitch());

it("fills a background session's newly indexed history without activating it", async () => {
  const activated = vi.fn();
  pluginBus.on(SESSION_ACTIVATED_TOPIC, activated);
  const foreground = useChatStore.getState().bySession["codex/b"];
  await useChatStore.getState().refreshSessions(); await tick();
  expect(ipc.loadSessionPage).toHaveBeenCalledWith("codex", "a", 100);
  expect(useChatStore.getState().bySession["codex/a"].messages).toEqual(page().messages);
  expect(useChatStore.getState().active).toEqual(tab("b"));
  expect(useChatStore.getState().bySession["codex/b"].messages).toBe(foreground.messages);
  expect(useChatStore.getState().drafts["codex/b"]).toBe("未发送草稿");
  expect(activated).not.toHaveBeenCalled();
});

it("keeps a click made while the session catalog request was pending", async () => {
  const catalog = deferred<SessionMeta[]>();
  vi.mocked(ipc.listSessions).mockReturnValueOnce(catalog.promise);
  const refreshing = useChatStore.getState().refreshSessions();
  await useChatStore.getState().selectSession("codex", "c", "/ws");
  catalog.resolve([meta("a"), meta("b"), meta("c")]);
  await refreshing; await tick();
  expect(useChatStore.getState().active).toEqual(tab("c"));
  expect(useChatStore.getState().bySession["codex/a"].messages).toEqual(page().messages);
});

it("updates a machine catalog without resetting a session selected from the cached list", async () => {
  const catalog = deferred<SessionMeta[]>();
  vi.mocked(ipc.listSessions).mockReturnValueOnce(catalog.promise);
  const replacing = useChatStore.getState().replaceMachineCatalog();
  await useChatStore.getState().selectSession("codex", "c", "/ws");
  const selectedState = useChatStore.getState().bySession["codex/c"];
  const drafts = useChatStore.getState().drafts;
  catalog.resolve([meta("a"), meta("b")]);
  await replacing; await tick();
  expect(useChatStore.getState().active).toEqual(tab("c"));
  expect(useChatStore.getState().bySession["codex/c"]).toBe(selectedState);
  expect(useChatStore.getState().sessions.some((s) => s.sessionId === "c")).toBe(true);
  expect(useChatStore.getState().drafts).toBe(drafts);
});

it("restores persisted tabs when no session has been selected on the new machine", async () => {
  useChatStore.getState().prepareMachineSwitch();
  persistTabs([tab("a"), tab("b")], tab("b"));
  await useChatStore.getState().replaceMachineCatalog(); await tick();
  expect(useChatStore.getState().active).toEqual(tab("b"));
  expect(useChatStore.getState().openTabs).toEqual([tab("a"), tab("b")]);
  expect(useChatStore.getState().bySession["codex/b"].messages).toEqual(page().messages);
});
