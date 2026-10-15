import { listenTerminalOutput } from "@/lib/events";

/**
 * Backend PTY sessions outlive their xterm view (dock collapse and tab
 * switches remount the view). Output accumulates here in between so nothing
 * is lost; a (re)mounting view replays the backlog. Module-level on purpose:
 * these mutate at PTY frequency and must never go through React state.
 */
const MAX_BUFFER_CHARS = 200_000;

const buffers = new Map<string, string>();
const writers = new Map<string, (data: string) => void>();
const openSessions = new Set<string>();
const owners = new Map<string, string | undefined>();
let listening = false;

/** One global `terminal://output` subscription; idempotent. */
export function ensureTerminalOutputListener(): void {
  if (listening) return;
  listening = true;
  void listenTerminalOutput((chunks) => {
    for (const { id, data, machine } of chunks) {
      if (!owners.has(id) || owners.get(id) !== machine) continue;
      const next = (buffers.get(id) ?? "") + data;
      buffers.set(
        id,
        next.length > MAX_BUFFER_CHARS ? next.slice(next.length - MAX_BUFFER_CHARS) : next,
      );
      writers.get(id)?.(data);
    }
  });
}

/** Buffered output for replay on view (re)mount. */
export function terminalBacklog(id: string): string {
  return buffers.get(id) ?? "";
}

/** Drop all frontend state for a session (tab closed / workspace removed). */
export function clearTerminalSessionState(id: string): void {
  buffers.delete(id);
  writers.delete(id);
  openSessions.delete(id);
  owners.delete(id);
}

export function registerTerminalOwner(id: string, machine?: string): void {
  owners.set(id, machine);
}

/** Register the live xterm writer for a session; `null` unregisters. */
export function setTerminalWriter(id: string, writer: ((data: string) => void) | null): void {
  if (writer) writers.set(id, writer);
  else writers.delete(id);
}

export function markTerminalOpened(id: string): void {
  openSessions.add(id);
}

export function markTerminalClosed(id: string): void {
  openSessions.delete(id);
}

/** Whether the backend confirmed a live PTY for this id. */
export function hasTerminalSession(id: string): boolean {
  return openSessions.has(id);
}
