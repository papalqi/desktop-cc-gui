import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishMachineCatalog, readMachineCatalog, resetMachineCatalogsForTests } from "./machine-catalog";
import { resetMachineRunWatchersForTests } from "./machine-run-watch";
import { setWebMachine, webMachine } from "@/lib/web-machine";
import {
  loadRelayMachines,
  machineRowIsButton,
  planPinnedOpen,
  relayAgentsPath,
  relayListAfterSwitch,
  relayListFromStatus,
  relayMachineNames,
  relayMachineRows,
  relayMachineStayPath,
  resetSidebarHoldForTests,
  switchRelayMachine,
  useRelaySwitching,
} from "./relay-machines";

const reconnectWebBridge = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const prepareMachineSwitch = vi.hoisted(() => vi.fn());
const applyCachedMachineCatalog = vi.hoisted(() => vi.fn());
const replaceMachineCatalog = vi.hoisted(() => vi.fn(async () => {}));
const leavingState = vi.hoisted(() => ({
  workspaces: [] as never[],
  sessions: [] as never[],
  workspaceGroups: [] as never[],
  workspaceAliases: {} as Record<string, string>,
  archivedWorkspaces: [] as string[],
  threadLimit: 5,
  streamingByKey: {} as Record<string, true | undefined>,
}));

vi.mock("@/lib/transport", async () => {
  const actual = await vi.importActual<typeof import("@/lib/transport")>("@/lib/transport");
  return { ...actual, reconnectWebBridge };
});

vi.mock("@/features/chat/store", () => ({
  useChatStore: {
    getState: () => ({
      prepareMachineSwitch,
      applyCachedMachineCatalog,
      replaceMachineCatalog,
      ...leavingState,
    }),
  },
}));

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  };
}

