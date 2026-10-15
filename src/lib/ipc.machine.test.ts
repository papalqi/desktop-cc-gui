import { beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ invoke: vi.fn(async () => null), isWeb: true,
  listen: vi.fn(async () => () => {}), webBridgeGeneration: () => 0, webBridgeFeature: () => false,
}));
vi.mock("./transport", () => transport);

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC0");
});

it("namespaces workspace IDs and directs their mutations back to the owning executor", async () => {
  const { ipc } = await import("./ipc");
  transport.invoke.mockResolvedValueOnce([
    { id: "same", machine: "PC0", parentId: "parent", path: "E:/same" },
    { id: "same", machine: "PC6", path: "E:/same" },
  ] as never);
  const rows = await ipc.listWorkspaces();
  expect(rows.map((w) => [w.id, w.executorId])).toEqual([["PC0/same", "same"], ["PC6/same", "same"]]);
  expect(rows[0].parentId).toBe("PC0/parent");
  await ipc.removeWorkspace(rows[1].id);
  expect(transport.invoke).toHaveBeenLastCalledWith("remove_workspace", { id: "same" }, "PC6");
  await ipc.reorderWorkspaces(["PC6/second", "PC0/first", "PC6/same"]);
  expect(transport.invoke).toHaveBeenCalledWith("reorder_workspaces", { ids: ["second", "same"] }, "PC6");
  expect(transport.invoke).toHaveBeenCalledWith("reorder_workspaces", { ids: ["first"] }, "PC0");
});

it("keeps a scoped client on its machine for files, Git and replies after selection changes", async () => {
  const { ipcForMachine } = await import("./ipc");
  const client = ipcForMachine("PC6");
  const { setWebMachine } = await import("./web-machine");
  setWebMachine("PC0");
  await client.readFile("E:/same/file.txt");
  expect(transport.invoke).toHaveBeenLastCalledWith("read_file", { path: "E:/same/file.txt" }, "PC6");
  await client.answerQuestion("run", "ask", null);
  expect(transport.invoke).toHaveBeenLastCalledWith("answer_question", { sessionId: "run", requestId: "ask", answers: null }, "PC6");
});

it("keeps legacy machine-bound catalogs compatible with their existing tab identities", async () => {
  window.history.replaceState(null, "", "/CCGUI/?machine=PC0");
  const { ipc } = await import("./ipc");
  transport.invoke.mockResolvedValueOnce([{ machine: "PC0", engine: "codex", sessionId: "same" }] as never);
  expect(await ipc.listSessions()).toEqual([{ engine: "codex", sessionId: "same" }]);
});

it("decodes the parent workspace and keeps worktree registration on that machine", async () => {
  const { ipc } = await import("./ipc");
  transport.invoke.mockResolvedValueOnce({ id: "child", parentId: "parent", path: "/repo-child" } as never);
  const row = await ipc.addWorktreeWorkspace("/repo-child", "PC6/parent");
  expect(transport.invoke).toHaveBeenLastCalledWith("add_workspace", { path: "/repo-child", meta: null, kind: "worktree", parentId: "parent" }, "PC6");
  expect(row).toMatchObject({ id: "PC6/child", parentId: "PC6/parent", machine: "PC6" });
});
