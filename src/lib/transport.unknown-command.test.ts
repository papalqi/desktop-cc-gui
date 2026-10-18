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

const UNKNOWN = "unknown command: list_plan_reviews";
const HUB_FEATURES = ["ping", "machines", "delivery", "multi-machine", "notifications"];

/** Browser hello from `ccgui-hub.mjs` `open`: hub version, not the executor's. */
function hubHello(options: { machine: string | null; online: boolean; version?: string; global?: boolean }) {
  return {
    type: "hello",
    version: options.version ?? "1.1.3",
    hub: true,
    machine: options.machine,
    online: options.online,
    features: HUB_FEATURES,
    ...(options.global ? { global: true } : {}),
  };
}

/** `publishStatus` frame: one catalog row per machine, sent only when the text changes. */
function machineStatus(rows: { name: string; online: boolean; runs?: unknown[] }[]) {
  return {
    type: "event",
    name: "machines://status",
    payload: {
      machines: rows.map((row, order) => ({
        name: row.name,
        machineId: `${row.name.toLowerCase()}-id`,
        hidden: false,
        retired: false,
        order,
        online: row.online,
        runs: row.runs ?? [],
      })),
    },
  };
}

const RUN = { runId: "run-1", engine: "codex", sessionId: "s", workspacePath: "/work", startedAt: 1 };

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

it("resends once when machines://status shows that machine back online", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive(hubHello({ machine: "MC2", online: true }));
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: UNKNOWN });
  await expect(first).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [] }]));
  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [RUN] }]));
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(1);

  socket.receive(machineStatus([{ name: "MC2", online: false, runs: [] }]));
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(1);

  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [] }]));
  const again = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: frameAt(socket, 1).id, ok: false, error: UNKNOWN });
  await expect(again).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [{ ...RUN, runId: "run-2" }] }]));
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(2);

  socket.receive(machineStatus([{ name: "PC0", online: true, runs: [] }]));
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  const returned = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(3);
  socket.receive({ type: "response", id: frameAt(socket, 2).id, ok: true, payload: [] });
  await expect(returned).resolves.toEqual([]);
});

it("does not clear MC2 when another machine comes back online", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive(hubHello({ machine: "MC2", online: true }));
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: UNKNOWN });
  await expect(first).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: false, runs: [] },
  ]));
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [RUN] },
    { name: "PC0", online: true, runs: [] },
  ]));
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(1);

  socket.receive(machineStatus([
    { name: "MC2", online: false, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  const again = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: frameAt(socket, 1).id, ok: true, payload: [] });
  await expect(again).resolves.toEqual([]);
});

it("does not clear on the first status after open when the machine is already online", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive(hubHello({ machine: "MC2", online: true, version: "1.3.3" }));
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: UNKNOWN });
  await expect(first).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [RUN] }]));
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(1);

  socket.receive(machineStatus([{ name: "MC2", online: false, runs: [] }]));
  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [] }]));
  const again = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: frameAt(socket, 1).id, ok: true, payload: [] });
  await expect(again).resolves.toEqual([]);
});

it("treats a hub hello of online false as offline before the first status", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive(hubHello({ machine: "MC2", online: false }));
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: UNKNOWN });
  await expect(first).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [] }]));
  const again = transport.invoke("list_plan_reviews");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  socket.receive({ type: "response", id: frameAt(socket, 1).id, ok: false, error: UNKNOWN });
  await expect(again).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([{ name: "MC2", online: true, runs: [RUN] }]));
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(2);
});

it("applies the online edge per machine on a multi-machine socket", async () => {
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC0");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive(hubHello({ machine: null, online: true, global: true }));

  const older = transport.invoke("list_plan_reviews", {}, "MC2");
  await flush();
  expect(frameAt(socket, 0).machine).toBe("MC2");
  socket.receive({ type: "response", id: frameAt(socket, 0).id, machine: "MC2", ok: false, error: UNKNOWN });
  await expect(older).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [RUN] },
    { name: "PC0", online: true, runs: [] },
  ]));
  await expect(transport.invoke("list_plan_reviews", {}, "MC2")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(1);

  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: false, runs: [] },
  ]));
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  await expect(transport.invoke("list_plan_reviews", {}, "MC2")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(1);

  socket.receive(machineStatus([
    { name: "MC2", online: false, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: true, runs: [] },
  ]));
  const again = transport.invoke("list_plan_reviews", {}, "MC2");
  await flush();
  expect(socket.send).toHaveBeenCalledTimes(2);
  expect(frameAt(socket, 1).machine).toBe("MC2");
  socket.receive({ type: "response", id: frameAt(socket, 1).id, machine: "MC2", ok: false, error: UNKNOWN });
  await expect(again).rejects.toThrow(UNKNOWN);

  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [] },
    { name: "PC0", online: false, runs: [] },
  ]));
  socket.receive(machineStatus([
    { name: "MC2", online: true, runs: [RUN] },
    { name: "PC0", online: true, runs: [] },
  ]));
  await expect(transport.invoke("list_plan_reviews", {}, "MC2")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(2);
});

it("clears a hub reconnect through the new socket, not the hub hello version", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=MC2");
  const transport = await import("./transport");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive(hubHello({ machine: "MC2", online: true, version: "1.1.3" }));
  const first = transport.invoke("list_plan_reviews");
  await flush();
  socket.receive({ type: "response", id: frameAt(socket, 0).id, ok: false, error: UNKNOWN });
  await expect(first).rejects.toThrow(UNKNOWN);
  await expect(transport.invoke("list_plan_reviews")).rejects.toThrow(UNKNOWN);
  expect(socket.send).toHaveBeenCalledTimes(1);

  const reconnected = transport.reconnectWebBridge("MC2");
  const next = Socket.instances[1];
  next.open();
  const during = transport.invoke("list_plan_reviews");
  await flush();
  expect(next.send).toHaveBeenCalledTimes(1);
  next.receive({ type: "response", id: frameAt(next, 0).id, ok: false, error: UNKNOWN });
  await expect(during).rejects.toThrow(UNKNOWN);

  next.receive(hubHello({ machine: "MC2", online: true, version: "1.3.3" }));
  await reconnected;
  const after = transport.invoke("list_plan_reviews");
  const settled = after.then(() => "sent", () => "cached");
  await flush();
  if (next.send.mock.calls.length > 1) {
    next.receive({ type: "response", id: frameAt(next, 1).id, ok: true, payload: [] });
  }
  expect(next.send).toHaveBeenCalledTimes(1);
  expect(await settled).toBe("cached");
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
