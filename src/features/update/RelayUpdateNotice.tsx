import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc, type RelayUpdateInfo } from "@/lib/ipc";
import { isWeb, listen } from "@/lib/transport";
import { Button } from "@/components/base/buttons/button";

const timeValue = (minute: number | null) => minute == null ? "" : `${Math.floor(minute / 60).toString().padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`;
const minuteValue = (time: string) => time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null;

export function RelayUpdateNotice() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<RelayUpdateInfo | null>(null);
  const [error, setError] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  useEffect(() => {
    if (isWeb) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let eventReceived = false;
    const receive = (value: RelayUpdateInfo) => {
      if (disposed) return;
      setInfo(value);
    };
    const subscription = listen<RelayUpdateInfo>("relay-update://status", (event) => { eventReceived = true; receive(event.payload); });
    void subscription.then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => {});
    void ipc.relayUpdateStatus().then((value) => { if (!eventReceived) receive(value); }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => { setStart(timeValue(info?.blackoutStart ?? null)); setEnd(timeValue(info?.blackoutEnd ?? null)); }, [info?.blackoutStart, info?.blackoutEnd]);
  if (!info?.version || !["downloading", "waiting-idle", "installing", "checking", "failed"].includes(info.phase)) return null;
  const waiting = info.phase === "waiting-idle";
  return <aside role="status" className="fixed bottom-4 left-4 z-105 flex w-80 flex-col gap-3 rounded-2xl border border-separator-border bg-background-primary-default p-4 shadow-xl">
    <p className="text-body-medium text-text-primary">{t(`settings.relayUpdate${info.phase === "failed" ? "Failed" : info.phase === "downloading" ? "Downloading" : waiting ? "Idle" : "Installing"}`, { version: info.version })}</p>
    {waiting && <>
      <p className="text-body-small text-text-secondary">{t("settings.relayUpdateBlackout")}</p>
      <div className="flex items-center gap-2">
        <input type="time" aria-label={t("settings.relayUpdateBlackoutStart")} value={start} onChange={(event) => setStart(event.target.value)} className="w-24" />
        <input type="time" aria-label={t("settings.relayUpdateBlackoutEnd")} value={end} onChange={(event) => setEnd(event.target.value)} className="w-24" />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="small" variant="secondary" onClick={() => { void ipc.relayUpdateBlackout(minuteValue(start), minuteValue(end)).then(setInfo).catch(() => setError(true)); }}>{t("settings.relayUpdateSaveBlackout")}</Button>
        <Button size="small" variant="secondary" onClick={() => { void ipc.relayUpdateDefer().then(setInfo).catch(() => setError(true)); }}>{t("settings.relayUpdateDefer")}</Button>
      </div>
      {info.deferredUntil > Date.now() && <p className="text-body-small text-text-secondary">{t("settings.relayUpdateDeferred", { time:new Date(info.deferredUntil).toLocaleTimeString() })}</p>}
    </>}
    {error && <p role="alert" className="text-body-small text-text-secondary">{t("settings.relayUpdateActionFailed")}</p>}
  </aside>;
}
