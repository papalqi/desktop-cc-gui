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
  document.cookie = "ccgui_machine=; Max-Age=0";
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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function frameAt(socket: Socket, index: number): { id: number; cmd: string; machine?: string | null } {
  return JSON.parse(socket.send.mock.calls[index][0]);
}

it("does not let an unknown command on one machine block another", async () => {
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC0");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({ type: "hello", global: true, features: ["multi-machine"], version: "1.3.0" });

  const older = transport.invoke("list_plan_reviews", {}, "MC2");
  await flush();
  expect(frameAt(socket, 0).machine).toBe("MC2");
  socket.receive({ type: "response", id: frameAt(socket, 0).id, machine: "MC2", ok: false, error: "unknown command: list_plan_reviews" });
  await expect(older).rejects.toThrow("unknown command: list_plan_reviews");

  const newer = transport.invoke("list_plan_reviews", {}, "PC0");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  expect(frameAt(socket, 1).machine).toBe("PC0");
  socket.receive({ type: "response", id: frameAt(socket, 1).id, machine: "PC0", ok: true, payload: [] });
  await expect(newer).resolves.toEqual([]);

  const repeat = transport.invoke("list_plan_reviews", {}, "MC2");
  await expect(repeat).rejects.toThrow("unknown command: list_plan_reviews");
  expect(socket.send).toHaveBeenCalledTimes(2);
});

it("does not keep an unknown command after the page switches machine", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const { transport, socket } = await connected();
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: "unknown command: list_plan_reviews" });
  await expect(first).rejects.toThrow("unknown command: list_plan_reviews");

  const { setWebMachine } = await import("./web-machine");
  setWebMachine("PC0");
  const second = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: frameAt(socket, 1).id, ok: true, payload: [] });
  await expect(second).resolves.toEqual([]);
});

it("sends an unknown command again after the bridge reconnects to that machine", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({ type: "hello", features: [], version: "1.3.0" });
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: "unknown command: list_plan_reviews" });
  await expect(first).rejects.toThrow("unknown command: list_plan_reviews");
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow("unknown command: list_plan_reviews");
  expect(socket.send).toHaveBeenCalledTimes(1);

  const reconnected = transport.reconnectWebBridge("MC2");
  const next = Socket.instances[1];
  next.open();
  next.receive({ type: "hello", features: [], version: "1.3.0" });
  await reconnected;
  const again = transport.invoke("list_plan_reviews");
  await flush();
  expect(next.send).toHaveBeenCalledTimes(1);
  expect(frameAt(next, 0).cmd).toBe("list_plan_reviews");
  next.receive({ type: "response", id: frameAt(next, 0).id, ok: false, error: "unknown command: list_plan_reviews" });
  await expect(again).rejects.toThrow("unknown command: list_plan_reviews");
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow("unknown command: list_plan_reviews");
  expect(next.send).toHaveBeenCalledTimes(1);
});

it("sends an unknown command again when hello reports a different executor version", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({ type: "hello", features: [], version: "1.3.0", machine: "MC2" });
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: "unknown command: list_plan_reviews" });
  await expect(first).rejects.toThrow("unknown command: list_plan_reviews");

  socket.receive({ type: "hello", features: [], version: "1.3.0", machine: "MC2" });
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow("unknown command: list_plan_reviews");
  expect(socket.send).toHaveBeenCalledTimes(1);

  socket.receive({ type: "hello", features: [], version: "1.3.2", machine: "MC2" });
  const upgraded = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: frameAt(socket, 1).id, ok: true, payload: [] });
  await expect(upgraded).resolves.toEqual([]);
});

it("keeps an unknown discovered before hello on the machine hello names", async () => {
  const transport = await import("./transport");
  const first = transport.invoke("list_plan_reviews");
  const socket = Socket.instances[0];
  socket.open();
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: "unknown command: list_plan_reviews" });
  await expect(first).rejects.toThrow("unknown command: list_plan_reviews");
  socket.receive({ type: "hello", features: [], version: "1.3.0", machine: "MC2" });

  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow("unknown command: list_plan_reviews");
  expect(socket.send).toHaveBeenCalledTimes(1);

  const { setWebMachine } = await import("./web-machine");
  setWebMachine("PC0");
  const other = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: frameAt(socket, 1).id, ok: true, payload: [] });
  await expect(other).resolves.toEqual([]);
});
