import { ipc, ipcForMachine } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";
import {
  PERMISSION_PREF_KEY,
  sessionKey,
  type ActiveSession,
} from "./persistence";
import { patchSession } from "./stream";
import { notifyCliConfigChanged } from "@/features/settings/providers";
import { commitPersisted } from "./settings-persist";
import type { ChatStore } from "./types";
import type { StoreGet, StoreSet } from "./context";

/**
 * Preference actions: composer permission, service tiers, per-engine
 * model/effort/provider picks, and the small settings-backed toggles
 * (thread limit, send shortcut, thinking auto-collapse).
 */

export interface PreferenceDeps {
  set: StoreSet;
  get: StoreGet;
  stampActiveTab: (patch: Partial<ActiveSession>) => void;
}

export function createPreferenceActions(
  deps: PreferenceDeps,
): Pick<
  ChatStore,
  | "setPermission"
  | "setOmpServiceTier"
  | "setCodexServiceTier"
  | "setEffort"
  | "setModel"
  | "setProvider"
  | "pinModels"
  | "setThreadLimit"
  | "setSendShortcut"
  | "setThinkingAutoCollapse"
> {
  const { set, get, stampActiveTab } = deps;

  return {
    setPermission: (permission) => {
      writeStored(PERMISSION_PREF_KEY, permission);
      set({ permission });
    },
    setOmpServiceTier: async (tier) => {
      const machine = get().active?.machine;
      const client = machine ? ipcForMachine(machine) : ipc;
      const settings = await client.getAppSettings();
      await client.updateAppSettings({ ...settings, ompOpenaiServiceTier: tier });
      if (machine) set((state) => ({ serviceTiersByMachine: { ...state.serviceTiersByMachine,
        [machine]: { omp: tier, codex: state.serviceTiersByMachine[machine]?.codex ?? null } } }));
      else set({ ompServiceTier: tier });
    },
    setCodexServiceTier: async (tier) => {
      const machine = get().active?.machine;
      const client = machine ? ipcForMachine(machine) : ipc;
      const settings = await client.getAppSettings();
      await client.updateAppSettings({ ...settings, codexServiceTier: tier });
      if (machine) set((state) => ({ serviceTiersByMachine: { ...state.serviceTiersByMachine,
        [machine]: { omp: state.serviceTiersByMachine[machine]?.omp ?? null, codex: tier } } }));
      else set({ codexServiceTier: tier });
    },
    setEffort: async (engine, effort) => {
      const active = get().active;
      if (active?.engine === engine && active.sessionId) {
        const key = sessionKey(engine, active.sessionId, active.workspacePath, active.machine);
        patchSession(set, key, { activeEffort: effort });
        const client = active.machine ? ipcForMachine(active.machine) : ipc;
        void client.rememberSessionEffort(engine, active.sessionId, effort).catch(() => {});
        return;
      }
      const previousEfforts = get().efforts;
      const previousEffort = active?.effort;
      set({ efforts: { ...previousEfforts, [engine]: effort } });
      if (active?.engine === engine) stampActiveTab({ effort });
      try {
        await commitPersisted(set, () => {
          set({ efforts: previousEfforts });
          if (active?.engine === engine) stampActiveTab({ effort: previousEffort });
        }, (settings) => ({
          defaultEfforts: { ...settings.defaultEfforts, [engine]: effort },
        }));
      } catch {
        // The error bar already shows the failure. The composer does not await this.
      }
    },
    setModel: async (engine, model) => {
      const active = get().active;
      // Model choice is a property of the CONVERSATION: picking one inside a
      // session must not rewrite the engine-wide default, or a second session
      // of the same CLI would silently switch models with it. Only a pending
      // "new chat" tab (no session yet) edits the default — that tab is where
      // the next conversation's starting choice is made.
      if (!active || active.sessionId === null) {
        const previousModels = get().models;
        const models = { ...previousModels };
        if (model) models[engine] = model;
        else delete models[engine];
        set({ models });
        try {
          await commitPersisted(set, () => set({ models: previousModels }), (settings) => {
            const defaultModels = { ...settings.defaultModels };
            if (model) defaultModels[engine] = model;
            else delete defaultModels[engine];
            return { defaultModels };
          });
        } catch {
          // Shown on the chat error bar. Do not stamp a default the write rejected.
          return;
        }
      }
      if (get().active === active && active?.engine === engine) {
        // Empty = "CLI default": clear the tab override so the session falls
        // back to its own history/model default again.
        stampActiveTab({ model: model || undefined });
      }
    },
    setProvider: async (engine, providerId) => {
      const active = get().active;
      const client = active?.machine ? ipcForMachine(active.machine) : ipc;
      try {
        if (active?.engine === engine && active.sessionId) {
          await client.rememberSessionProvider(engine, active.sessionId, providerId);
          const key = sessionKey(engine, active.sessionId, active.workspacePath, active.machine);
          patchSession(set, key, { activeProvider: providerId });
          if (get().active === active) stampActiveTab({ provider: undefined });
        } else {
          await client.setCurrentProvider(engine, providerId);
          if (active?.machine) {
            const machine = active.machine;
            set((state) => ({ providersByMachine:{ ...state.providersByMachine,[machine]:{ ...state.providersByMachine[machine],[engine]:providerId } } }));
          } else set({ providers: { ...get().providers, [engine]: providerId } });
          if (get().active === active && active?.engine === engine) {
            stampActiveTab({ provider: providerId || undefined });
          }
          notifyCliConfigChanged();
        }
        set({ actionError: null });
      } catch (error) {
        // Migration conflicts and failed writes must not leave a checkmark
        // on a channel the backend never accepted.
        set({ actionError: errorText(error) });
      }
    },
    pinModels: async (updates, persist = true) => {
      const entries = Object.entries(updates).filter(([, model]) =>
        model.trim(),
      );
      if (entries.length === 0) return;
      const previousModels = get().models;
      const models = { ...previousModels };
      for (const [engine, model] of entries) models[engine] = model;
      set({ models });
      if (!persist) return;
      try {
        await commitPersisted(set, () => set({ models: previousModels }), (settings) => ({
          defaultModels: {
            ...settings.defaultModels,
            ...Object.fromEntries(entries),
          },
        }));
      } catch {
        // Shown on the chat error bar.
      }
    },

    setThreadLimit: (limit) => {
      set({ threadLimit: Math.max(1, Math.floor(limit)) });
    },

    setSendShortcut: (shortcut) => {
      set({ sendShortcut: shortcut });
    },
    setThinkingAutoCollapse: (autoCollapse) => {
      set({ thinkingAutoCollapse: autoCollapse });
    },
  };
}
