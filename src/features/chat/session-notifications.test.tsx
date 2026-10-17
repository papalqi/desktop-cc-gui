import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { SessionNotificationControl, useSessionNotifications } from "./session-notifications";
import { useChatStore } from "./store";

const env = vi.hoisted(() => ({ notify: null as null | ((event: { payload: unknown }) => void), off: vi.fn(), request: vi.fn(), select: vi.fn(async () => {}) }));
vi.mock("@/lib/transport", () => ({
  isWeb: true, webBridgeFeature: () => true, subscribeWebBridgeState: () => () => {},
  listen: async (_name: string, callback: typeof env.notify) => { env.notify = callback; return env.off; },
}));
vi.mock("@/lib/web-machine", () => ({ webMultiMachine: () => true, webMachine: () => "PC0" }));
vi.mock("./relay-machines", () => ({ switchRelayMachine: vi.fn() }));
vi.mock("./center-surfaces", () => ({ dismissCenterSurfaces: vi.fn() }));
vi.mock("./store", async () => {
  const { create } = await import("zustand");
  return {
    sessionKey: (engine: string, id: string, _path: string, machine: string) => `${machine}/${engine}/${id}`,
    useChatStore: create(() => ({ unseen: {} as Record<string, boolean>, active: null, selectSession: env.select })),
  };
});

const shown: FakeNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = env.request;
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly title: string, readonly options: NotificationOptions) { shown.push(this); }
  close() { this.closed = true; this.onclose?.(); }
}
let root: Root;
let container: HTMLDivElement;
function Harness() { useSessionNotifications(); return <SessionNotificationControl />; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  FakeNotification.permission = "default";
  shown.length = 0;
  localStorage.clear();
  env.notify = null;
  env.off.mockClear();
  env.select.mockClear();
  env.request.mockReset().mockImplementation(async () => { FakeNotification.permission = "granted"; return "granted"; });
  useChatStore.setState({
    unseen: {},
    active: null,
    sessions: [],
    workspaces: [],
    workspaceAliases: {},
  });
  document.title = "CC GUI";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("asks permission only on click and keeps notifications and unread state on the originating machine", async () => {
  await act(async () => root.render(<Harness />));
  expect(env.request).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(env.request).toHaveBeenCalledTimes(1);
  await act(async () => useChatStore.setState({
    sessions: [{
      engine: "codex", sessionId: "same", workspacePath: "/repo/pay", machine: "PC6",
      filePath: "/repo/pay/same.jsonl", fileSize: 1, fileMtimeMs: 1, preview: "",
      createdAt: null, updatedAt: 1, messageCount: 1, pinned: false,
      customTitle: null, title: "帮我看看登录",
    }],
    workspaces: [{ id: "PC6/w", path: "/repo/pay", name: "pay", machine: "PC6", lastOpenedAt: null, sortOrder: 0, groupId: null }],
    workspaceAliases: { "PC6/w": "支付后端" },
  }));
  const item = { id: "PC6-done", machine: "PC6", engine: "codex", sessionId: "same", workspacePath: "/repo/pay", state: "done", data: "SECRET" };
  await act(async () => { env.notify!({ payload: item }); env.notify!({ payload: item }); });
  expect(shown).toHaveLength(1);
  expect(shown[0].options.body).toBe("PC6 · codex · 支付后端");
  expect(shown[0].options.body).not.toContain("帮我看看登录");
  expect(shown[0].options.body).not.toContain("SECRET");
  expect(useChatStore.getState().unseen).toEqual({ "PC6/codex/same": true });
  expect(document.title).toBe("(1) CC GUI");
  await act(async () => useChatStore.setState({
    active: { engine: "codex", sessionId: "same", workspacePath: "/repo/pay", machine: "PC6" },
  }));
  expect(document.title).toBe("(1) PC6 · 支付后端 · 帮我看看登录");
  await act(async () => shown[0].onclick!());
  expect(env.select).toHaveBeenCalledWith("codex", "same", "/repo/pay", "PC6");
  expect(shown[0].closed).toBe(true);
});

it("keeps unread feedback when permission is denied and cleans up the subscription and title", async () => {
  env.request.mockResolvedValueOnce("denied");
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("浏览器未允许通知");
  await act(async () => env.notify!({ payload: { id: "error", machine: "PC0", engine: "grok", sessionId: "same", workspacePath: "/same", state: "error" } }));
  expect(shown).toHaveLength(0);
  expect(document.title).toBe("(1) CC GUI");
  await act(async () => root.render(null));
  expect(document.title).toBe("CC GUI");
  expect(env.off).toHaveBeenCalledTimes(1);
});
