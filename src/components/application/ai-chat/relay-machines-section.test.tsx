import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishMachineCatalog,
  resetMachineCatalogsForTests,
} from "@/features/chat/machine-catalog";
import {
  noteMachineRunningKeys,
  resetMachineRunWatchersForTests,
} from "@/features/chat/machine-run-watch";
import { switchRelayMachine } from "@/features/chat/relay-machines";
import type { SessionMeta, Workspace } from "@/lib/ipc";
import { AiChatSidebar } from "./ai-chat-sidebar";
import { RelayMachinesSection } from "./relay-machines-section";
import { setWebMachine } from "@/lib/web-machine";

vi.mock("@/features/chat/relay-machines", async () => {
  const actual = await vi.importActual<typeof import("@/features/chat/relay-machines")>(
    "@/features/chat/relay-machines",
  );
  return { ...actual, switchRelayMachine: vi.fn(async () => true) };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetMachineCatalogsForTests();
  resetMachineRunWatchersForTests();
  document.cookie = "ccgui_machine=; Max-Age=0";
  setWebMachine(null);
  vi.unstubAllGlobals();
});

describe("RelayMachinesSection", () => {
  it("opens a synchronized offline catalog without presenting that machine as connected", async () => {
    act(() => root.render(
      <RelayMachinesSection list={{ current: "PC5", names: ["PC5"], knownNames: ["PC5", "PC6"] }} />,
    ));
    const pc6 = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("PC6"));
    expect(pc6?.textContent).toContain("chat.myMachinesOffline");
    expect(pc6?.title).toContain("chat.myMachinesOfflineHistoryHint:PC6");
    await act(async () => {
      pc6?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(switchRelayMachine).toHaveBeenCalledWith("PC6");
  });
  it("switches an online machine in place and does not navigate", async () => {
    act(() => {
      root.render(
        <RelayMachinesSection list={{ current: "PC5", names: ["PC5", "PC6"] }} />,
      );
    });

    const labels = [...container.querySelectorAll("li")].map((item) => item.textContent);
    expect(labels).toHaveLength(2);
    expect(container.textContent).not.toContain("PC0");
    expect(container.textContent?.indexOf("PC5")).toBeLessThan(container.textContent?.indexOf("PC6") ?? 0);
    expect(container.textContent).not.toContain("MC2");
    expect(container.querySelector("a")).toBeNull();

    const current = container.querySelector("[aria-current='page']");
    expect(current?.textContent).toContain("PC5");
    expect(current?.querySelector("button")).toBeNull();

    const pc6 = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("PC6"),
    );
    expect(pc6).toBeTruthy();
    expect(pc6?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      pc6?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(switchRelayMachine).toHaveBeenCalledWith("PC6");
  });

  it("shows an empty catalog without inventing offline machines", () => {
    act(() => {
      root.render(<RelayMachinesSection list={{ current: "", names: [] }} />);
    });
    expect(container.textContent).toContain("chat.myMachinesEmpty");
    expect(container.textContent).not.toContain("PC0");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
  it("saves ordering and visibility to the Hub and reports failure without hiding the row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const machines = [
      { name: "LAB2", machineId: null, hidden: false, retired: false, order: 0 },
      { name: "PC6", machineId: null, hidden: true, retired: false, order: 1 },
    ];
    act(() => root.render(<RelayMachinesSection list={{ current: "LAB2", names: ["LAB2"], machines }} />));
    expect(container.querySelectorAll("li")).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>("[aria-label='chat.manageMachines']")!.click());
    const dialog = () => document.querySelector("[role='dialog']")!;
    await act(async () => { dialog().querySelector<HTMLButtonElement>("[aria-label='chat.machineMoveDown:LAB2']")!.click(); });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ names: ["PC6", "LAB2"] });
    expect(fetchMock.mock.calls[0][0]).toBe("/_relay/machines/order");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await act(async () => { [...dialog().querySelectorAll("button")].find((button) => button.textContent === "chat.machineHide")!.click(); });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ name: "LAB2", hidden: true });
    expect(dialog().querySelector("[role='alert']")?.textContent).toContain("chat.machinePolicyFailed");
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });
  it("retires a registered machine only after the explicit destructive confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const machine = { name: "PC6", machineId: "12345678-1234-4234-8234-123456789abc", hidden: false, retired: false, order: 0 };
    act(() => root.render(<RelayMachinesSection list={{ current: "PC6", names: ["PC6"], machines: [machine] }} />));
    act(() => container.querySelector<HTMLButtonElement>("[aria-label='chat.manageMachines']")!.click());
    act(() => [...document.querySelectorAll("[role='dialog'] button")].find((button) => button.textContent === "chat.machineRetire")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("chat.machineRetireConfirm:PC6");
    await act(async () => { [...document.querySelectorAll("[role='dialog'] button")].find((button) => button.textContent === "chat.machineRetire")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(fetchMock.mock.calls[0][0]).toBe(`/_relay/machines/${machine.machineId}`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ machineId: machine.machineId, action: "retire" });
  });
});

