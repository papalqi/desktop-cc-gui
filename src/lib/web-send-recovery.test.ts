import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { RunDelivery } from "./web-send-recovery";

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  send = vi.fn();
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
  fireClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const args = { runId: "run-1", sessionId: "s" };
const answer = (delivery: RunDelivery["delivery"], sessionId: string | null = "s"): RunDelivery =>
  ({ runId: "run-1", delivery, active: delivery === "acknowledged", sessionId, terminal: null });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.instances = [];
  window.history.replaceState(null, "", "/CCGUI/");
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  await i18n.changeLanguage("zh");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected(features = ["ping", "machines", "delivery"]) {
  const transport = await import("./transport");
  const recovery = await import("./web-send-recovery");
  await transport.listen("test", () => {});
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({ type: "hello", version: "test", hub: true, machine: "PC6", features });
  const send = () => transport.invoke<{ runId: string; sessionId: string | null }>("send_message", args);
  return { transport, recovery, socket, send };
}

it("a send lost after it left the page resolves from the hub's delivery record", async () => {
  const { recovery, socket, send } = await connected();
  const query = vi.fn()
    .mockResolvedValueOnce(answer("in-flight", null))
    .mockResolvedValueOnce(answer("acknowledged", "native"));
  const result = recovery.sendWithDeliveryRecovery(args, send, query);
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).cmd).toBe("send_message");
  socket.fireClose();
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(result).resolves.toEqual({ runId: "run-1", sessionId: "native" });
  expect(query).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledWith("PC6", "run-1");
});

it("an acknowledged run without a native id yet keeps the tab's session", async () => {
  const { recovery, socket, send } = await connected();
  const query = vi.fn().mockResolvedValue(answer("acknowledged", null));
  const result = recovery.sendWithDeliveryRecovery(args, send, query);
  await vi.advanceTimersByTimeAsync(0);
  socket.fireClose();
  await expect(result).resolves.toEqual({ runId: "run-1", sessionId: "s" });
});

it("a send the hub never received or the machine rejected may be sent again", async () => {
  for (const [delivery, text] of [["not-received", "chat.sendNotDelivered"], ["failed", "chat.sendRejected"]] as const) {
    const { recovery, socket, send } = await connected();
    const query = vi.fn().mockResolvedValue(answer(delivery));
    const close = vi.fn(async () => answer(delivery));
    const result = recovery.sendWithDeliveryRecovery(args, send, query, undefined, close);
    const settled = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    socket.fireClose();
    const error = await settled;
    expect(error).not.toBeInstanceOf(recovery.SendDeliveryUnknownError);
    expect((error as Error).message).toBe(i18n.t(text));
    if (delivery === "not-received") expect(close).toHaveBeenCalledWith("PC6", "run-1");
    else expect(close).not.toHaveBeenCalled();
    vi.resetModules();
    Socket.instances = [];
  }
});

it("closing an unseen run that actually landed keeps the send", async () => {
  const { recovery, socket, send } = await connected();
  const query = vi.fn().mockResolvedValue(answer("not-received"));
  const close = vi.fn(async () => answer("acknowledged", "native"));
  const result = recovery.sendWithDeliveryRecovery(args, send, query, undefined, close);
  await vi.advanceTimersByTimeAsync(0);
  socket.fireClose();
  await expect(result).resolves.toEqual({ runId: "run-1", sessionId: "native" });
  expect(close).toHaveBeenCalledOnce();
});

it("a close that cannot be confirmed does not say the prompt is safe to resend", async () => {
  const { recovery, socket, send } = await connected();
  const query = vi.fn().mockResolvedValue(answer("not-received"));
  const close = vi.fn().mockRejectedValue(new Error("bridge closed"));
  const pending = recovery.sendWithDeliveryRecovery(args, send, query, undefined, close).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  socket.fireClose();
  const error = await pending;
  expect(error).toBeInstanceOf(recovery.SendDeliveryUnknownError);
  expect((error as Error).message).toBe(i18n.t("chat.sendDeliveryUnknown"));
});

