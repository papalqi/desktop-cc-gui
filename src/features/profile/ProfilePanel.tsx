import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { currentRelayMachine } from "@/features/chat/machine-catalog";
import { RELAY_MACHINE_EVENT } from "@/features/chat/relay-machines";
import { isWeb } from "@/lib/transport";
import { webPublicPrefix } from "@/lib/web-public-prefix";

/** Relay path of one machine's profile reader (the hub's profile-relay
 *  module proxies it, GET/HEAD only). */
export function profileReaderUrl(pathname: string, machine: string): string {
  return `${webPublicPrefix(pathname)}/profile/${encodeURIComponent(machine)}/`;
}

function Hint({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-caption-1-regular text-text-tertiary">
      {text}
    </div>
  );
}

/**
 * Right-panel tab showing the selected relay machine's profile reader
 * (its local 8765 site). Only the relay serves `/profile/`, so the desktop
 * webview and LAN direct mode just explain where to look instead.
 * The iframe mounts only while the tab is visible: the reader polls for
 * live reloads, and an off-screen copy must not keep that traffic going.
 */
export function ProfilePanel({ visible = true }: { visible?: boolean }) {
  const { t } = useTranslation();
  const [machine, setMachine] = useState(currentRelayMachine);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useActionFeedback({ spin: true });

  useEffect(() => {
    const sync = () => setMachine(currentRelayMachine());
    window.addEventListener(RELAY_MACHINE_EVENT, sync);
    return () => window.removeEventListener(RELAY_MACHINE_EVENT, sync);
  }, []);
  // A switch that keeps the sidebar sets the cookie without the event;
  // re-read whenever the tab comes back into view.
  useEffect(() => {
    if (visible) setMachine(currentRelayMachine());
  }, [visible]);

  if (!isWeb) return <Hint text={t("profile.desktopHint")} />;
  if (!machine) return <Hint text={t("profile.noMachine")} />;

  const url = profileReaderUrl(window.location.pathname, machine);
  const handleReload = () => {
    void reload.start(() => {
      setReloadKey((key) => key + 1);
      return Promise.resolve();
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-separator-border px-3">
        <span className="truncate text-caption-1-regular text-text-secondary">
          {t("profile.machine", { machine })}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleReload}
          disabled={reload.feedback === "running"}
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
          className="flex h-6 shrink-0 items-center justify-center rounded-lg border border-border-button-default px-2 text-text-tertiary transition-colors duration-150 ease hover:text-text-primary"
        >
          <ActionFeedbackIcon icon={RefreshCw} feedback={reload.feedback} spin iconClassName="size-3.5" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={t("profile.openTab")}
          title={t("profile.openTab")}
          className="flex h-6 shrink-0 items-center justify-center rounded-lg border border-border-button-default px-2 text-text-tertiary transition-colors duration-150 ease hover:text-text-primary"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      {visible && (
        <iframe
          key={`${machine}:${reloadKey}`}
          src={url}
          title={t("profile.frameTitle", { machine })}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
