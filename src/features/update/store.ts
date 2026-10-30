import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { isWeb } from "@/lib/transport";

/**
 * Result of asking the configured Hub for its signed release. Download and
 * install are driven by the native relay updater and reported through
 * `RelayUpdateNotice`; this store only answers "is there a newer version".
 */
export type UpdateStage =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  /** Newer release exists but this platform cannot install it by itself. */
  | "manual"
  /** The newer release already failed to install here; no automatic retry. */
  | "failed"
  /** No Hub connection is configured, so there is nothing to ask. */
  | "unconfigured"
  | "error";

interface UpdateStore {
  stage: UpdateStage;
  /** Hub release version, when the Hub has one published. */
  version?: string;
  error?: string;
  checkForUpdates: () => Promise<void>;
}

// The probe has its own HTTP timeout; this only guards a stuck IPC bridge so
// the row can never sit on "checking" forever.
const CHECK_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return result;
}

let checkRequestId = 0;

export const useUpdateStore = create<UpdateStore>((set) => ({
  stage: "idle",

  checkForUpdates: async () => {
    // The browser frontend has no native shell to update.
    if (isWeb) return;
    const requestId = ++checkRequestId;
    set({ stage: "checking", error: undefined });
    try {
      const probe = await withTimeout(ipc.relayUpdateProbe(), CHECK_TIMEOUT_MS, "update check timed out");
      if (checkRequestId !== requestId) return;
      const version = probe.latest ?? undefined;
      const stage: UpdateStage = !probe.configured
        ? "unconfigured"
        : !probe.newer
          ? "latest"
          : probe.failed
            ? "failed"
            : probe.autoInstall
              ? "available"
              : "manual";
      set({ stage, version, error: undefined });
    } catch (error) {
      if (checkRequestId !== requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[updater] check failed", message);
      set({ stage: "error", version: undefined, error: message });
    }
  },
}));
