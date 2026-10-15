// Runs on the relay host via Bun stdin. Credentials never leave that host.
import { readFileSync } from "node:fs";

const { machine, sessionFile, wsUrl } = JSON.parse(Buffer.from(process.argv[2], "base64").toString());
const sessions = JSON.parse(readFileSync(sessionFile, "utf8")).sessions;
const token = Object.entries(sessions).find(([, expiry]) => expiry > Date.now())?.[0];
if (!token) throw new Error("No valid relay login. Log in to the web UI first.");
const cookie = `ccgui_relay_auth=${token}; ccgui_machine=${encodeURIComponent(machine)}`;
const url = new URL(wsUrl);
url.searchParams.set("machine", machine);

try {
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: cookie } });
    const timeout = setTimeout(() => finish(new Error("Relay RPC timed out")), 15000);
    let version;
    let activeRuns;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(result);
      ws.close();
    };
    ws.onerror = () => finish(new Error("Relay connection failed"));
    ws.onclose = () => finish(new Error("Relay closed before the health check completed"));
    ws.onmessage = ({ data }) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "hello") {
        version = frame.version;
        ws.send(JSON.stringify({ type: "invoke", id: 1, cmd: "list_active_runs", args: {} }));
      } else if (frame.type === "response" && frame.id === 1) {
        if (!frame.ok || !Array.isArray(frame.payload)) return finish(new Error("Active-run query failed"));
        activeRuns = frame.payload.length;
        ws.send(JSON.stringify({ type: "invoke", id: 2, cmd: "list_workspaces", args: {} }));
      } else if (frame.type === "response" && frame.id === 2) {
        if (!frame.ok || !Array.isArray(frame.payload)) return finish(new Error("Workspace query failed"));
        finish(null, { version, activeRuns, workspaces: frame.payload.length });
      }
    };
  });
  const base = new URL(wsUrl.replace(/^ws/, "http"));
  base.pathname = base.pathname.replace(/\/ws$/, "/");
  base.search = "";
  const headers = { Cookie: cookie };
  const page = await fetch(base, { headers, signal: AbortSignal.timeout(15000) });
  const html = await page.text();
  const asset = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/i)?.[1];
  if (!page.ok || !asset) throw new Error("Packaged frontend is unavailable");
  const js = await fetch(new URL(asset, base), { headers, signal: AbortSignal.timeout(15000) });
  if (!js.ok || !(await js.arrayBuffer()).byteLength) throw new Error("Frontend asset is unavailable");
  console.log(JSON.stringify({ ...result, frontend: true }));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
