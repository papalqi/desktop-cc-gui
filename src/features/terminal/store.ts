import { create } from "zustand";
import { ipc, ipcForMachine } from "@/lib/ipc";
import { machineResourceKey } from "@/lib/web-machine";
import { readStoredNumber, writeStored } from "@/lib/storage";
import { newId } from "@/lib/id";
import { clearTerminalSessionState, registerTerminalOwner } from "./sessions";

const HEIGHT_KEY = "ccgui-next.terminalHeight";
export const TERMINAL_MIN_HEIGHT = 120;
export const TERMINAL_MAX_HEIGHT = 600;
export const TERMINAL_DEFAULT_HEIGHT = 240;

export interface TerminalTab {
  /** Globally unique; doubles as the backend PTY session key. */
  id: string;
  machine?: string;
}

interface TerminalState {
  open: boolean;
  height: number;
  /** Tabs per workspace; each workspace's shells run in its own cwd. */
  tabsByWorkspace: Record<string, TerminalTab[]>;
  activeByWorkspace: Record<string, string>;
  toggle: (workspacePath: string, machine?: string) => void;
  closePanel: () => void;
  newTab: (workspacePath: string, machine?: string) => void;
  selectTab: (workspacePath: string, id: string, machine?: string) => void;
  closeTab: (workspacePath: string, id: string, machine?: string) => void;
  removeWorkspace: (workspacePath: string, machine?: string) => void;
  setHeight: (height: number) => void;
}

/** Kill the backend session and drop its frontend buffer. */
function destroySession(id: string, machine?: string): void {
  clearTerminalSessionState(id);
  void (machine ? ipcForMachine(machine) : ipc).terminalClose(id).catch(() => {});
}

function clampHeight(height: number): number {
  return Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, height));
}
// Drags call setHeight per animation frame; the localStorage write waits for
// the drag to settle so storage isn't touched 60+ times per second.
let heightWriteTimer: number | undefined;

export const useTerminalStore = create<TerminalState>((set, get) => ({
  open: false,
  height: clampHeight(readStoredNumber(HEIGHT_KEY, TERMINAL_DEFAULT_HEIGHT)),
  tabsByWorkspace: {},
  activeByWorkspace: {},

  toggle: (workspacePath, machine) => {
    const { open } = get();
    if (open) {
      set({ open: false });
      return;
    }
    // Opening with no tabs in this workspace creates the first shell.
    if (!(get().tabsByWorkspace[machineResourceKey(workspacePath, machine)]?.length)) {
      get().newTab(workspacePath, machine);
    }
    set({ open: true });
  },

  closePanel: () => {
    set({ open: false });
  },

  newTab: (workspacePath, machine) => {
    const key = machineResourceKey(workspacePath, machine);
    const id = newId();
    registerTerminalOwner(id, machine);
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [key]: [...(s.tabsByWorkspace[key] ?? []), { id, ...(machine ? { machine } : {}) }],
      },
      activeByWorkspace: { ...s.activeByWorkspace, [key]: id },
    }));
  },

  selectTab: (workspacePath, id, machine) =>
    set((s) => ({
      activeByWorkspace: { ...s.activeByWorkspace, [machineResourceKey(workspacePath, machine)]: id },
    })),

  closeTab: (workspacePath, id, machine) => {
    const key = machineResourceKey(workspacePath, machine);
    const tab = get().tabsByWorkspace[key]?.find((tab) => tab.id === id);
    if (!tab) return;
    destroySession(id, tab.machine);
    set((s) => {
      const tabs = (s.tabsByWorkspace[key] ?? []).filter((tab) => tab.id !== id);
      const nextActive =
        s.activeByWorkspace[key] === id
          ? (tabs[tabs.length - 1]?.id ?? "")
          : s.activeByWorkspace[key];
      return {
        tabsByWorkspace: { ...s.tabsByWorkspace, [key]: tabs },
        activeByWorkspace: { ...s.activeByWorkspace, [key]: nextActive },
        // Closing the last tab closes the panel; sessions stay per workspace.
        open: tabs.length > 0 ? s.open : false,
      };
    });
  },

  removeWorkspace: (workspacePath, machine) => {
    const key = machineResourceKey(workspacePath, machine);
    for (const tab of get().tabsByWorkspace[key] ?? []) {
      destroySession(tab.id, tab.machine);
    }
    set((s) => {
      const tabsByWorkspace = { ...s.tabsByWorkspace };
      const activeByWorkspace = { ...s.activeByWorkspace };
      delete tabsByWorkspace[key];
      delete activeByWorkspace[key];
      return { tabsByWorkspace, activeByWorkspace };
    });
  },

  setHeight: (height) => {
    const next = clampHeight(height);
    set({ height: next });
    clearTimeout(heightWriteTimer);
    heightWriteTimer = window.setTimeout(() => {
      heightWriteTimer = undefined;
      writeStored(HEIGHT_KEY, next);
    }, 300);
  },
}));
