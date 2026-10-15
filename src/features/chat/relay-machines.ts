import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  catalogFingerprint,
  catalogIsFresh,
  currentRelayMachine,
  listsFromState,
  prefetchMachineCatalog,
  publishMachineCatalog,
  readMachineCatalog,
  runningKeysFromFlags,
  type CatalogLists,
} from "@/features/chat/machine-catalog";
import { noteMachineRunningKeys } from "@/features/chat/machine-run-watch";
import { isWeb } from "@/lib/platform";
import { listen, reconnectWebBridge } from "@/lib/transport";
import { webPublicPrefix } from "@/lib/web-public-prefix";
import { setWebMachine, webMultiMachine } from "@/lib/web-machine";

export type RelayMachinePolicy = {
  name: string;
  machineId: string | null;
  hidden: boolean;
  retired: boolean;
  order: number;
};

/** Machines the relay is currently forwarding. Null means this page is not
 *  the relay (desktop window, LAN web access, or the agents endpoint failed). */
export type RelayMachineList = {
  current: string;
  names: string[];
  /** Hub catalogs remain available after the execution machine goes offline. */
  knownNames?: string[];
  /** Ordered display policy from the Hub, including hidden and retired rows. */
  machines?: RelayMachinePolicy[];
};

export function relayAgentsPath(pathname: string): string {
  const machine = currentRelayMachine();
  return `${webPublicPrefix(pathname)}/_relay/agents${machine ? `?machine=${encodeURIComponent(machine)}` : ""}`;
}

/** Sets the relay cookie and stays on this document (`stay=1`). */
export function relayMachineStayPath(pathname: string, name: string): string {
  return `${webPublicPrefix(pathname)}/_relay/use?name=${encodeURIComponent(name)}&stay=1`;
}

export function relayMachineNames(list: RelayMachineList): string[] {
  const policies = new Map(list.machines?.map((machine) => [machine.name, machine]));
  return [...new Set([...(list.machines?.map((machine) => machine.name) ?? []), ...(list.knownNames ?? []), ...list.names])]
    .filter((name) => !policies.get(name)?.hidden && !policies.get(name)?.retired);
}

function readMachinePolicies(value: unknown): RelayMachinePolicy[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  return value.flatMap((item: unknown, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name || seen.has(row.name)) return [];
    seen.add(row.name);
    return [{ name: row.name, machineId: typeof row.machineId === "string" ? row.machineId : null,
      hidden: row.hidden === true, retired: row.retired === true, order: Number.isSafeInteger(row.order) ? row.order as number : index }];
  });
}

export function relayMachineRows(list: RelayMachineList): Array<{
  name: string;
  online: boolean;
  current: boolean;
}> {
  const online = new Set(list.names);
  return relayMachineNames(list).map((name) => ({
    name,
    online: online.has(name),
    current: name === list.current,
  }));
}

/** The hub's `machines://status` as a machine list. Null when malformed. */
export function relayListFromStatus(
  previous: RelayMachineList | null,
  payload: unknown,
  current: string,
): RelayMachineList | null {
  const machines = payload && typeof payload === "object" ? (payload as { machines?: unknown }).machines : null;
  if (!Array.isArray(machines)) return null;
  const names: string[] = [];
  const knownNames: string[] = [];
  for (const machine of machines) {
    if (!machine || typeof machine !== "object") continue;
    const { name, online } = machine as { name?: unknown; online?: unknown };
    if (typeof name !== "string" || !name || knownNames.includes(name)) continue;
    knownNames.push(name);
    if (online === true) names.push(name);
  }
  const policies = machines.some((item) => item && typeof item === "object" && "hidden" in item)
    ? readMachinePolicies(machines) : previous?.machines;
  return { current: previous?.current ?? current, names, knownNames, ...(policies ? { machines: policies } : {}) };
}

/** Fired on window (detail: machine name) after a switch moves the sidebar. */
export const RELAY_MACHINE_EVENT = "ccgui-relay-machine";
const RELAY_POLICY_EVENT = "ccgui-relay-machine-policy";

