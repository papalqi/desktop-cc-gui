// The cookie chooses a new page's default. An open page owns its machine.
let machine: string | null | undefined;

export function machineResourceKey(path: string, machine?: string): string {
  return machine ? `machine:${encodeURIComponent(machine)}:${path}` : path;
}

export function machineResourceTarget(key: string): { path: string; machine?: string } {
  const match = /^machine:([^:]+):([\s\S]*)$/.exec(key);
  return match ? { path: match[2], machine: decodeURIComponent(match[1]) } : { path: key };
}

/** Opt-in page mode. The beta setting reloads the page when this changes. */
export function webMultiMachine(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window) &&
    new URLSearchParams(window.location.search).get("global") === "1";
}

export function webMachine(): string | null {
  if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return null;
  if (machine !== undefined) return machine;
  const selected = new URLSearchParams(window.location.search).get("machine");
  const cookie = document.cookie.match(/(?:^|;\s*)ccgui_machine=([^;]*)/);
  try {
    machine = selected || (cookie ? decodeURIComponent(cookie[1]) : null);
  } catch {
    machine = null;
  }
  return machine;
}

export function setWebMachine(name: string | null): void {
  const previous = webMachine();
  machine = name;
  const url = new URL(window.location.href);
  if (name) url.searchParams.set("machine", name);
  else url.searchParams.delete("machine");
  if (webMultiMachine() && previous !== name) {
    for (const key of ["engine", "session", "workspace"]) url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", url);
}

export function setWebSessionRoute(session: { machine?: string; engine: string; sessionId: string | null; workspacePath: string } | null): void {
  if (!webMultiMachine()) return;
  if (session?.machine) setWebMachine(session.machine);
  const url = new URL(window.location.href);
  for (const key of ["engine", "session", "workspace"]) url.searchParams.delete(key);
  if (session) {
    url.searchParams.set("engine", session.engine);
    url.searchParams.set("workspace", session.workspacePath);
    if (session.sessionId) url.searchParams.set("session", session.sessionId);
  }
  window.history.replaceState(window.history.state, "", url);
}
