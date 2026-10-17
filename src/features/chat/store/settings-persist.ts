import { ipc, type AppSettings } from "@/lib/ipc";
import { errorText } from "@/lib/errors";

/** Persist one app-settings patch. A failure throws so the caller can revert
 * the optimistic value instead of leaving a write that never landed. */
export async function persistSettings(
  patch: (settings: AppSettings) => Partial<AppSettings>,
) {
  const settings = await ipc.getAppSettings();
  await ipc.updateAppSettings({ ...settings, ...patch(settings) });
}

/** Apply already happened. On failure, restore the previous memory value and
 * surface it through the chat error bar. */
export async function commitPersisted(
  set: (partial: { actionError: string | null }) => void,
  revert: () => void,
  patch: (settings: AppSettings) => Partial<AppSettings>,
): Promise<void> {
  try {
    await persistSettings(patch);
    set({ actionError: null });
  } catch (error) {
    revert();
    const message = errorText(error);
    set({ actionError: message });
    throw new Error(message);
  }
}
