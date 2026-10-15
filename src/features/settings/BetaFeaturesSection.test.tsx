import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Section reads the shared settings promise and writes whole snapshots. */
const getAppSettings = vi.fn();
const updateAppSettings = vi.fn();
const bridge = vi.hoisted(() => ({ supported: false }));
vi.mock("@/lib/transport", () => ({ isWeb: true, webBridgeFeature: () => bridge.supported }));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: () => getAppSettings(),
    updateAppSettings: (settings: unknown) => updateAppSettings(settings),
  },
}));

import "@/lib/i18n";
import { BetaFeaturesSection } from "./BetaFeaturesSection";
import { multiMachinePageUrl, useBetaFeaturesStore } from "./beta-features";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function switchFor(label: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(
    `input[role="switch"][aria-label="${label}"]`,
  );
  if (!element) throw new Error(`switch not rendered: ${label}`);
  return element;
}

function click(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  bridge.supported = false;
  window.history.replaceState(null, "", "/");
  getAppSettings.mockReset();
  updateAppSettings.mockReset();
  useBetaFeaturesStore.setState({ features: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
});

async function render() {
  await act(async () => {
    root.render(<BetaFeaturesSection />);
  });
}

describe("BetaFeaturesSection", () => {
  it("lists every beta entry with its switch off by default", async () => {
    getAppSettings.mockResolvedValue({ betaFeatures: {} });
    await render();

    const labels = [...container.querySelectorAll('[role="switch"]')].map((el) =>
      el.getAttribute("aria-label"),
    );
    // 任务工作台入口内测暂不放开（beta-features.ts 里已注释），恢复时同步改回
    // ["新建浏览器入口", "任务工作台入口"]。
    expect(labels).toEqual(["新建浏览器入口", "多机器会话"]);
    expect(switchFor("多机器会话").disabled).toBe(true);
    for (const label of labels) {
      expect(switchFor(label!).checked).toBe(false);
    }
  });

  it("hides a temporarily disabled entry even when settings say it is on", async () => {
    getAppSettings.mockResolvedValue({ betaFeatures: { missionWorkbench: true } });
    await render();

    expect(
      container.querySelector('[role="switch"][aria-label="任务工作台入口"]'),
    ).toBeNull();
    // 旧值仍在 store 里，没有被清除，恢复入口后即可直接生效。
    expect(useBetaFeaturesStore.getState().features.missionWorkbench).toBe(true);
  });

  it("hydrates a persisted flag into its switch", async () => {
    getAppSettings.mockResolvedValue({ betaFeatures: { newBrowser: true } });
    await render();

    expect(switchFor("新建浏览器入口").checked).toBe(true);
  });

  it("persists a toggle and applies it in memory right away", async () => {
    getAppSettings.mockResolvedValue({ betaFeatures: { missionWorkbench: true } });
    updateAppSettings.mockResolvedValue(undefined);
    await render();

    act(() => click(switchFor("新建浏览器入口")));
    await act(async () => {});

    // 隐藏入口的旧值不会被这次写入抹掉。
    expect(updateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        betaFeatures: { missionWorkbench: true, newBrowser: true },
      }),
    );
    expect(useBetaFeaturesStore.getState().features.newBrowser).toBe(true);
  });

  it("rolls the switch back and reports the error when the write fails", async () => {
    getAppSettings.mockResolvedValue({ betaFeatures: {} });
    updateAppSettings.mockRejectedValue(new Error("disk full"));
    await render();

    act(() => click(switchFor("新建浏览器入口")));
    await act(async () => {});

    expect(useBetaFeaturesStore.getState().features.newBrowser).toBeUndefined();
    expect(switchFor("新建浏览器入口").checked).toBe(false);
    expect(container.textContent).toContain("disk full");
  });

  it("exposes the multi-machine beta only on a capable Hub and persists its flag", async () => {
    bridge.supported = true;
    window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC6");
    getAppSettings.mockResolvedValue({ betaFeatures: {} });
    updateAppSettings.mockResolvedValue(undefined);
    await render();
    await act(async () => click(switchFor("多机器会话")));
    expect(updateAppSettings).toHaveBeenCalledWith(expect.objectContaining({ betaFeatures: { "web.multiMachine": true } }));
    expect(new URL(multiMachinePageUrl(false)).searchParams.has("global")).toBe(false);
    expect(new URL(multiMachinePageUrl(false)).searchParams.get("machine")).toBe("PC6");
  });

  it("rejects enabling multi-machine on an old Hub without writing the setting", async () => {
    await expect(useBetaFeaturesStore.getState().setFeature("web.multiMachine", true)).rejects.toThrow(/Hub/);
    expect(updateAppSettings).not.toHaveBeenCalled();
  });
});
