import { create } from "zustand";
import { ipc, ipcForMachine, type BranchInfo, type GitStatus } from "@/lib/ipc";
import { machineResourceKey } from "@/lib/web-machine";
import { errorText } from "@/lib/errors";

const TTL_MS = 30_000;

/** A file whose diff is shown: staged (index vs HEAD) or unstaged/untracked. */
export interface DiffTarget {
  file: string;
  staged: boolean;
}

function isNotARepo(err: unknown): boolean {
  return errorText(err).includes("NOT_A_REPO");
}

/** Partial state marking a workspace as a non-repo after a NOT_A_REPO error. */
function notRepoPatch(workspacePath: string) {
  return (s: GitStore) => ({
    notRepoByWorkspace: { ...s.notRepoByWorkspace, [workspacePath]: true },
    statusByWorkspace: { ...s.statusByWorkspace, [workspacePath]: undefined },
  });
}

interface GitStore {
  statusByWorkspace: Record<string, GitStatus | undefined>;
  notRepoByWorkspace: Record<string, boolean>;
  errorByWorkspace: Record<string, string | null>;
  branchesByWorkspace: Record<string, BranchInfo[] | undefined>;
  /** epoch ms of last successful/failed fetch per workspace (TTL bookkeeping) */
  fetchedAtByWorkspace: Record<string, number>;
  /** Diff open in the center area; null = center shows chat/files. */
  diffView: { workspacePath: string; target: DiffTarget; machine?: string } | null;
  openDiff: (workspacePath: string, target: DiffTarget, machine?: string) => void;
  closeDiff: () => void;
  /** Dismiss the surfaced refresh error for one workspace. */
  clearError: (workspacePath: string, machine?: string) => void;

  /** Refreshes status; skipped when fetched < 30s ago unless `force`. */
  refresh: (workspacePath: string, force?: boolean, machine?: string) => Promise<void>;
  loadBranches: (workspacePath: string, machine?: string) => Promise<void>;

  // Mutating actions — each force-refreshes status afterwards. Errors are
  // re-thrown so callers can surface them inline.
  stage: (workspacePath: string, files: string[], machine?: string) => Promise<void>;
  unstage: (workspacePath: string, files: string[], machine?: string) => Promise<void>;
  discard: (workspacePath: string, files: string[], machine?: string) => Promise<void>;
  commit: (workspacePath: string, message: string, machine?: string) => Promise<string>;
  push: (workspacePath: string, machine?: string) => Promise<void>;
  pull: (workspacePath: string, machine?: string) => Promise<void>;
  checkout: (workspacePath: string, branch: string, machine?: string) => Promise<void>;
  createBranch: (workspacePath: string, name: string, machine?: string) => Promise<void>;
}

/** In-flight refresh dedup per workspace. */
const inflight = new Map<string, Promise<void>>();

export const useGitStore = create<GitStore>((set, get) => {
  const runMutation = async (
    workspacePath: string,
    action: () => Promise<unknown>,
    machine?: string,
  ) => {
    const key = machineResourceKey(workspacePath, machine);
    try {
      return await action();
    } catch (err) {
      if (isNotARepo(err)) {
        set(notRepoPatch(key));
      }
      throw err;
    } finally {
      // Status changed (or may have): drop the TTL and refetch.
      set((s) => ({
        fetchedAtByWorkspace: { ...s.fetchedAtByWorkspace, [key]: 0 },
      }));
      get()
        .refresh(workspacePath, true, machine)
        .catch(() => undefined);
      // The file tree's git badges/colors are stale after any mutation
      // (commit/stage/checkout); refreshTree re-walks every loaded level.
      // 动态引入避免与 files/store 的模块环：文件抢到中心时也要关差异页签。
      void import("@/features/files/store")
        .then((m) => m.useFilesStore.getState().machine === machine ? m.useFilesStore.getState().refreshTree() : undefined)
        .catch(() => undefined);
    }
  };

  return {
    statusByWorkspace: {},
    notRepoByWorkspace: {},
    errorByWorkspace: {},
    branchesByWorkspace: {},
    fetchedAtByWorkspace: {},
    diffView: null,

    openDiff: (workspacePath, target, machine) => set({ diffView: { workspacePath, target, ...(machine ? { machine } : {}) } }),
    closeDiff: () => set({ diffView: null }),
    clearError: (workspacePath, machine) =>
      set((s) => ({
        errorByWorkspace: { ...s.errorByWorkspace, [machineResourceKey(workspacePath, machine)]: null },
      })),

    refresh: (workspacePath, force = false, machine) => {
      const key = machineResourceKey(workspacePath, machine);
      const last = get().fetchedAtByWorkspace[key];
      if (!force && last && Date.now() - last < TTL_MS) return Promise.resolve();
      const pending = inflight.get(key);
      if (pending) return pending;

      const task = (machine ? ipcForMachine(machine) : ipc)
        .gitStatus(workspacePath)
        .then((status) => {
          set((s) => ({
            statusByWorkspace: { ...s.statusByWorkspace, [key]: status },
            notRepoByWorkspace: { ...s.notRepoByWorkspace, [key]: false },
            errorByWorkspace: { ...s.errorByWorkspace, [key]: null },
            fetchedAtByWorkspace: {
              ...s.fetchedAtByWorkspace,
              [key]: Date.now(),
            },
          }));
        })
        .catch((err: unknown) => {
          set((s) => ({
            statusByWorkspace: { ...s.statusByWorkspace, [key]: undefined },
            notRepoByWorkspace: {
              ...s.notRepoByWorkspace,
              [key]: isNotARepo(err),
            },
            errorByWorkspace: {
              ...s.errorByWorkspace,
              [key]: isNotARepo(err) ? null : errorText(err),
            },
            fetchedAtByWorkspace: {
              ...s.fetchedAtByWorkspace,
              [key]: Date.now(),
            },
          }));
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, task);
      return task;
    },

    loadBranches: async (workspacePath, machine) => {
      const key = machineResourceKey(workspacePath, machine);
      if (get().notRepoByWorkspace[key]) return;
      try {
        const branches = await (machine ? ipcForMachine(machine) : ipc).gitBranches(workspacePath);
        set((s) => ({
          branchesByWorkspace: { ...s.branchesByWorkspace, [key]: branches },
        }));
      } catch (err) {
        if (isNotARepo(err)) {
          set(notRepoPatch(key));
        }
      }
    },

    stage: (workspacePath, files, machine) =>
      runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitStage(workspacePath, files), machine) as Promise<void>,
    unstage: (workspacePath, files, machine) =>
      runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitUnstage(workspacePath, files), machine) as Promise<void>,
    discard: (workspacePath, files, machine) =>
      runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitDiscard(workspacePath, files), machine) as Promise<void>,
    commit: (workspacePath, message, machine) =>
      runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitCommit(workspacePath, message), machine) as Promise<string>,
    push: (workspacePath, machine) =>
      runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitPush(workspacePath), machine) as Promise<void>,
    pull: (workspacePath, machine) =>
      runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitPull(workspacePath), machine) as Promise<void>,
    checkout: async (workspacePath, branch, machine) => {
      await runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitCheckout(workspacePath, branch), machine);
      await get().loadBranches(workspacePath, machine);
    },
    createBranch: async (workspacePath, name, machine) => {
      await runMutation(workspacePath, () => (machine ? ipcForMachine(machine) : ipc).gitCreateBranch(workspacePath, name), machine);
      await get().loadBranches(workspacePath, machine);
    },
  };
});