it("a request that never left the page is not sent and needs no hub query", async () => {
  const transport = await import("./transport");
  const recovery = await import("./web-send-recovery");
  const query = vi.fn();
  const close = vi.fn();
  const result = recovery.sendWithDeliveryRecovery(args, () => transport.invoke("send_message", args), query, undefined, close);
  const settled = result.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  Socket.instances[0].fireClose();
  const error = await settled;
  expect((error as Error).message).toBe(i18n.t("chat.sendNotDelivered"));
  expect(error).not.toBeInstanceOf(recovery.SendDeliveryUnknownError);
  expect(query).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("an unreachable hub or an uncertain record never reports the prompt as unsent", async () => {
  const { recovery, socket, send } = await connected();
  const unreachable = vi.fn().mockRejectedValue(new Error("machine bridge closed"));
  const lost = recovery.sendWithDeliveryRecovery(args, send, unreachable).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  socket.fireClose();
  await vi.advanceTimersByTimeAsync(59_000);
  expect(unreachable.mock.calls.length).toBeGreaterThan(5);
  expect(unreachable.mock.calls.length).toBeLessThan(40);
  await vi.advanceTimersByTimeAsync(2_000);
  const error = await lost;
  expect(error).toBeInstanceOf(recovery.SendDeliveryUnknownError);
  expect((error as Error).message).toBe(i18n.t("chat.sendDeliveryUnknown"));

  vi.advanceTimersByTime(1_000);
  const next = Socket.instances.at(-1)!;
  next.open();
  next.receive({ type: "hello", version: "test", hub: true, machine: "PC6", features: ["ping", "machines", "delivery"] });
  const uncertain = vi.fn().mockResolvedValue(answer("indeterminate"));
  const pending = recovery.sendWithDeliveryRecovery(args, send, uncertain).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  next.fireClose();
  expect(await pending).toBeInstanceOf(recovery.SendDeliveryUnknownError);
});

it("an older hub without delivery records reports an uncertain send without querying", async () => {
  const { recovery, socket, send } = await connected(["ping"]);
  const query = vi.fn();
  const pending = recovery.sendWithDeliveryRecovery(args, send, query).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  socket.fireClose();
  expect(await pending).toBeInstanceOf(recovery.SendDeliveryUnknownError);
  expect(query).not.toHaveBeenCalled();
});

it("the default recovery query does not let the hub abandon the id before close", async () => {
  const { recovery, socket, send } = await connected();
  const pending = recovery.sendWithDeliveryRecovery(args, send).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  socket.fireClose();
  await vi.advanceTimersByTimeAsync(0);
  const bridge = Socket.instances.at(-1)!;
  expect(bridge).not.toBe(socket);
  bridge.open();
  bridge.receive({ type: "hello", version: "test", hub: true, machine: "PC6", features: ["ping", "machines", "delivery"] });
  await vi.advanceTimersByTimeAsync(0);
  const query = JSON.parse(bridge.send.mock.calls.at(-1)![0]);
  expect(query).toMatchObject({
    type: "invoke",
    cmd: "get_run_delivery",
    args: { runId: "run-1", waitMs: 4_000, closeIfMissing: false },
  });
  bridge.receive({ type: "response", id: query.id, ok: true, payload: answer("not-received") });
  await vi.advanceTimersByTimeAsync(0);
  const closer = Socket.instances.at(-1)!;
  expect(closer).not.toBe(bridge);
  closer.open();
  closer.receive({ type: "hello", version: "test", hub: true, machine: "PC6", features: ["ping", "machines", "delivery"] });
  await vi.advanceTimersByTimeAsync(0);
  const close = JSON.parse(closer.send.mock.calls.at(-1)![0]);
  expect(close.cmd).toBe("close_unreceived_run");
  expect(close.args).toEqual({ runId: "run-1" });
  closer.receive({ type: "response", id: close.id, ok: true, payload: answer("not-received") });
  const error = await pending;
  expect((error as Error).message).toBe(i18n.t("chat.sendNotDelivered"));
});

it("an executor error is passed through unchanged", async () => {
  const { recovery, socket, send } = await connected();
  const query = vi.fn();
  const pending = recovery.sendWithDeliveryRecovery(args, send, query);
  await vi.advanceTimersByTimeAsync(0);
  const id = JSON.parse(socket.send.mock.calls.at(-1)![0]).id;
  socket.receive({ type: "response", id, ok: false, error: "engine not installed" });
  await expect(pending).rejects.toThrow("engine not installed");
  expect(query).not.toHaveBeenCalled();
});

it("an offline executor leaves delivery waiting without resending the prompt", async () => {
  const { recovery, socket, send } = await connected();
  const query = vi.fn().mockResolvedValue(answer("waiting-executor"));
  const result = recovery.sendWithDeliveryRecovery(args, send, query).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  socket.fireClose();
  const error = await result;
  expect(error).toBeInstanceOf(recovery.SendDeliveryUnknownError);
  expect((error as Error).message).toBe(i18n.t("chat.sendWaitingExecutor"));
  expect(socket.send.mock.calls.filter(([frame]) => JSON.parse(frame).cmd === "send_message")).toHaveLength(1);
});