describe("relay sidebar order", () => {
  it("puts my machines above my workspaces", async () => {
    await act(async () => {
      root.render(
        <AiChatSidebar
          relayMachines={{ current: "PC5", names: ["PC5", "MC2"] }}
          repos={[{ id: "control", label: "Control", threads: [] }]}
        />,
      );
    });

    const text = container.textContent ?? "";
    const machinesAt = text.indexOf("chat.myMachines");
    const workspacesAt = text.indexOf("chat.myWorkspaces");
    expect(machinesAt).toBeGreaterThanOrEqual(0);
    expect(workspacesAt).toBeGreaterThan(machinesAt);
    expect(text).toContain("MC2");
    expect(text).toContain("Control");
    expect(text).not.toContain("chat.myWorkspacesLoading");
  });

  it("keeps the plain workspace heading when no relay list is passed", async () => {
    await act(async () => {
      root.render(
        <AiChatSidebar
          relayMachines={null}
          repos={[{ id: "control", label: "Control", threads: [] }]}
        />,
      );
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("chat.myMachines");
    expect(text).toContain("chat.workspaces");
    expect(text).not.toContain("chat.myWorkspaces");
  });
});

const workspace: Workspace = {
  id: "w",
  path: "/repo",
  name: "Repo",
  lastOpenedAt: null,
  sortOrder: null,
  groupId: null,
};

function pinned(sessionId: string): SessionMeta {
  return {
    engine: "codex",
    sessionId,
    workspacePath: "/repo",
    filePath: "/repo/s.jsonl",
    fileSize: 1,
    fileMtimeMs: 1,
    title: sessionId,
    preview: "",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    pinned: true,
    customTitle: null,
  };
}

describe("pinned session status", () => {
  it("shows running on the connected machine from live keys and on others from the catalog", async () => {
    document.cookie = "ccgui_machine=PC5";
    setWebMachine("PC5");
    publishMachineCatalog("PC5", {
      workspaces: [workspace],
      sessions: [pinned("live")],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
      runningKeys: ["codex/stale"],
    });
    publishMachineCatalog("PC6", {
      workspaces: [workspace],
      sessions: [pinned("busy"), pinned("idle")],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
      runningKeys: ["codex/busy"],
    });
    await act(async () => {
      root.render(
        <AiChatSidebar
          relayMachines={{ current: "PC5", names: ["PC5", "PC6"] }}
          liveRunningKeys={["codex/live"]}
          repos={[]}
        />,
      );
    });
    const row = (id: string) =>
      [...container.querySelectorAll("li")].find((item) => item.textContent?.includes(id))?.textContent ?? "";
    expect(row("live")).toContain("chat.sessionRunning");
    expect(row("live")).not.toContain("chat.sessionStopped");
    expect(row("busy")).toContain("chat.sessionRunning");
    expect(row("idle")).toContain("chat.sessionStopped");
  });

  it("keeps another machine's pin running from its own listener", async () => {
    document.cookie = "ccgui_machine=PC5";
    setWebMachine("PC5");
    publishMachineCatalog("PC6", {
      workspaces: [workspace],
      sessions: [pinned("busy")],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
      runningKeys: [],
    });
    noteMachineRunningKeys("PC6", ["codex/busy"]);
    await act(async () => {
      root.render(
        <AiChatSidebar
          relayMachines={{ current: "PC5", names: ["PC5", "PC6"] }}
          liveRunningKeys={[]}
          repos={[]}
        />,
      );
    });
    const row = [...container.querySelectorAll("li")].find((item) => item.textContent?.includes("busy"));
    expect(row?.textContent).toContain("chat.sessionRunning");
    expect(row?.textContent).not.toContain("chat.sessionStopped");
  });
});
