import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta, Workspace } from "@/lib/ipc";
import {
  ARCHIVE_WEEK_MS,
  catalogFingerprint,
  collectPinnedRows,
  prefetchMachineCatalog,
  publishMachineCatalog,
  readMachineCatalog,
  resetMachineCatalogsForTests,
  sessionsToArchive,
  writeMachineCatalog,
} from "./machine-catalog";
import { queryMachine } from "@/lib/machine-bridge";

vi.mock("@/lib/machine-bridge", () => ({
  queryMachine: vi.fn(),
}));

function session(patch: Partial<SessionMeta> & Pick<SessionMeta, "sessionId">): SessionMeta {
  return {
    engine: "codex",
    workspacePath: "/repo",
    filePath: "/repo/session.jsonl",
    fileSize: 1,
    fileMtimeMs: 1,
    title: patch.sessionId,
    preview: "hello",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    pinned: false,
    customTitle: null,
    ...patch,
  };
}

const workspace: Workspace = {
  id: "w",
  path: "/repo",
  name: "Repo",
  lastOpenedAt: null,
  sortOrder: null,
  groupId: null,
};

describe("week archive", () => {
  const now = 10 * ARCHIVE_WEEK_MS;

  it("keeps pinned, running, recent, and undated sessions", () => {
    const old = session({ sessionId: "old", updatedAt: now - ARCHIVE_WEEK_MS - 1 });
    const pinned = session({ sessionId: "pin", updatedAt: old.updatedAt, pinned: true });
    const recent = session({ sessionId: "new", updatedAt: now - 1_000 });
    const running = session({ sessionId: "run", updatedAt: old.updatedAt });
    const undated = session({ sessionId: "none", updatedAt: null, createdAt: null, fileMtimeMs: 0 });
    expect(
      sessionsToArchive(
        [old, pinned, recent, running, undated],
        now - ARCHIVE_WEEK_MS,
        new Set(["codex/run"]),
      ).map((item) => item.sessionId),
    ).toEqual(["old"]);
  });
});

describe("machine catalog cache", () => {
  afterEach(() => {
    resetMachineCatalogsForTests();
  });

  it("drops a reply that started before a newer catalog was stored", () => {
    const lists = {
      workspaces: [workspace],
      sessions: [session({ sessionId: "a", preview: "drop me" })],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
    };
    expect(writeMachineCatalog("PC5", lists, 1)).toBe(true);
    expect(readMachineCatalog("PC5")?.sessions[0]?.preview).toBe("");
    expect(writeMachineCatalog("PC5", { ...lists, sessions: [] }, 0)).toBe(false);
    expect(readMachineCatalog("PC5")?.sessions).toHaveLength(1);
  });

  it("lists pinned sessions from every machine, newest first", () => {
    publishMachineCatalog("PC6", {
      workspaces: [workspace],
      sessions: [session({ sessionId: "old", updatedAt: 10, pinned: true })],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
    });
    publishMachineCatalog("PC0", {
      workspaces: [{ ...workspace, name: "Other" }],
      sessions: [
        session({ sessionId: "new", updatedAt: 50, pinned: true }),
        session({ sessionId: "plain", updatedAt: 80, pinned: false }),
      ],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
    });
    expect(collectPinnedRows({ PC0: readMachineCatalog("PC0")!, PC6: readMachineCatalog("PC6")! }, ["PC0", "PC6", "PC5", "MC2"])).toEqual([
      { machine: "PC0", session: expect.objectContaining({ sessionId: "new" }), workspaceName: "Other" },
      { machine: "PC6", session: expect.objectContaining({ sessionId: "old" }), workspaceName: "Repo" },
    ]);
  });

  it("does not store a reply that matches the desktop already on screen", async () => {
    const lists = {
      workspaces: [workspace],
      sessions: [session({ sessionId: "a", preview: "keep" })],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
    };
    publishMachineCatalog("PC5", lists);
    const sameAs = catalogFingerprint(readMachineCatalog("PC5")!);
    const reply = (sessionId: string) =>
      vi.mocked(queryMachine).mockImplementation(async (_machine, run) =>
        run((async (cmd: string) => {
          if (cmd === "list_workspaces") return [workspace];
          if (cmd === "list_sessions") return [session({ sessionId, preview: "wire" })];
          return {};
        }) as never),
      );
    reply("a");
    await prefetchMachineCatalog("PC0", sameAs);
    expect(readMachineCatalog("PC0")).toBeNull();

    reply("other");
    await prefetchMachineCatalog("PC0", sameAs);
    expect(readMachineCatalog("PC0")?.sessions.map((item) => item.sessionId)).toEqual(["other"]);
    expect(readMachineCatalog("PC0")?.sessions[0]?.preview).toBe("");
  });

  it("stores which sessions were still running", async () => {
    vi.mocked(queryMachine).mockImplementation(async (_machine, run) =>
      run((async (cmd: string) => {
        if (cmd === "list_workspaces") return [workspace];
        if (cmd === "list_sessions") return [session({ sessionId: "other" })];
        if (cmd === "list_active_runs") return [{ engine: "codex", sessionId: "other" }];
        return {};
      }) as never),
    );
    await prefetchMachineCatalog("PC0");
    expect(readMachineCatalog("PC0")?.runningKeys).toEqual(["codex/other"]);
  });

  it("keeps noted running sessions when the desktop has no process table", async () => {
    publishMachineCatalog("MC2", {
      workspaces: [workspace],
      sessions: [session({ sessionId: "live", pinned: true })],
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      threadLimit: 5,
      runningKeys: ["codex/live"],
    });
    vi.mocked(queryMachine).mockImplementation(async (_machine, run) =>
      run((async (cmd: string) => {
        if (cmd === "list_workspaces") return [workspace];
        if (cmd === "list_sessions") return [session({ sessionId: "live", pinned: true })];
        if (cmd === "list_active_runs") throw new Error("unknown command");
        return {};
      }) as never),
    );
    await prefetchMachineCatalog("MC2");
    expect(readMachineCatalog("MC2")?.runningKeys).toEqual(["codex/live"]);
  });
});
