import { afterEach, beforeEach, expect, it, vi } from "vitest";

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  close = vi.fn();
  constructor() { Socket.instances.push(this); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  disconnect() { this.readyState = 3; this.onclose?.(); }
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); Socket.instances = [];
  window.history.replaceState(null, "", "/CCGUI/");
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function connected() {
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0]; socket.open(); socket.receive({ type: "hello", features: [] });
  return { transport, socket };
}

it("times out ordinary requests at 30 seconds, ignores late replies and never replays a write", async () => {
  const { transport, socket } = await connected();
  const request = transport.invoke("rename_session", { title: "changed" });
  const rejected = expect(request).rejects.toThrow("请求 rename_session 超时");
  await vi.advanceTimersByTimeAsync(29_999);
  expect(socket.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  socket.receive({ type: "response", id: 1, ok: true, payload: "late" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(socket.send).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it.each(["add_workspace", "plugin_add_workspace", "read_file", "rescan_sessions", "git_push"])("allows 120 seconds for %s", async (command) => {
  const { transport, socket } = await connected();
  const request = transport.invoke(command);
  const rejected = expect(request).rejects.toBeInstanceOf(transport.WebBridgeTimeoutError);
  let settled = false; void request.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(119_999); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(socket.send).toHaveBeenCalledTimes(1);
});

it("leaves send_message confirmation to delivery recovery without a request deadline", async () => {
  const { transport, socket } = await connected();
  const request = transport.invoke("send_message");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(socket.send).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  socket.receive({ type: "response", id: 1, ok: true, payload: { runId: "r" } });
  await expect(request).resolves.toEqual({ runId: "r" });
});

it("includes connecting time and does not send a request after its deadline", async () => {
  const transport = await import("./transport");
  const request = transport.invoke("list_sessions");
  const rejected = expect(request).rejects.toBeInstanceOf(transport.WebBridgeTimeoutError);
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  const socket = Socket.instances[0]; socket.open(); await Promise.resolve();
  expect(socket.send).not.toHaveBeenCalled();
});

it("clears deadlines on success and reports an unsent request correctly on a connection failure", async () => {
  const { transport, socket } = await connected();
  const request = transport.invoke("list_sessions"); await Promise.resolve();
  socket.receive({ type: "response", id: 1, ok: true, payload: [] });
  await expect(request).resolves.toEqual([]); expect(vi.getTimerCount()).toBe(0);
  socket.send.mockImplementationOnce(() => { throw new Error("closed"); });
  await expect(transport.invoke("rename_session")).rejects.toMatchObject({ sent: false });
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the current UI language and clears pending deadlines when switching machines", async () => {
  const { transport, socket } = await connected();
  const i18n = (await import("./i18n")).default; await i18n.changeLanguage("en");
  const request = transport.invoke("list_sessions");
  const rejected = expect(request).rejects.toThrow("Request list_sessions timed out");
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  const nextRequest = transport.invoke("list_sessions"); await Promise.resolve();
  const disconnected = expect(nextRequest).rejects.toMatchObject({ sent: true });
  const switched = transport.reconnectWebBridge("PC5");
  const next = Socket.instances[1]; next.open(); next.receive({ type: "hello", machine: "PC5" });
  await disconnected; await switched; expect(vi.getTimerCount()).toBe(0);
  expect(socket.send).toHaveBeenCalledTimes(2);
});

it("releases reconnect and access probes when their owning page is destroyed", async () => {
  const { socket } = await connected();
  socket.disconnect();
  expect(vi.getTimerCount()).toBe(2);
  vi.stubGlobal("window", undefined);
  await vi.advanceTimersByTimeAsync(200);
  expect(vi.getTimerCount()).toBe(0); expect(Socket.instances).toHaveLength(1);
});
