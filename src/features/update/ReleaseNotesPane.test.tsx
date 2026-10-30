import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { relayUpdateProbe: vi.fn() } }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/platform", () => ({
  getAppVersion: async () => "1.0.5",
  openExternal: vi.fn(),
}));

import i18n from "@/lib/i18n";
import { CHANGELOG_DATA } from "@/version/changelog";
import { ReleaseNotesPane } from "./ReleaseNotesPane";
import { useReleaseNotesTabStore } from "./notes-tab";
import { useUpdateStore } from "./store";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const checkForUpdatesSpy = vi.fn(async () => {});

/** The local changelog's newest entry, shown when no upgrade is announced. */
const newest = CHANGELOG_DATA[0];

/** First bolded title of the newest entry; asserting on this instead of a
 *  hard-coded phrase keeps the test valid across releases. */
const newestMarker = newest.content.zh.match(/\*\*(.+?)\*\*/)?.[1] ?? "";

describe("ReleaseNotesPane", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    useUpdateStore.setState({
      stage: "idle",
      version: undefined,
      error: undefined,
      checkForUpdates: checkForUpdatesSpy,
    });
    useReleaseNotesTabStore.setState({ open: true, active: true, unreadVersion: undefined });
    checkForUpdatesSpy.mockClear();
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
      nextRoot.render(<ReleaseNotesPane />);
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
  }

  /** 页头版本号旁的「新版本」胶囊：按元素精确匹配，不在正文里找这个词——
   *  更新说明正文本来就会写「新版本」。 */
  function hasNewVersionPill(): boolean {
    const label = i18n.t("changelog.newVersion");
    return [...container.querySelectorAll("span")].some((el) => el.textContent === label);
  }

  it("shows the newest local entry when no upgrade is announced", async () => {
    await render();

    expect(container.textContent).toContain(`v${newest.version}`);
    expect(container.textContent).toContain(newestMarker);
    // 手动打开（没有升级宣布）不带「新版本」标记。
    expect(hasNewVersionPill()).toBe(false);
  });

  it("announces the upgraded version from the local history with the 新版本 marker", async () => {
    const upgraded = CHANGELOG_DATA[1];
    const upgradedMarker = upgraded.content.zh.match(/\*\*(.+?)\*\*/)?.[1] ?? "";
    useReleaseNotesTabStore.setState({ open: true, active: true, unreadVersion: upgraded.version });
    await render();

    expect(container.textContent).toContain(`v${upgraded.version}`);
    expect(container.textContent).toContain(upgradedMarker);
    expect(hasNewVersionPill()).toBe(true);
    // 最新一条的说明不能顶替宣布版本（版本号与正文同源）。
    expect(container.textContent).not.toContain(newestMarker);
  });

  it("says so instead of borrowing another version's notes", async () => {
    // 用一个本地记录保证不会有的号，避免真实发布后用例前提失效。
    const unknown = "9.9.9";
    useReleaseNotesTabStore.setState({ open: true, active: true, unreadVersion: unknown });
    await render();

    expect(container.textContent).toContain(`v${unknown}`);
    expect(container.textContent).toContain("这个版本没有附带更新说明。");
    expect(container.textContent).not.toContain(newestMarker);
  });

  it("a Hub release found by the check does not replace the local notes heading", async () => {
    useUpdateStore.setState({ stage: "available", version: "9.9.9" });
    await render();

    expect(container.textContent).toContain(`v${newest.version}`);
    expect(container.textContent).toContain(newestMarker);
    expect(container.textContent).toContain("发现新版本 v9.9.9，正在后台下载，空闲时自动安装");
  });

  it("checks for updates in place and reports the already-latest result", async () => {
    checkForUpdatesSpy.mockImplementation(async () => {
      useUpdateStore.setState({ stage: "latest", version: "1.0.7" });
    });
    await render();

    const check = button(i18n.t("settings.checkUpdates"));
    expect(check).not.toBeUndefined();
    await act(async () => check!.click());

    expect(checkForUpdatesSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("当前已是最新版本 · Hub 最新为 v1.0.7");
  });

  it("disables the check while one is already running", async () => {
    useUpdateStore.setState({ stage: "checking" });
    await render();

    expect(container.textContent).toContain("正在检查更新…");
    expect(button(i18n.t("settings.checkUpdates"))!.disabled).toBe(true);
  });

  it("surfaces a failed check as an alert and keeps the check button as the retry", async () => {
    useUpdateStore.setState({ stage: "error", error: "network down" });
    await render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("检查更新失败：network down");
    expect(button(i18n.t("settings.checkUpdates"))!.disabled).toBe(false);
  });
});
