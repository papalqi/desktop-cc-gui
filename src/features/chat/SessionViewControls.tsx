import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/errors";
import { cx } from "@/utils/cx";
import { useChatStore } from "./store";
import { Select, SelectItem } from "@/components/base/select/select";
import { SessionNotificationControl } from "./session-notifications";

export function SessionViewControls() {
  const { t } = useTranslation();
  const scope = useChatStore((state) => state.sessionScope);
  const sort = useChatStore((state) => state.sessionSort);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void action().catch((error) => setError(errorText(error))).finally(() => setBusy(false));
  };
  return <div className="flex flex-col gap-2">
    <div className="flex rounded-lg bg-background-tertiary-default p-0.5" aria-label={t("chat.sessionView")}>
      {(["remote", "all"] as const).map((value) => <button key={value} type="button" disabled={busy}
        aria-pressed={scope === value}
        onClick={() => change(() => useChatStore.getState().setSessionScope(value))}
        className={cx("min-w-0 flex-1 cursor-pointer rounded-md px-2 py-1 text-body-2-medium transition-colors duration-150 disabled:cursor-wait",
          scope === value ? "bg-background-full text-text-primary" : "text-text-tertiary hover:text-text-secondary")}>
        {t(value === "remote" ? "chat.remoteWork" : "chat.allSessions")}
      </button>)}
    </div>
    <Select aria-label={t("chat.sessionSort")} size="sm" selectedKey={sort} isDisabled={busy}
      onSelectionChange={(key) => { if (key === "workspace" || key === "recent") {
        change(() => useChatStore.getState().setSessionSort(key));
      } }}>
      <SelectItem id="workspace">{t("chat.sortByWorkspace")}</SelectItem>
      <SelectItem id="recent">{t("chat.sortByRecent")}</SelectItem>
    </Select>
    <SessionNotificationControl />
    {error && <p role="alert" className="text-caption-1-medium text-text-error-primary">{error}</p>}
  </div>;
}
