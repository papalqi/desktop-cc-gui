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
}
beforeEach(() => {
  vi.resetModules();
  Socket.instances = [];
  window.history.replaceState(null, "", "/CCGUI/");
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function connected() {
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({ type: "hello", features: [] });
  return { transport, socket };
}

it("does not send a command again after the executor reports it as unknown", async () => {
  const { transport, socket } = await connected();
  const first = transport.invoke("list_plan_reviews", { engine: "codex", sessionId: "s" });
  await Promise.resolve();
  expect(socket.send).toHaveBeenCalledTimes(1);
  socket.receive({ type: "response", id: 1, ok: false, error: "unknown command: list_plan_reviews" });
  await expect(first).rejects.toThrow("unknown command: list_plan_reviews");

  const second = transport.invoke("list_plan_reviews", { engine: "codex", sessionId: "s" });
  await expect(second).rejects.toThrow("unknown command: list_plan_reviews");
  expect(socket.send).toHaveBeenCalledTimes(1);

  const other = transport.invoke("list_sessions");
  await Promise.resolve();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: 2, ok: true, payload: [] });
  await expect(other).resolves.toEqual([]);
});
