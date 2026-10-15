import { describe, expect, it, vi } from "vitest";
import type { ActiveRun, SessionMeta } from "@/lib/ipc";
import { persistTabs } from "./store/persistence";
import { sessionsHeldByLiveRuns } from "./store/session-utils";
import { useChatStore } from "./store";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listWorkspaces: vi.fn(async () => [
      {
        id: "ws-1",
        path: "/tmp/ws",
        name: "ws",
        lastOpenedAt: null,
        sortOrder: null,
        groupId: null,
      },
    ]),
    listSessions: vi.fn(async () => []),
    listArchivedSessions: vi.fn(async () => []),
    listEngines: vi.fn(async () => [
      { id: "codex", available: true, enabled: true, supportsImages: false },
    ]),
    listActiveRuns: vi.fn(async () => [
      {
        runId: "run-new",
        engine: "codex",
        sessionId: "s-new",
        workspacePath: "/tmp/ws",
      },
    ]),
    loadSessionPage: vi.fn(async () => {
      throw new Error("session not found: codex/s-new");
    }),
    listPlanReviews: vi.fn(async () => []),
    getAppSettings: vi.fn(async () => ({})),
    getCliConfig: vi.fn(async () => ({})),
    rescanSessions: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const RUN: ActiveRun = {
  runId: "run-new",
  engine: "codex",
  sessionId: "s-new",
  workspacePath: "/tmp/ws",
};

function scanned(sessionId: string): SessionMeta {
  return {
    engine: "codex",
    sessionId,
    workspacePath: "/tmp/ws",
    filePath: "/tmp/ws/session.jsonl",
    fileSize: 10,
    fileMtimeMs: 1,
    title: "already on disk",
    preview: "",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    pinned: false,
    customTitle: null,
  };
}

describe("a new session the scanner has not indexed", () => {
  it("keeps one sidebar row for a live run and leaves indexed sessions alone", () => {
    const held = sessionsHeldByLiveRuns([scanned("s-old")], [RUN, { ...RUN, runId: "run-2" }]);
    expect(held.map((s) => s.sessionId)).toEqual(["s-new", "s-old"]);
    expect(held[0]?.filePath).toBe("");
    expect(sessionsHeldByLiveRuns([scanned("s-new")], [RUN])).toEqual([scanned("s-new")]);
    expect(
      sessionsHeldByLiveRuns([], [{ ...RUN, sessionId: null }]).length,
    ).toBe(0);
  });

  it("is still open after a reload, before the first reply is indexed", async () => {
    localStorage.clear();
    const tab = { engine: "codex", sessionId: "s-new", workspacePath: "/tmp/ws" };
    persistTabs([tab], tab);

    await useChatStore.getState().init();
    await Promise.resolve();

    const state = useChatStore.getState();
    expect(state.sessions.some((s) => s.sessionId === "s-new" && s.filePath === "")).toBe(true);
    expect(state.openTabs).toEqual([tab]);
    expect(state.active).toMatchObject(tab);
    expect(state.streamingByKey["codex/s-new"]).toBe(true);
    expect(state.bySession["codex/s-new"]?.streaming).toBe(true);
    expect(state.bySession["codex/s-new"]?.error).toBeNull();
  });
});
