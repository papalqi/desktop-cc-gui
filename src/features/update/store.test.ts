import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayUpdateProbe } from "@/lib/ipc";

const probeMock = vi.fn<() => Promise<RelayUpdateProbe>>();
vi.mock("@/lib/ipc", () => ({ ipc: { relayUpdateProbe: () => probeMock() } }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));

// vi.mock calls above are hoisted, so this static import sees the mocks.
import { useUpdateStore } from "./store";

const probe = (overrides: Partial<RelayUpdateProbe>): RelayUpdateProbe => ({
  configured: true,
  current: "1.3.1",
  latest: "1.3.1",
  newer: false,
  failed: false,
  autoInstall: true,
  ...overrides,
});

beforeEach(() => {
  useUpdateStore.setState({ stage: "idle", version: undefined, error: undefined });
  probeMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkForUpdates against the Hub release", () => {
  it("an older or equal Hub release is reported as up to date, never as the newest version", async () => {
    // Regression: the old GitHub manifest (upstream v1.1.5) showed up as
    // "最新版为 v1.1.5" while v1.3.1 was installed.
    probeMock.mockResolvedValue(probe({ latest: "1.3.1", newer: false }));
    await useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({ stage: "latest", version: "1.3.1" });
  });

  it("a newer Hub release is available when this platform installs it by itself", async () => {
    probeMock.mockResolvedValue(probe({ latest: "1.3.2", newer: true }));
    await useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({ stage: "available", version: "1.3.2" });
  });

  it("a newer release on a platform without self-install asks for a manual install", async () => {
    probeMock.mockResolvedValue(probe({ latest: "1.3.2", newer: true, autoInstall: false }));
    await useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState().stage).toBe("manual");
  });

  it("a release that already failed to install is not presented as pending", async () => {
    probeMock.mockResolvedValue(probe({ latest: "1.3.2", newer: true, failed: true }));
    await useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({ stage: "failed", version: "1.3.2" });
  });

  it("no Hub connection means there is nothing to check", async () => {
    probeMock.mockResolvedValue(probe({ configured: false, latest: null }));
    await useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({ stage: "unconfigured", version: undefined });
  });

  it("a Hub without a published release reads as up to date", async () => {
    probeMock.mockResolvedValue(probe({ latest: null }));
    await useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({ stage: "latest", version: undefined });
  });

  it("a probe failure surfaces its message", async () => {
    probeMock.mockRejectedValue("release signature did not verify");
    await useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({ stage: "error", error: "release signature did not verify" });
  });

  it("a stuck probe turns into an error instead of checking forever", async () => {
    vi.useFakeTimers();
    probeMock.mockReturnValue(new Promise(() => {}));
    const pending = useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState().stage).toBe("checking");
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(useUpdateStore.getState()).toMatchObject({ stage: "error", error: "update check timed out" });
  });

  it("a superseded check cannot overwrite the newer result", async () => {
    const { promise: slow, resolve } = Promise.withResolvers<RelayUpdateProbe>();
    probeMock.mockReturnValueOnce(slow).mockResolvedValueOnce(probe({ latest: "1.3.2", newer: true }));
    const first = useUpdateStore.getState().checkForUpdates();
    await useUpdateStore.getState().checkForUpdates();
    resolve(probe({ latest: "1.3.1" }));
    await first;
    expect(useUpdateStore.getState()).toMatchObject({ stage: "available", version: "1.3.2" });
  });
});
