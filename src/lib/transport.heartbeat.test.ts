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
  // A dead network path leaves the browser in the closing handshake: no onclose.
  close = vi.fn();
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  hello(features?: string[]) {
    this.receive({ type: "hello", version: "test", hub: true, ...(features ? { features } : {}) });
  }
  pings() {
    return this.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === "ping").length;
  }
  fireClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.instances = [];
  window.history.replaceState(null, "", "/CCGUI/");
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected(features?: string[]) {
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.hello(features);
  return { transport, socket };
}

it("keeps a quiet hub socket that answers its ping", async () => {
  const { transport, socket } = await connected(["ping"]);
  expect(transport.webBridgeState()).toBe("open");
  vi.advanceTimersByTime(14_000);
  expect(socket.pings()).toBe(0);
  vi.advanceTimersByTime(1_000);
  expect(socket.pings()).toBe(1);
  socket.receive({ type: "pong", id: null });
  vi.advanceTimersByTime(10_000);
  expect(socket.close).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(1);
  expect(transport.webBridgeState()).toBe("open");
});

it("replaces a half-open socket and fails its pending calls instead of waiting forever", async () => {
  const { transport, socket } = await connected(["ping"]);
  const request = transport.invoke("get_app_settings");
  const rejected = expect(request).rejects.toThrow("web bridge disconnected");
  const before = transport.webBridgeGeneration();
  vi.advanceTimersByTime(15_000);
  expect(socket.pings()).toBe(1);
  vi.advanceTimersByTime(10_000);
  await rejected;
  expect(socket.close).toHaveBeenCalledWith(4000, "heartbeat timeout");
  expect(transport.webBridgeState()).toBe("reconnecting");
  expect(transport.webBridgeGeneration()).toBe(before + 1);

  vi.advanceTimersByTime(1_000);
  expect(Socket.instances).toHaveLength(2);
  const next = Socket.instances[1];
  next.open();
  next.hello(["ping"]);
  expect(transport.webBridgeState()).toBe("open");
  // The dead socket's late close and frames must not touch the new connection.
  socket.fireClose();
  socket.hello(["ping"]);
  expect(transport.webBridgeGeneration()).toBe(before + 1);
  expect(Socket.instances).toHaveLength(2);
});

it("never pings a server that did not advertise it", async () => {
  const { transport, socket } = await connected();
  vi.advanceTimersByTime(60_000);
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  vi.advanceTimersByTime(10_000);
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).not.toHaveBeenCalled();
  expect(transport.webBridgeState()).toBe("open");
});

it("asks right away when the tab returns, and reconnects if nobody answers", async () => {
  const { transport, socket } = await connected(["ping"]);
  vi.advanceTimersByTime(2_000);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(socket.pings()).toBe(1);
  vi.advanceTimersByTime(5_000);
  expect(socket.close).toHaveBeenCalledWith(4000, "heartbeat timeout");
  expect(transport.webBridgeState()).toBe("reconnecting");
});

it("replays the latest machine status to a subscriber that arrives after the push", async () => {
  const { transport, socket } = await connected(["ping", "machines"]);
  expect(transport.webBridgeFeature("machines")).toBe(true);
  const status = { machines: [{ name: "PC5", online: true, runs: [] }] };
  socket.receive({ type: "event", name: "machines://status", payload: status });
  socket.receive({ type: "event", name: "engine://event", payload: [] });
  const late: unknown[] = [];
  const other: unknown[] = [];
  await transport.listen("machines://status", (event) => late.push(event.payload));
  const stop = await transport.listen("engine://event", (event) => other.push(event.payload));
  await Promise.resolve();
  expect(late).toEqual([status]);
  expect(other).toEqual([]);
  stop();
});

it("reports connecting until the first hello and after an explicit machine switch", async () => {
  const transport = await import("./transport");
  const states: string[] = [];
  transport.subscribeWebBridgeState(() => states.push(transport.webBridgeState()));
  expect(transport.webBridgeState()).toBe("connecting");
  await transport.listen("test", () => {});
  Socket.instances[0].fireClose();
  expect(transport.webBridgeState()).toBe("connecting");
  vi.advanceTimersByTime(1_000);
  Socket.instances[1].open();
  Socket.instances[1].hello(["ping"]);
  const switching = transport.reconnectWebBridge("PC6");
  expect(transport.webBridgeState()).toBe("connecting");
  Socket.instances[2].open();
  Socket.instances[2].hello(["ping"]);
  await switching;
  expect(states).toEqual(["open", "connecting", "open"]);
});