describe("relay machine list", () => {
  it("keeps the hub's offline catalogs separate from connected machines", async () => {
    const list = await loadRelayMachines(async () => jsonResponse({
      current: "PC5", agents: [{ name: "PC5" }], hub: true, knownNames: ["PC5", "PC6", null, "PC6"],
    }), "/CCGUI");
    expect(list).toEqual({ current: "PC5", names: ["PC5"], knownNames: ["PC5", "PC6"] });
    expect(relayListAfterSwitch(list!, "PC6")).toEqual({ current: "PC6", names: ["PC5"], knownNames: ["PC5", "PC6"] });
    expect(relayMachineRows(relayListAfterSwitch(list!, "PC6")).find((row) => row.name === "PC6"))
      .toEqual({ name: "PC6", current: true, online: false });
  });
  it("prefixes the agents path when the page is under /CCGUI", () => {
    expect(relayAgentsPath("/")).toBe("/_relay/agents");
    expect(relayAgentsPath("/CCGUI/chat")).toBe("/CCGUI/_relay/agents");
    expect(relayMachineStayPath("/CCGUI/", "PC5")).toBe("/CCGUI/_relay/use?name=PC5&stay=1");
    expect(relayMachineStayPath("/", "a b")).toBe("/_relay/use?name=a%20b&stay=1");
  });

  it("reads connected machine names and the current one", async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string) => {
      seen.push(input);
      return jsonResponse({
        current: "PC5",
        agents: [{ name: "PC0" }, { name: "" }, null, { name: "PC5" }, { name: "PC5" }],
      });
    };
    await expect(loadRelayMachines(fetchImpl, "/CCGUI")).resolves.toEqual({
      current: "PC5",
      names: ["PC0", "PC5"],
    });
    expect(seen).toEqual(["/CCGUI/_relay/agents"]);
  });

  it("treats a missing relay, HTML fallback, and a bad body as no list", async () => {
    await expect(
      loadRelayMachines(async () => jsonResponse({}, false), "/"),
    ).resolves.toBeNull();
    await expect(
      loadRelayMachines(
        async () => ({
          ok: true,
          headers: { get: () => "text/html" },
          json: async () => ({ agents: [] }),
        }),
        "/",
      ),
    ).resolves.toBeNull();
    await expect(
      loadRelayMachines(async () => {
        throw new Error("offline");
      }, "/"),
    ).resolves.toBeNull();
    await expect(
      loadRelayMachines(async () => jsonResponse({ ok: true }), "/"),
    ).resolves.toBeNull();
  });

  it("lists only machines supplied by the Hub and marks who is online", () => {
    expect(
      relayMachineRows({ current: "PC5", names: ["PC6", "PC5"] }).map((row) => [
        row.name,
        row.online,
        row.current,
      ]),
    ).toEqual([
      ["PC6", true, false],
      ["PC5", true, true],
    ]);
  });

  it("keeps the Hub catalog order and adds online names missing from an older catalog", () => {
    expect(relayMachineNames({ current: "PC5", names: ["PC7", "PC5"], knownNames: ["MC2", "LAB1", "PC7"] }))
      .toEqual(["MC2", "LAB1", "PC7", "PC5"]);
    expect(relayMachineRows({ current: "LAB1", names: [], knownNames: ["LAB1"] }).at(-1))
      .toEqual({ name: "LAB1", online: false, current: true });
  });
  it("uses dynamic policy order and excludes hidden and retired machines", async () => {
    const machines = [
      { name: "LAB2", machineId: null, hidden: false, retired: false, order: 0 },
      { name: "PC6", machineId: "id", hidden: true, retired: false, order: 1 },
      { name: "OLD", machineId: "old", hidden: true, retired: true, order: 2 },
    ];
    const list = await loadRelayMachines(async () => jsonResponse({ hub: true, current: "PC6", agents: [{ name: "PC6" }], knownNames: ["OLD", "PC6", "LAB2"], machines }), "/CCGUI");
    expect(list?.machines).toEqual(machines);
    expect(relayMachineNames(list!)).toEqual(["LAB2"]);
    const status = relayListFromStatus(list, { machines: machines.map((machine) => ({ ...machine, online: false })) }, "PC6");
    expect(relayMachineNames(status!)).toEqual(["LAB2"]);
    expect(status?.machines).toEqual(machines);
  });

  it("reads presence from the hub's status push and keeps the current machine", () => {
    const status = { machines: [
      { name: "MC2", online: true, runs: [] }, { name: "PC5", online: false, runs: [] }, null, { name: "MC2", online: false },
    ] };
    expect(relayListFromStatus({ current: "PC5", names: ["PC5"] }, status, "PC0"))
      .toEqual({ current: "PC5", names: ["MC2"], knownNames: ["MC2", "PC5"] });
    expect(relayListFromStatus(null, status, "PC0")?.current).toBe("PC0");
    expect(relayListFromStatus(null, { machines: "bad" }, "PC0")).toBeNull();
  });

  it("moves the current mark as soon as a switch succeeds", () => {
    expect(relayListAfterSwitch({ current: "PC5", names: ["PC5", "PC0"] }, "PC6")).toEqual({
      current: "PC6",
      names: ["PC5", "PC0", "PC6"],
    });
    expect(relayListAfterSwitch({ current: "PC5", names: ["PC5", "PC0"] }, "PC0")).toEqual({
      current: "PC0",
      names: ["PC5", "PC0"],
    });
  });
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  return createElement("span", null, useRelaySwitching() ? "loading" : "idle");
}

