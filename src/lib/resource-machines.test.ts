import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent, GitStatus } from "./ipc";

const machines = vi.hoisted(() => {
  const client = () => ({
    listDir: vi.fn(async () => []),
    gitTreeStatus: vi.fn(async () => ({ repositories: [], fileColors: {} })),
    readFile: vi.fn<(path: string) => Promise<FileContent>>(),
    gitStatus: vi.fn<(path: string) => Promise<GitStatus>>(),
    terminalClose: vi.fn(async () => {}),
  });
  return { PC0: client(), PC6: client() };
});
vi.mock("./ipc", () => ({ ipc: {}, ipcForMachine: (machine: keyof typeof machines) => machines[machine] }));
vi.mock("@/features/browser/store", () => ({ useBrowserStore: { getState: () => ({ deactivate: () => {} }) } }));
vi.mock("./events", () => ({ listenTerminalOutput: vi.fn(async () => () => {}) }));

import { useFilesStore } from "@/features/files/store";
import { useGitStore } from "@/features/git/store";
import { useTerminalStore } from "@/features/terminal/store";
import { machineResourceKey } from "./web-machine";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const content = (text: string): FileContent => ({ kind: "text", text, dataUrl: null, truncated: false });
const status = (branch: string) => ({ branch, staged: [], unstaged: [], untracked: [] }) as unknown as GitStatus;

describe("workspace resources keep their executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFilesStore.setState({ machine: undefined, root: "", children: {}, loadingDirs: {}, openFiles: [], fileStates: {}, activeFilePath: null, dirtyPaths: {} });
    useGitStore.setState({ statusByWorkspace: {}, fetchedAtByWorkspace: {}, notRepoByWorkspace: {}, errorByWorkspace: {} });
    useTerminalStore.setState({ open: false, tabsByWorkspace: {}, activeByWorkspace: {} });
  });

  it("keeps identical file paths and late reads separate and renames only the owning machine", async () => {
    const first = deferred<FileContent>();
    machines.PC0.readFile.mockReturnValueOnce(first.promise);
    machines.PC6.readFile.mockResolvedValue(content("PC6"));
    const files = useFilesStore.getState();
    const loading = files.openFile("/repo/a.ts", "PC0");
    await files.openFile("/repo/a.ts", "PC6");
    first.resolve(content("PC0"));
    await loading;
    const pc0 = machineResourceKey("/repo/a.ts", "PC0");
    const pc6 = machineResourceKey("/repo/a.ts", "PC6");
    expect(useFilesStore.getState().openFiles).toEqual([pc0, pc6]);
    expect(useFilesStore.getState().fileStates[pc0].content?.text).toBe("PC0");
    expect(useFilesStore.getState().fileStates[pc6].content?.text).toBe("PC6");
    expect(useFilesStore.getState().activeFilePath).toBe(pc6);
    useFilesStore.setState({ machine: "PC0" });
    files.remapOpenFiles("/repo/a.ts", "/repo/b.ts");
    expect(useFilesStore.getState().openFiles).toEqual([machineResourceKey("/repo/b.ts", "PC0"), pc6]);
    files.closeFilesUnder("/repo");
    expect(useFilesStore.getState().openFiles).toEqual([pc6]);
  });

  it("ignores a read from a closed file after that same file is reopened", async () => {
    const first = deferred<FileContent>();
    machines.PC0.readFile.mockReturnValueOnce(first.promise).mockResolvedValue(content("new"));
    const files = useFilesStore.getState();
    const loading = files.openFile("/repo/a.ts", "PC0");
    const key = machineResourceKey("/repo/a.ts", "PC0");
    files.closeFile(key);
    await files.openFile("/repo/a.ts", "PC0");
    first.resolve(content("old"));
    await loading;
    expect(useFilesStore.getState().fileStates[key].content?.text).toBe("new");
  });

  it("does not deduplicate Git reads for the same path on different machines", async () => {
    const first = deferred<GitStatus>();
    machines.PC0.gitStatus.mockReturnValueOnce(first.promise);
    machines.PC6.gitStatus.mockResolvedValue(status("pc6"));
    const git = useGitStore.getState();
    const loading = git.refresh("/repo", false, "PC0");
    await git.refresh("/repo", false, "PC6");
    first.resolve(status("pc0"));
    await loading;
    expect(machines.PC0.gitStatus).toHaveBeenCalledWith("/repo");
    expect(machines.PC6.gitStatus).toHaveBeenCalledWith("/repo");
    expect(useGitStore.getState().statusByWorkspace[machineResourceKey("/repo", "PC0")]?.branch).toBe("pc0");
    expect(useGitStore.getState().statusByWorkspace[machineResourceKey("/repo", "PC6")]?.branch).toBe("pc6");
  });

  it("restarts an in-flight file read at its new path after a rename", async () => {
    const first = deferred<FileContent>();
    machines.PC0.readFile.mockReturnValueOnce(first.promise).mockResolvedValueOnce(content("renamed"));
    const files = useFilesStore.getState();
    const loading = files.openFile("/repo/a.ts", "PC0");
    useFilesStore.setState({ machine: "PC0" });
    files.remapOpenFiles("/repo/a.ts", "/repo/b.ts");
    await Promise.resolve();
    first.resolve(content("stale"));
    await loading;
    const entry = useFilesStore.getState().fileStates[machineResourceKey("/repo/b.ts", "PC0")];
    expect(entry.loading).toBe(false);
    expect(entry.content?.text).toBe("renamed");
    expect(machines.PC0.readFile).toHaveBeenLastCalledWith("/repo/b.ts");
  });

  it("closes only the terminal sessions belonging to the removed workspace machine", () => {
    const terminals = useTerminalStore.getState();
    terminals.newTab("/repo", "PC0");
    terminals.newTab("/repo", "PC6");
    const first = useTerminalStore.getState().tabsByWorkspace[machineResourceKey("/repo", "PC0")][0];
    terminals.removeWorkspace("/repo", "PC0");
    expect(machines.PC0.terminalClose).toHaveBeenCalledWith(first.id);
    expect(machines.PC6.terminalClose).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().tabsByWorkspace[machineResourceKey("/repo", "PC6")]).toHaveLength(1);
  });
});
