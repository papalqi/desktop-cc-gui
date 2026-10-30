import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { getAppVersion, isWeb } from "@/lib/platform";
import { useUpdateStore } from "@/features/update/store";
import { useUpdateDescription } from "@/features/update/stage-message";

/** Update page: app identity + version and the check-for-updates row. */
export function UpdateSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const updateStage = useUpdateStore((s) => s.stage);
  const updateVersion = useUpdateStore((s) => s.version);
  const updateError = useUpdateStore((s) => s.error);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  // Same result line as the release-notes pane. Download/install progress
  // is shown by RelayUpdateNotice.
  const updateDescription = useUpdateDescription({
    stage: updateStage,
    version: updateVersion,
    error: updateError,
  });

  useEffect(() => {
    let cancelled = false;
    getAppVersion()
      .then((v) => {
        if (!cancelled && v) setVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex w-full flex-col gap-6">
      {/* App identity + version */}
      <div className="flex w-full flex-col gap-2">
        <SettingsSectionLabel>{t("settings.checkUpdates")}</SettingsSectionLabel>
        <SettingsCard>
          <SettingsRow anchor="appVersion" label="CC GUI" description={t("settings.aboutDesc")}>
            <span className="text-body-regular text-text-secondary">
              {version ? `v${version}` : "…"}
            </span>
          </SettingsRow>
          <SettingsRow anchor="checkUpdates" label={t("settings.checkUpdates")} description={updateDescription}>
            {isWeb ? (
              <span className="text-body-2-regular text-text-tertiary">{t("settings.checkUpdatesOnDesktop")}</span>
            ) : (
              <Button
                size="small"
                variant="secondary"
                disabled={updateStage === "checking"}
                onClick={() => void checkForUpdates()}
              >
                {t("settings.checkUpdates")}
              </Button>
            )}
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  );
}
