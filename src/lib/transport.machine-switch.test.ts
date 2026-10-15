import { afterEach, beforeEach, expect, it, vi } from "vitest";

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  send = vi.fn();
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
  hello() {
    this.onmessage?.({ data: JSON.stringify({ type: "hello", version: "test" }) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.instances = [];
  document.cookie = "ccgui_machine=; Max-Age=0";
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("WebSocket", Socket);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not send a queued write on the replacement machine's socket", async () => {
  const transport = await import("./transport");
  const write = transport.invoke("update_app_settings", { settings: { theme: "dark" } });
  const rejected = expect(write).rejects.toThrow("web bridge disconnected");
  const previous = Socket.instances[0];
  const before = transport.webBridgeGeneration();
  const reconnect = transport.reconnectWebBridge();
  const next = Socket.instances[1];
  next.open();
  next.hello();
  await reconnect;
  await rejected;
  expect(previous.send).not.toHaveBeenCalled();
  expect(next.send).not.toHaveBeenCalled();
  expect(transport.webBridgeGeneration()).toBeGreaterThan(before);

  const request = transport.invoke("get_app_settings");
  await Promise.resolve();
  const frame = JSON.parse(next.send.mock.calls[0][0]);
  next.onmessage?.({ data: JSON.stringify({ type: "response", id: frame.id, ok: true, payload: {} }) });
  await expect(request).resolves.toEqual({});
});

it("invalidates connection data on a disconnect, ignoring a late old close", async () => {
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const previous = Socket.instances[0];
  previous.open();
  const before = transport.webBridgeGeneration();
  previous.close();
  expect(transport.webBridgeGeneration()).toBeGreaterThan(before);
  const disconnected = transport.webBridgeGeneration();
  previous.close();
  expect(transport.webBridgeGeneration()).toBe(disconnected);
});

it("records history response size and parsing time without retaining its contents or arguments", async () => {
  const transport = await import("./transport");
  const { performanceRecorder } = await import("./performance-diagnostics");
  const request = transport.invoke("load_session_page", { engine: "codex", sessionId: "private-id", token: "credential" });
  const socket = Socket.instances[0];
  socket.open(); socket.hello(); await Promise.resolve();
  const frame = JSON.parse(socket.send.mock.calls[0][0]);
  const payload = { messages: [{ text: "secret 中文🙂" }] };
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "response", id: frame.id, ok: true, payload }));
  socket.onmessage?.({ data: bytes.buffer });
  await expect(request).resolves.toEqual(payload);
  expect(performanceRecorder.snapshot().transitions.at(-1)).toMatchObject({
    phase: "history-response", request: frame.id, bytes: bytes.length, session: 1,
  });
  expect(performanceRecorder.snapshot().pending.durations.historyParse?.count).toBe(1);
  expect(JSON.stringify(performanceRecorder.snapshot())).not.toMatch(/private-id|credential|secret|中文/);
});

it("keeps sockets, files and plugin siblings on this page's machine when another tab changes the cookie", async () => {
  document.cookie = "ccgui_machine=PC5";
  window.history.replaceState(null, "", "/CCGUI/");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const first = Socket.instances[0];
  expect(new URL(first.url).searchParams.get("machine")).toBe("PC5");
  first.open(); first.hello();
  document.cookie = "ccgui_machine=PC6";
  const { fileUrl } = await import("./platform");
  expect(new URL(fileUrl("E:/picture.png"), location.origin).searchParams.get("machine")).toBe("PC5");
  const { directoryAssetUrl } = await import("@/features/plugins/runtime/asset-url");
  expect(new URL("../texture.png", directoryAssetUrl("p", "grant", "model/a.json")).pathname)
    .toBe("/CCGUI/m/PC5/plugin-asset/-/p/dir/grant/texture.png");
  const reconnect = transport.reconnectWebBridge();
  const second = Socket.instances[1];
  expect(new URL(second.url).searchParams.get("machine")).toBe("PC5");
  second.open(); second.hello(); await reconnect;
});

it("keeps one global socket and captures each command's machine before a tab changes", async () => {
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC0");
  const transport = await import("./transport");
  const machines = await import("./web-machine");
  const first = transport.invoke("load_session_page", { engine: "codex", sessionId: "same" }, "PC0");
  const catalog = transport.invoke("list_sessions");
  machines.setWebMachine("PC6");
  const second = transport.invoke("load_session_page", { engine: "codex", sessionId: "same" }, "PC6");
  const socket = Socket.instances[0];
  const url = new URL(socket.url);
  expect(url.searchParams.get("global")).toBe("1");
  expect(url.searchParams.has("machine")).toBe(false);
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "hello", global: true, features: ["multi-machine"] }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(1);
  const frames = socket.send.mock.calls.map(([text]) => JSON.parse(text));
  expect(frames.map((frame) => frame.machine)).toEqual(["PC0", null, "PC6"]);
  for (const frame of frames) socket.onmessage?.({ data: JSON.stringify({ type: "response", id: frame.id, machine: frame.machine, ok: true, payload: frame.machine }) });
  await expect(first).resolves.toBe("PC0");
  await expect(catalog).resolves.toBeNull();
  await expect(second).resolves.toBe("PC6");
  const event = vi.fn();
  await transport.listen("engine://event", event);
  socket.onmessage?.({ data: JSON.stringify({ type: "event", name: "engine://event", machine: "PC0", payload: [{ sessionId: "same" }] }) });
  expect(event).toHaveBeenCalledWith({ payload: [{ sessionId: "same" }], machine: "PC0" });
});

it("rejects global commands before sending when the server lacks multi-machine support", async () => {
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC0");
  const transport = await import("./transport");
  const write = transport.invoke("send_message", { engine: "codex", prompt: "test" }, "PC6");
  const rejected = expect(write).rejects.toThrow(/Hub/);
  const socket = Socket.instances[0];
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.send).not.toHaveBeenCalled();
  socket.hello();
  await rejected;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(Socket.instances).toHaveLength(1);
  expect(socket.send).not.toHaveBeenCalled();
});
