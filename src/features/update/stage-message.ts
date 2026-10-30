import { useTranslation } from "react-i18next";
import type { UpdateStage } from "./store";

interface UpdateDescriptionInput {
  stage: UpdateStage;
  /** Hub release version from the last check. */
  version?: string;
  error?: string;
}

/**
 * One-line result of the last "check for updates", shared by the settings
 * update row and the release-notes pane so both report the same thing.
 */
export function useUpdateDescription({ stage, version, error }: UpdateDescriptionInput): string | undefined {
  const { t } = useTranslation();
  switch (stage) {
    case "checking":
      return t("settings.updateChecking");
    case "latest":
      return version ? t("settings.updateLatestDetail", { version }) : t("settings.updateLatest");
    case "available":
      return t("settings.updateAvailable", { version });
    case "manual":
      return t("settings.updateAvailableManual", { version });
    case "failed":
      return t("settings.relayUpdateFailed", { version });
    case "unconfigured":
      return t("settings.updateUnconfigured");
    case "error":
      return t("settings.updateError", { message: error });
    default:
      return undefined;
  }
}