export async function manageRelayMachines(
  action: { name: string; hidden: boolean } | { names: string[] } | { machineId: string; action: "retire" },
): Promise<void> {
  const route = "machineId" in action ? encodeURIComponent(action.machineId) : "names" in action ? "order" : "display";
  const response = await fetch(`${webPublicPrefix(window.location.pathname)}/_relay/machines/${route}`, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error("Machine policy could not be saved");
  window.dispatchEvent(new Event(RELAY_POLICY_EVENT));
}

/** Sidebar list after a switch that already set the machine cookie. */
export function relayListAfterSwitch(list: RelayMachineList, name: string): RelayMachineList {
  const names = list.names.includes(name) || list.knownNames?.includes(name) ? list.names : [...list.names, name];
  if (list.current === name && names === list.names) return list;
  return { ...list, current: name, names };
}

function noteRelayMachine(name: string): void {
  window.dispatchEvent(new CustomEvent(RELAY_MACHINE_EVENT, { detail: name }));
}

let switchEpoch = 0;
/** Epoch of the switch the sidebar is still waiting on. 0 means idle. */
let loadingEpoch = 0;
const switchingListeners = new Set<() => void>();

function emitSwitching(): void {
  for (const listener of switchingListeners) listener();
}

function markSwitchLoading(epoch: number): void {
  loadingEpoch = epoch;
  emitSwitching();
}

/** An older switch finishing must not clear the line for a newer click. */
function markSwitchSettled(epoch: number): void {
  if (loadingEpoch !== epoch) return;
  loadingEpoch = 0;
  emitSwitching();
}

/** True while the latest machine switch is still loading that desktop's workspaces. */
export function useRelaySwitching(): boolean {
  const [on, setOn] = useState(loadingEpoch !== 0);
  useEffect(() => {
    const listener = () => setOn(loadingEpoch !== 0);
    switchingListeners.add(listener);
    setOn(loadingEpoch !== 0);
    return () => {
      switchingListeners.delete(listener);
    };
  }, []);
  return on;
}

/** Point the relay at another desktop and reload that machine's catalogs.
 *  The page itself does not navigate. `keepSidebar` leaves the machine list
 *  and the workspace tree on the desktop the user was already browsing. */
export async function switchRelayMachine(
  name: string,
  options?: { keepSidebar?: boolean },
): Promise<boolean> {
  if (webMultiMachine()) {
    setWebMachine(name);
    noteRelayMachine(name);
    return true;
  }
  const epoch = ++switchEpoch;
  const cached = readMachineCatalog(name);
  if (!options?.keepSidebar && !cached) markSwitchLoading(epoch);
  try {
    const { useChatStore } = await import("@/features/chat/store");
    if (epoch !== switchEpoch) return false;
    const response = await fetch(relayMachineStayPath(window.location.pathname, name), {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok || !/json/i.test(response.headers.get("content-type") ?? "")) return false;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || (data as { ok?: unknown }).ok !== true || epoch !== switchEpoch) return false;
    const leaving = currentRelayMachine();
    if (leaving && leaving !== name) {
      const state = useChatStore.getState();
      const runningKeys = runningKeysFromFlags(state.streamingByKey);
      publishMachineCatalog(leaving, listsFromState({
        workspaces: state.workspaces, sessions: state.sessions,
        workspaceGroups: state.workspaceGroups, workspaceAliases: state.workspaceAliases,
        archivedWorkspaces: state.archivedWorkspaces, threadLimit: state.threadLimit, runningKeys,
      }));
      noteMachineRunningKeys(leaving, runningKeys);
    }
    setWebMachine(name);
    if (!options?.keepSidebar) noteRelayMachine(name);
    if (!options?.keepSidebar && cached) markSwitchSettled(loadingEpoch);
    if (cached) useChatStore.getState().applyCachedMachineCatalog(cached);
    else useChatStore.getState().prepareMachineSwitch();
    await reconnectWebBridge(name);
    if (epoch !== switchEpoch) return false;
    await useChatStore.getState().replaceMachineCatalog(() => epoch === switchEpoch, name);
    return true;
  } catch {
    return false;
  } finally {
    markSwitchSettled(epoch);
  }
}

/** Read every connected desktop's workspaces before the user clicks one. */
export function usePrefetchMachineCatalogs(list: RelayMachineList | null): void {
  const available = [...new Set([...(list?.names ?? []), ...(list?.knownNames ?? [])])];
  const online = available.join("\0");
  useEffect(() => {
    if (webMultiMachine()) return;
    if (import.meta.env.VITEST) return;
    if (!list) return;
    let cancelled = false;
    const run = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      const here = currentRelayMachine();
      if (!here || !available.includes(here)) return;
      const others = async () => {
        if (cancelled) return;
        const baseline = readMachineCatalog(here);
        if (!baseline) return;
        const sameAs = catalogFingerprint(baseline);
        await Promise.all(
          relayMachineNames(list).map((machine) => {
            if (machine === here || !available.includes(machine) || catalogIsFresh(machine)) {
              return Promise.resolve();
            }
            return prefetchMachineCatalog(machine, sameAs);
          }),
        );
      };
      if (catalogIsFresh(here)) {
        void others();
        return;
      }
      void prefetchMachineCatalog(here).then(others);
    };
    run();
    const timer = window.setInterval(run, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [list, online]);
}

declare global {
  interface Window {
    __ccguiSwitchMachine?: (name: string) => Promise<boolean>;
  }
}

if (typeof window !== "undefined" && isWeb) {
  window.__ccguiSwitchMachine = switchRelayMachine;
}

type FetchLike = (
  input: string,
  init?: { credentials?: RequestCredentials },
) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** Read the relay's connected desktops. Anything that is not that JSON
 *  (404, the SPA's HTML fallback, a thrown fetch) is "not the relay". */
export async function loadRelayMachines(
  fetchImpl: FetchLike,
  pathname: string,
): Promise<RelayMachineList | null> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(relayAgentsPath(pathname), { credentials: "same-origin" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  if (!/json/i.test(type)) return null;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as { current?: unknown; agents?: unknown; knownNames?: unknown; hub?: unknown; machines?: unknown };
  if (!Array.isArray(record.agents)) return null;
  const names: string[] = [];
  for (const agent of record.agents) {
    if (!agent || typeof agent !== "object") continue;
    const name = (agent as { name?: unknown }).name;
    if (typeof name !== "string" || !name || names.includes(name)) continue;
    names.push(name);
  }
  const current = typeof record.current === "string" ? record.current : "";
  const knownNames = record.hub === true && Array.isArray(record.knownNames)
    ? [...new Set(record.knownNames.filter((name): name is string => typeof name === "string" && Boolean(name)))]
    : undefined;
  const machines = record.hub === true ? readMachinePolicies(record.machines) : undefined;
  return { current, names, ...(knownNames ? { knownNames } : {}), ...(machines ? { machines } : {}) };
}

const POLL_MS = 20_000;

function sameMachines(a: RelayMachineList | null, b: RelayMachineList | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.current !== b.current || a.names.length !== b.names.length) return false;
  if (JSON.stringify(a.knownNames) !== JSON.stringify(b.knownNames)) return false;
  if (JSON.stringify(a.machines) !== JSON.stringify(b.machines)) return false;
  return a.names.every((name, index) => name === b.names[index]);
}

/** The workspace tree stays on this desktop while a pinned session from
 *  another machine is open in the chat. */
type SidebarHold = { machine: string; lists: CatalogLists };

let sidebarHold: SidebarHold | null = null;
const holdListeners = new Set<() => void>();

function emitHold(): void {
  for (const listener of holdListeners) listener();
}

export function readSidebarHold(): SidebarHold | null {
  return sidebarHold;
}

export function holdSidebar(machine: string, lists: CatalogLists): void {
  sidebarHold = { machine, lists };
  emitHold();
}

export function releaseSidebarHold(): void {
  if (!sidebarHold) return;
  sidebarHold = null;
  emitHold();
}

/** Drop the freeze and point the machine list at `name`. */
export function commitSidebarMachine(name: string): void {
  sidebarHold = null;
  emitHold();
  noteRelayMachine(name);
}

export function resetSidebarHoldForTests(): void {
  sidebarHold = null;
  emitHold();
}

function subscribeHold(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => holdListeners.delete(listener);
}

export function useSidebarHold(): SidebarHold | null {
  return useSyncExternalStore(subscribeHold, readSidebarHold, () => null);
}

/** What opening a pinned session should do to the sidebar. `switch` keeps
 *  the machine list where it is. `return` comes back to that list. */
export type PinnedOpenPlan = "select" | "return" | "switch";

export function planPinnedOpen(
  displayedMachine: string,
  socketMachine: string | null,
  targetMachine: string,
): PinnedOpenPlan {
  if (targetMachine === displayedMachine && socketMachine === targetMachine) return "select";
  if (targetMachine === displayedMachine) return "return";
  return "switch";
}

/** The displayed current row is normally static. It becomes a button when
 *  the chat has moved to another desktop and the row is how you come back. */
export function machineRowIsButton(
  online: boolean,
  current: boolean,
  name: string,
  holdMachine: string | null,
  socketMachine: string | null,
): boolean {
  if (!online) return false;
  if (holdMachine && socketMachine && socketMachine !== holdMachine && name === holdMachine) return true;
  return !current;
}

/** Poll the relay machine list. Stays null off the relay, so the desktop
 *  sidebar and LAN access never grow a machines section. */
export function useRelayMachines(): RelayMachineList | null {
  const [list, setList] = useState<RelayMachineList | null>(null);
  const holdMachine = useSidebarHold()?.machine ?? null;
  useEffect(() => {
    if (!isWeb || typeof fetch !== "function") return;
    let cancelled = false;
    let generation = 0;
    const pull = () => {
      if (document.visibilityState === "hidden") return;
      const stamp = generation;
      void loadRelayMachines(fetch, window.location.pathname).then((next) => {
        if (cancelled || stamp !== generation) return;
        setList((prev) => (sameMachines(prev, next) ? prev : next));
      });
    };
    const onSwitch = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (typeof name !== "string" || !name) return;
      generation += 1;
      setList((prev) => (prev ? relayListAfterSwitch(prev, name) : prev));
    };
    // Presence changes arrive on the page socket at once; the poll stays as a fallback.
    let stopStatus: (() => void) | null = null;
    void listen<unknown>("machines://status", (event) => {
      if (cancelled) return;
      generation += 1;
      setList((prev) => {
        const next = relayListFromStatus(prev, event.payload, currentRelayMachine() ?? "");
        return !next || sameMachines(prev, next) ? prev : next;
      });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stopStatus = unlisten;
    });
    pull();
    const timer = window.setInterval(pull, POLL_MS);
    window.addEventListener("focus", pull);
    window.addEventListener(RELAY_POLICY_EVENT, pull);
    window.addEventListener(RELAY_MACHINE_EVENT, onSwitch);
    document.addEventListener("visibilitychange", pull);
    return () => {
      cancelled = true;
      stopStatus?.();
      window.clearInterval(timer);
      window.removeEventListener("focus", pull);
      window.removeEventListener(RELAY_POLICY_EVENT, pull);
      window.removeEventListener(RELAY_MACHINE_EVENT, onSwitch);
      document.removeEventListener("visibilitychange", pull);
    };
  }, []);
  return useMemo(() => {
    if (!list || !holdMachine || list.current === holdMachine) return list;
    return { ...list, current: holdMachine };
  }, [list, holdMachine]);
}
