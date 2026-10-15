import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = (await readFile(new URL("./check-relay.mjs", import.meta.url), "utf8"))
  .replace('import { readFileSync } from "node:fs";', "const { readFileSync } = fixtureFs;");

async function check(observer) {
  const output = [], errors = [], exits = [];
  class Socket {
    constructor() { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "hello", hub: true, version: "1.1.3" }) })); }
    send(json) {
      const frame = JSON.parse(json);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "response", id: frame.id, ok: true, payload: frame.id === 1 ? [] : [{ id: 1 }] }) }));
    }
    close() {}
  }
  await runInNewContext(`(async () => { ${source}\n })()`, {
    Buffer, URL, AbortSignal, setTimeout, clearTimeout, WebSocket: Socket,
    fixtureFs: { readFileSync: () => JSON.stringify({ sessions: { test: Date.now() + 60000 } }) },
    process: { argv: ["node", "check-relay.mjs", Buffer.from(JSON.stringify({ machine: "PC6", sessionFile: "sessions.json", wsUrl: "ws://localhost/ws" })).toString("base64")], exit: (code) => exits.push(code) },
    console: { log: (line) => output.push(JSON.parse(line)), error: (line) => errors.push(line) },
    fetch: async (url) => String(url).endsWith("/_relay/api/status")
      ? { ok: true, json: async () => ({ data: { machines: [{ name: "PC6", observer }] } }) }
      : String(url).endsWith("/assets/app.js")
        ? { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }
        : { ok: true, text: async () => '<script type="module" src="/assets/app.js"></script>' },
  });
  return { output, errors, exits };
}

test("deployment verifies the executor version when the Hub hello has another version", async () => {
  const result = await check({ state: "ready", version: "1.2.0" });
  assert.deepEqual(result.output, [{ activeRuns: 0, workspaces: 1, version: "1.2.0", frontend: true }]);
  assert.deepEqual(result.exits, [0]);
});

test("deployment fails when the executor version cannot be confirmed", async () => {
  const result = await check({ state: "offline", version: "1.2.0" });
  assert.deepEqual(result.output, []);
  assert.deepEqual(result.exits, [1]);
  assert.match(result.errors[0], /Executor version is unavailable/);
});
