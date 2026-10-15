import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { isWeb, webBridgeFeature } from "@/lib/transport";
import { webMultiMachine } from "@/lib/web-machine";
import i18n from "@/lib/i18n";

/**
 * Beta entry points (设置 → 其他 → 内测功能): feature id -> enabled, persisted
 * in AppSettings.betaFeatures. Every flag defaults to off, so a missing key
 * (old settings file, failed fetch) keeps its entry hidden.
 *
 * The store exists because the gate lives on surfaces that are not settings
 * pages (the sidebar and the center tab strip) and has to re-render the moment
 * a switch flips; a plain `getAppSettings()` read cannot notify them.
 */

/** Catalog of beta entries. `labelKey`/`descriptionKey` are i18n keys; ids
 *  are the settings keys. Add an entry here and it shows up on the settings
 *  page automatically. */
export const BETA_FEATURES = [
  {
    id: "newBrowser",
    labelKey: "settings.betaNewBrowser",
    descriptionKey: "settings.betaNewBrowserDesc",
  },
  {
    id: "web.multiMachine",
    labelKey: "settings.betaMultiMachine",
    descriptionKey: "settings.betaMultiMachineDesc",
  },
  // 任务工作台入口：内测暂不放开，设置页开关先隐藏。恢复时取消注释，
  // 并删掉 TEMPORARILY_HIDDEN_BETA_FEATURES 里对应的 id。
  // {
  //   id: "missionWorkbench",
  //   labelKey: "settings.betaMissionWorkbench",
  //   descriptionKey: "settings.betaMissionWorkbenchDesc",
  // },
] as const;

/** 暂时下线的内测入口：设置页不渲染开关，`useBetaFeature` 也恒为 false，
 *  所以侧栏 / 页签入口对所有人隐藏（含设置里已存 true 的老用户）。
 *  store 与设置文件里的值原样保留，从上面的目录里取消注释即可恢复。 */
const TEMPORARILY_HIDDEN_BETA_FEATURES = ["missionWorkbench"] as const;

export type BetaFeatureId =
  | (typeof BETA_FEATURES)[number]["id"]
  | (typeof TEMPORARILY_HIDDEN_BETA_FEATURES)[number];

export const visibleBetaFeatures = BETA_FEATURES.filter((feature) => feature.id !== "web.multiMachine" || isWeb);

interface BetaFeaturesState {
  features: Record<string, boolean>;
  hydrate: (features: Record<string, boolean> | null | undefined) => void;
  setFeature: (id: BetaFeatureId, enabled: boolean) => Promise<void>;
}

export const useBetaFeaturesStore = create<BetaFeaturesState>((set, get) => ({
  features: {},
  hydrate: (features) => set({ features: features ? { ...features } : {} }),
  setFeature: async (id, enabled) => {
    if (id === "web.multiMachine" && enabled && (!isWeb || !webBridgeFeature("multi-machine"))) {
      throw new Error(i18n.t("settings.betaMultiMachineUnavailable"));
    }
    const previous = get().features;
    // Apply in memory first so the entry appears/disappears without a reload;
    // a failed write rolls the switch back instead of faking a saved state.
    set({ features: { ...previous, [id]: enabled } });
    try {
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({
        ...settings,
        betaFeatures: { ...(settings.betaFeatures ?? {}), [id]: enabled },
      });
      if (id === "web.multiMachine" && isWeb && enabled !== webMultiMachine()) {
        window.location.assign(multiMachinePageUrl(enabled));
      }
    } catch (error) {
      set({ features: previous });
      throw error;
    }
  },
}));

export function multiMachinePageUrl(enabled: boolean): string {
  const url = new URL(window.location.href);
  if (enabled) url.searchParams.set("global", "1");
  else url.searchParams.delete("global");
  return url.toString();
}

function isBetaFeatureHidden(id: BetaFeatureId): boolean {
  return (TEMPORARILY_HIDDEN_BETA_FEATURES as readonly string[]).includes(id);
}

/** One beta flag; absent/false = the entry is hidden. 暂时下线的入口恒为 false。 */
export function useBetaFeature(id: BetaFeatureId): boolean {
  const enabled = useBetaFeaturesStore((state) => state.features[id] === true);
  return enabled && !isBetaFeatureHidden(id);
}

/** Load the persisted flags from settings. At startup this shares the
 *  cached settings promise (ipc.ts), so it adds no IPC round-trip. */
export async function hydrateBetaFeatures(): Promise<void> {
  try {
    const settings = await ipc.getAppSettings();
    useBetaFeaturesStore.getState().hydrate(settings.betaFeatures);
    if (settings.betaFeatures?.["web.multiMachine"] === true && isWeb && !webMultiMachine() && webBridgeFeature("multi-machine")) {
      window.location.replace(multiMachinePageUrl(true));
    }
  } catch {
    // Default off: an unreadable settings file never reveals beta entries.
  }
}
