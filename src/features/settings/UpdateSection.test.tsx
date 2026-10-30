import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { relayUpdateProbe: vi.fn() } }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/platform", () => ({
  getAppVersion: async () => "1.3.1",
  openExternal: vi.fn(),
  isWeb: false,
}));

import "@/lib/i18n";
import { useUpdateStore } from "@/features/update/store";
import { UpdateSection } from "./UpdateSection";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const checkForUpdatesSpy = vi.fn();

describe("UpdateSection update row", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    checkForUpdatesSpy.mockReset();
    // The update store is module-level session state: drive it directly and
    // swap the action for a spy so button clicks are observable.
    useUpdateStore.setState({
      stage: "idle",
      version: undefined,
      error: undefined,
      checkForUpdates: checkForUpdatesSpy,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
    }
    container.remove();
  });

  async function render() {
    const nextRoot = createRoot(container);
    root = nextRoot;
    await act(async () => {
      nextRoot.render(<UpdateSection />);
    });
  }

  function rowButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
  }

  it("latest: names the Hub's release, not a GitHub one", async () => {
    useUpdateStore.setState({ stage: "latest", version: "1.3.1" });
    await render();
    expect(container.textContent).toContain("当前已是最新版本 · Hub 最新为 v1.3.1");
  });

  it("available: says the update installs in the background and offers no install button", async () => {
    useUpdateStore.setState({ stage: "available", version: "1.3.2" });
    await render();
    expect(container.textContent).toContain("发现新版本 v1.3.2，正在后台下载，空闲时自动安装");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("unconfigured: explains that no Hub is connected", async () => {
    useUpdateStore.setState({ stage: "unconfigured" });
    await render();
    expect(container.textContent).toContain("未连接远程 Hub，无法检查更新");
  });

  it("the check button runs a check and is disabled while one is running", async () => {
    await render();
    await act(async () => rowButton("检查更新")!.click());
    expect(checkForUpdatesSpy).toHaveBeenCalledTimes(1);

    await act(async () => useUpdateStore.setState({ stage: "checking" }));
    expect(rowButton("检查更新")!.disabled).toBe(true);
  });

  it("error: the row surfaces the failure and keeps the check as the retry", async () => {
    useUpdateStore.setState({ stage: "error", error: "network down" });
    await render();
    expect(container.textContent).toContain("检查更新失败：network down");
    expect(rowButton("检查更新")!.disabled).toBe(false);
  });
});
