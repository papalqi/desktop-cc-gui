import { describe, expect, it } from "vitest";
import {
  applyMachineStatus,
  applyWatchedRunEvents,
  noteMachineRunningKeys,
  noteRunEvents,
  resetMachineRunWatchersForTests,
  runningKeysOf,
  seedRunTable,
  watchedRunningKeys,
  watchedSessionActivities,
} from "./machine-run-watch";

describe("machine run watch", () => {
  it("keeps approval and input states separate for identical sessions on different machines", () => {
    resetMachineRunWatchersForTests();
    const run = { engine: "codex", sessionId: "same", runId: "run", updatedAt: 10 };
    applyMachineStatus({ machines: [
      { name: "PC0", online: true, runs: [{ ...run, state: "awaiting-approval" }] },
      { name: "PC6", online: true, runs: [{ ...run, state: "awaiting-input" }] },
    ] });
    expect(watchedSessionActivities().PC0["codex/same"].state).toBe("awaiting-approval");
    expect(watchedSessionActivities().PC6["codex/same"].state).toBe("awaiting-input");
    const previous = watchedSessionActivities();
    applyMachineStatus({ machines: [{ name: "PC6", online: true, runs: [{ ...run, state: "awaiting-input" }] }] });
    expect(watchedSessionActivities()).toBe(previous);
    applyMachineStatus({ machines: [{ name: "PC0", online: true, runs: [] }] });
    expect(watchedSessionActivities().PC0).toEqual({});
    expect(watchedSessionActivities().PC6["codex/same"].state).toBe("awaiting-input");
    resetMachineRunWatchersForTests();
  });
  it("tracks a run from the first event until it finishes", () => {
    const table = seedRunTable([{ engine: "codex", sessionId: "live", runId: "r1" }]);
    expect(runningKeysOf(table)).toEqual(["codex/live"]);
    expect(
      noteRunEvents(table, [{ engine: "codex", sessionId: "live", runId: "r2", kind: "delta" }]),
    ).toBe(false);
    expect(
      noteRunEvents(table, [{ engine: "codex", sessionId: "live", runId: "r1", kind: "done" }]),
    ).toBe(false);
    expect(runningKeysOf(table)).toEqual(["codex/live"]);
    expect(
      noteRunEvents(table, [{ engine: "codex", sessionId: "live", runId: "r2", kind: "error" }]),
    ).toBe(true);
    expect(runningKeysOf(table)).toEqual([]);
  });

  it("clears waiting badges on completion and ignores a stale heartbeat", () => {
    resetMachineRunWatchersForTests();
    const run = { engine: "codex", sessionId: "same", runId: "ended", state: "awaiting-approval", updatedAt: 10 };
    applyMachineStatus({ machines: [{ name: "PC6", online: true, runs: [run] }] });
    applyWatchedRunEvents("PC6", [{ ...run, kind: "done" }]);
    expect(watchedSessionActivities().PC6).toEqual({});
    applyMachineStatus({ machines: [{ name: "PC6", online: true, runs: [run] }] });
    expect(watchedRunningKeys("PC6")).toEqual([]);
    expect(watchedSessionActivities().PC6).toEqual({});
    resetMachineRunWatchersForTests();
  });

  it("does not treat a permission prompt as a new run", () => {
    const table = seedRunTable([]);
    expect(
      noteRunEvents(table, [
        { engine: "codex", sessionId: "live", runId: "r1", kind: "permission_denied" },
      ]),
    ).toBe(false);
    expect(runningKeysOf(table)).toEqual([]);
  });

  it.each(["done", "error"])("does not revive a %s run from late events or a stale snapshot", (kind) => {
    const run = { engine: "codex", sessionId: "live", runId: "r1" };
    let table = seedRunTable([run]);
    noteRunEvents(table, [{ ...run, kind }]);
    noteRunEvents(table, [{ ...run, kind: "usage" }, { ...run, kind: "warn" }]);
    expect(runningKeysOf(table)).toEqual([]);

    table = seedRunTable([run], table);
    noteRunEvents(table, [{ ...run, kind: "delta" }]);
    expect(runningKeysOf(table)).toEqual([]);
    noteRunEvents(table, [{ ...run, runId: "r2", kind: "delta" }]);
    expect(runningKeysOf(table)).toEqual(["codex/live"]);
    noteRunEvents(table, [{ ...run, kind }]);
    expect(runningKeysOf(table)).toEqual(["codex/live"]);
  });

  it("keeps a noted run after leaving, and clears it when that run finishes", () => {
    resetMachineRunWatchersForTests();
    noteMachineRunningKeys("MC2", ["codex/live"]);
    expect(watchedRunningKeys("MC2")).toEqual(["codex/live"]);
    applyWatchedRunEvents("MC2", [
      { engine: "codex", sessionId: "live", runId: "r1", kind: "done" },
    ]);
    expect(watchedRunningKeys("MC2")).toEqual([]);
    resetMachineRunWatchersForTests();
  });

  it("takes every online machine's runs from one hub status and keeps an offline machine's last view", () => {
    resetMachineRunWatchersForTests();
    applyMachineStatus({ machines: [
      { name: "PC5", online: true, runs: [{ runId: "a", engine: "codex", sessionId: "busy" }, { runId: "new", engine: "claude", sessionId: null }] },
      { name: "MC2", online: true, runs: [{ runId: "b", engine: "grok", sessionId: "long" }] },
    ] });
    expect(watchedRunningKeys("PC5")).toEqual(["codex/busy"]);
    expect(watchedRunningKeys("MC2")).toEqual(["grok/long"]);

    applyMachineStatus({ machines: [
      { name: "PC5", online: true, runs: [] },
      { name: "MC2", online: false, runs: [] },
      { name: "PC9", online: true, runs: "bad" },
    ] });
    expect(watchedRunningKeys("PC5")).toEqual([]);
    expect(watchedRunningKeys("MC2")).toEqual(["grok/long"]);
    expect(watchedRunningKeys("PC9")).toBeNull();
    applyMachineStatus(null);
    applyMachineStatus({ machines: "bad" });
    expect(watchedRunningKeys("MC2")).toEqual(["grok/long"]);
    resetMachineRunWatchersForTests();
  });
});
