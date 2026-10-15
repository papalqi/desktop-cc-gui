import { beforeEach, describe, expect, it, vi } from "vitest";

/** The transport is the only backend edge this module has. */
const { invoke, connection } = vi.hoisted(() => ({
  invoke: vi.fn(),
  connection: { web: false, generation: 0 },
}));
vi.mock("./transport", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  listen: vi.fn(async () => () => {}),
  get isWeb() { return connection.web; },
  webBridgeGeneration: () => connection.generation,
  webToken: null,
  serverVersion: async () => null,
}));

/** Only the fields under test; the rest of the shape is irrelevant here. */
const settings = (over: Record<string, unknown>) =>
  ({ theme: "system", ...over }) as never;

/** Fresh module per case: the cache is module state. */
let ipc: (typeof import("./ipc"))["ipc"];
beforeEach(async () => {
  invoke.mockReset();
  connection.web = false;
  connection.generation = 0;
  vi.resetModules();
  ({ ipc } = await import("./ipc"));
});

describe("app settings cache", () => {
  it("serves repeat reads from a single backend call", async () => {
    invoke.mockResolvedValue(settings({ theme: "dark" }));
    await ipc.getAppSettings();
    await ipc.getAppSettings();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-reads settings the backend rotated on its own", async () => {
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "AAAA2222" }));
    await ipc.getAppSettings();
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "BBBB3333" }));
    await expect(ipc.refreshAppSettings()).resolves.toMatchObject({
      webAuthKey: "BBBB3333",
    });
    // The fresh copy is what later reads — and later writes — see.
    await expect(ipc.getAppSettings()).resolves.toMatchObject({
      webAuthKey: "BBBB3333",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("re-reads after a write instead of trusting what was sent", async () => {
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "OLDKEY22" }));
    const before = await ipc.getAppSettings();
    // A write answers with nothing (the command's contract); the next read
    // must hit the backend, never carry the written object.
    invoke.mockResolvedValueOnce(undefined);
    await ipc.updateAppSettings({ ...before, webAuthKey: null } as never);
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "NEWKEY33" }));
    await expect(ipc.getAppSettings()).resolves.toMatchObject({
      webAuthKey: "NEWKEY33",
    });
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "get_app_settings",
      "update_app_settings",
      "get_app_settings",
    ]);
  });

  it("reads the selected desktop's settings after a connection switch", async () => {
    connection.web = true;
    invoke.mockResolvedValueOnce(settings({ webRelayUrl: "http://relay/m/MC2" }));
    await ipc.getAppSettings();
    connection.generation += 1;
    invoke.mockResolvedValueOnce(settings({ webRelayUrl: "http://relay/m/PC0" }));
    const next = await ipc.getAppSettings();
    expect(next.webRelayUrl).toBe("http://relay/m/PC0");
    await ipc.updateAppSettings({ ...next, theme: "light" });
    expect(invoke).toHaveBeenLastCalledWith("update_app_settings", {
      settings: expect.objectContaining({ webRelayUrl: "http://relay/m/PC0", theme: "light" }),
    });
  });

  it("rejects a settings form read from the previous desktop", async () => {
    connection.web = true;
    invoke.mockResolvedValueOnce(settings({ webRelayUrl: "http://relay/m/MC2" }));
    const previous = await ipc.getAppSettings();
    connection.generation += 1;
    await expect(ipc.updateAppSettings({ ...previous, theme: "light" })).rejects.toThrow(
      "web bridge disconnected",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("discards a late old read without evicting the new desktop's cache", async () => {
    connection.web = true;
    const old = Promise.withResolvers<never>();
    invoke.mockReturnValueOnce(old.promise);
    const previous = ipc.getAppSettings();
    const rejected = expect(previous).rejects.toThrow("web bridge disconnected");
    connection.generation += 1;
    invoke.mockResolvedValueOnce(settings({ webRelayUrl: "http://relay/m/PC0" }));
    const nextRead = ipc.getAppSettings();
    old.resolve(settings({ webRelayUrl: "http://relay/m/MC2" }));
    const next = await nextRead;
    await rejected;
    expect(await ipc.getAppSettings()).toBe(next);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("git tree batch", () => {
  it("sends all directory levels through one command and preserves the response", async () => {
    const levels = [{ path: "C:/workspace", files: ["src"], directories: ["src"] }];
    const result = { repositories: [], fileColors: { "C:/workspace": { src: "modified" } } };
    invoke.mockResolvedValue(result);
    await expect(ipc.gitTreeStatus(levels)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("git_tree_status", { levels });
  });
});
