import { webPublicPrefix } from "@/lib/web-public-prefix";
import { webMultiMachine } from "./web-machine";
import { invoke as bridgeInvoke } from "./transport";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const CATALOG_TIMEOUT_MS = 8_000;

/**
 * One short WebSocket to a relay desktop other than the cookie's machine.
 * The relay routes `/ws?machine=` to that agent and leaves the page socket
 * on the machine the user is looking at. The socket closes when `run` settles.
 */
export function queryMachine<T>(
  machine: string,
  run: (invoke: Invoke) => Promise<T>,
): Promise<T> {
  if (webMultiMachine()) return run((cmd, args) => bridgeInvoke(cmd, args, machine));
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const prefix = webPublicPrefix(location.pathname);
    const token = new URLSearchParams(location.search).get("token") ?? "";
    const url =
      `${proto}://${location.host}${prefix}/ws?hub=1&token=${encodeURIComponent(token)}` +
      `&machine=${encodeURIComponent(machine)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 1;
    let hello = false;
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closing.
      }
      for (const entry of pending.values()) entry.reject(error ?? new Error("machine bridge closed"));
      pending.clear();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error("machine catalog timed out")), CATALOG_TIMEOUT_MS);
    const invoke: Invoke = (cmd, args) =>
      new Promise((res, rej) => {
        if (!hello || ws.readyState !== WebSocket.OPEN) {
          rej(new Error("machine bridge is not ready"));
          return;
        }
        const id = nextId++;
        const slow = setTimeout(() => {
          pending.delete(id);
          rej(new Error("machine catalog timed out"));
        }, CATALOG_TIMEOUT_MS);
        pending.set(id, {
          resolve: (payload) => {
            clearTimeout(slow);
            res(payload as never);
          },
          reject: (error) => {
            clearTimeout(slow);
            rej(error);
          },
        });
        ws.send(JSON.stringify({ type: "invoke", id, cmd, args: args ?? {} }));
      });
    ws.onmessage = (event) => {
      const text =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      let msg: { type?: string; id?: unknown; ok?: boolean; payload?: unknown; error?: unknown };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === "hello") {
        if (hello) return;
        hello = true;
        run(invoke).then(
          (value) => finish(undefined, value),
          (error) => finish(error instanceof Error ? error : new Error(String(error))),
        );
        return;
      }
      if (msg.type !== "response") return;
      const entry = pending.get(Number(msg.id));
      if (!entry) return;
      pending.delete(Number(msg.id));
      if (msg.ok) entry.resolve(msg.payload);
      else entry.reject(new Error(String(msg.error ?? "unknown error")));
    };
    ws.onerror = () => {
      // onclose reports the failure.
    };
    ws.onclose = () => {
      if (!settled) finish(new Error("machine bridge closed"));
    };
  });
}
