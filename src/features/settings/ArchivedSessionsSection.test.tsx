import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SessionMeta } from "@/lib/ipc";
import "@/lib/i18n";
import { ArchivedSessionsSection } from "./ArchivedSessionsSection";

const rpc = vi.hoisted(() => ({
  scope: "all" as "all" | "remote",
  base: { filePath: "", fileSize: 0, fileMtimeMs: 0, preview: "", createdAt: null, messageCount: 0, pinned: false, customTitle: null },
  PC0: { restoreSession: vi.fn(async () => {}) }, PC6: { restoreSession: vi.fn(async () => {}) },
  listArchivedSessions: vi.fn(async (): Promise<SessionMeta[]> => ["PC0", "PC6"].map((machine) => ({ ...rpc.base, machine, engine: "codex", sessionId: "same",
    workspacePath: "/same", title: `${machine} session`, updatedAt: null }))),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { listArchivedSessions: rpc.listArchivedSessions }, ipcForMachine: (machine: "PC0" | "PC6") => rpc[machine] }));
vi.mock("@/features/chat/store", async () => ({
  sessionKey: (await import("@/features/chat/store/persistence")).sessionKey,
  useChatStore: (select: (state: unknown) => unknown) => select({ workspaces: [], sessionScope: rpc.scope }),
}));
vi.mock("@/lib/events", () => ({ listenSessionsChanged: vi.fn(async () => () => {}) }));

it("groups identical archived paths by machine and restores the selected row on its owner", async () => {
  rpc.scope = "all";
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ArchivedSessionsSection />));
    expect(container.textContent).toContain("PC0 · same");
    expect(container.textContent).toContain("PC6 · same");
    const buttons = [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("恢复"));
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1].click());
    expect(rpc.PC6.restoreSession).toHaveBeenCalledWith("codex", "same");
    expect(rpc.PC0.restoreSession).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("does not put an old all-scope response into the remote view", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rpc.scope = "all";
  let resolveOld!: (rows: SessionMeta[]) => void;
  rpc.listArchivedSessions.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ArchivedSessionsSection />));
    rpc.scope = "remote";
    rpc.listArchivedSessions.mockResolvedValueOnce([{ ...rpc.base, machine: "PC6", engine: "codex", sessionId: "remote", workspacePath: "/same", title: "remote row", updatedAt: null, origin: "hub" }]);
    await act(async () => root.render(<ArchivedSessionsSection />));
    await act(async () => resolveOld([{ ...rpc.base, engine: "codex", sessionId: "local", workspacePath: "/same", title: "stale local row", updatedAt: null, origin: "local" }]));
    expect(container.textContent).toContain("remote row");
    expect(container.textContent).not.toContain("stale local row");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    rpc.scope = "all";
  }
});