describe("switchRelayMachine", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    reconnectWebBridge.mockReset();
    reconnectWebBridge.mockResolvedValue(undefined);
    prepareMachineSwitch.mockReset();
    applyCachedMachineCatalog.mockReset();
    replaceMachineCatalog.mockReset();
    replaceMachineCatalog.mockResolvedValue(undefined);
    resetMachineCatalogsForTests();
    resetMachineRunWatchersForTests();
    resetSidebarHoldForTests();
    leavingState.streamingByKey = {};
    document.cookie = "ccgui_machine=; Max-Age=0";
    setWebMachine(null);
  });

  it("clears the loading line when a newer switch finishes before the previous one", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(createElement(Probe));
    });
    expect(container.textContent).toBe("idle");

    let releaseFirst: () => void = () => {};
    reconnectWebBridge.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      })),
    );

    let first: Promise<boolean> | undefined;
    await act(async () => {
      first = switchRelayMachine("PC6");
      for (let i = 0; i < 20 && container?.textContent !== "loading"; i += 1) {
        await Promise.resolve();
      }
    });
    expect(container.textContent).toBe("loading");

    await act(async () => {
      await switchRelayMachine("PC0");
    });
    expect(container.textContent).toBe("idle");
    expect(prepareMachineSwitch).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseFirst();
      await first;
    });
    expect(container.textContent).toBe("idle");
    expect(replaceMachineCatalog).toHaveBeenCalledTimes(1);
  });

  it("paints a cached catalog and does not show the loading line", async () => {
    publishMachineCatalog("PC0", {
      workspaces: [],
      sessions: [],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(createElement(Probe));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      })),
    );
    await act(async () => {
      await switchRelayMachine("PC0");
    });
    expect(container.textContent).toBe("idle");
    expect(applyCachedMachineCatalog).toHaveBeenCalledTimes(1);
    expect(prepareMachineSwitch).not.toHaveBeenCalled();
    expect(replaceMachineCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not move the current mark when a pin opens another machine", async () => {
    const marks: string[] = [];
    const onSwitch = (event: Event) => {
      marks.push(String((event as CustomEvent<string>).detail));
    };
    window.addEventListener("ccgui-relay-machine", onSwitch);
    try {
      container = document.createElement("div");
      document.body.appendChild(container);
      const mounted = createRoot(container);
      root = mounted;
      await act(async () => {
        mounted.render(createElement(Probe));
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({ ok: true }),
        })),
      );
      await act(async () => {
        await switchRelayMachine("PC6", { keepSidebar: true });
      });
      expect(marks).toEqual([]);
      expect(container.textContent).toBe("idle");
      expect(prepareMachineSwitch).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("ccgui-relay-machine", onSwitch);
    }
  });

  it("keeps the leaving machine's running sessions in its catalog", async () => {
    document.cookie = "ccgui_machine=MC2";
    setWebMachine("MC2");
    leavingState.streamingByKey = { "codex/live": true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      })),
    );
    await act(async () => {
      await switchRelayMachine("PC5");
    });
    expect(readMachineCatalog("MC2")?.runningKeys).toEqual(["codex/live"]);
  });

  it("ignores an older HTTP switch reply even if its Set-Cookie arrives last", async () => {
    let releaseFirst!: (response: ReturnType<typeof jsonResponse>) => void;
    const firstResponse = new Promise<ReturnType<typeof jsonResponse>>((resolve) => { releaseFirst = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(firstResponse).mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const first = switchRelayMachine("PC6");
    for (let i = 0; i < 20 && !fetchMock.mock.calls.length; i++) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(switchRelayMachine("PC0")).resolves.toBe(true);
    document.cookie = "ccgui_machine=PC6";
    releaseFirst(jsonResponse({ ok: true }));
    await expect(first).resolves.toBe(false);
    expect(webMachine()).toBe("PC0");
    expect(new URL(location.href).searchParams.get("machine")).toBe("PC0");
    expect(reconnectWebBridge).toHaveBeenCalledTimes(1);
    expect(reconnectWebBridge).toHaveBeenCalledWith("PC0");
    expect(replaceMachineCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("pinned open plan", () => {
  it("stays on the sidebar machine unless the pin is already the one on screen", () => {
    expect(planPinnedOpen("PC5", "PC5", "PC5")).toBe("select");
    expect(planPinnedOpen("PC5", "PC6", "PC5")).toBe("return");
    expect(planPinnedOpen("PC5", "PC5", "PC6")).toBe("switch");
  });

  it("turns the displayed machine into a button only while the chat is away", () => {
    expect(machineRowIsButton(true, true, "PC5", null, "PC5")).toBe(false);
    expect(machineRowIsButton(true, false, "PC6", null, "PC5")).toBe(true);
    expect(machineRowIsButton(false, false, "PC0", null, "PC5")).toBe(false);
    expect(machineRowIsButton(true, true, "PC5", "PC5", "PC6")).toBe(true);
    expect(machineRowIsButton(true, false, "PC6", "PC5", "PC6")).toBe(true);
  });
});
