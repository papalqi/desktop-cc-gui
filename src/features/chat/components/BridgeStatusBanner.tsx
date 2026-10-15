import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { subscribeWebBridgeState, webBridgeState } from "@/lib/transport";
import { cx } from "@/utils/cx";

/** A switch or a brief blip settles before this; only a lasting outage shows. */
export const BRIDGE_BANNER_DELAY_MS = 2_000;

export function BridgeStatusBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeWebBridgeState, webBridgeState, () => "open" as const);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (state === "open") return;
    const timer = window.setTimeout(() => setShown(true), BRIDGE_BANNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (!shown || state === "open") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "flex min-w-0 shrink-0 items-center gap-2 rounded-lg border border-border-button-default bg-background-secondary-default px-3 py-2 text-body-regular text-text-primary",
        className,
      )}
    >
      <Loader2
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-foreground-icon-secondary motion-reduce:animate-none"
      />
      <span className="min-w-0">{t(state === "reconnecting" ? "chat.bridgeReconnecting" : "chat.bridgeConnecting")}</span>
    </div>
  );
}
