import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { isWeb, listen, subscribeWebBridgeState, webBridgeFeature } from "@/lib/transport";
import { webMachine, webMultiMachine } from "@/lib/web-machine";
import { errorText } from "@/lib/errors";
import { useChatStore, sessionKey } from "./store";
import { pageTitle, projectNameForSession } from "./session-display-name";
import { switchRelayMachine } from "./relay-machines";
import { dismissCenterSurfaces } from "./center-surfaces";

type Notice = {
  id: string;
  machine: string;
  engine: string;
  sessionId: string | null;
  workspacePath: string;
  state: "done" | "error" | "awaiting-input" | "awaiting-approval";
};
const LABELS = { done: "chat.notificationDone", error: "chat.notificationError", "awaiting-input": "chat.sessionAwaitingInput", "awaiting-approval": "chat.sessionAwaitingApproval" } as const;
const ENABLED_KEY = "ccgui-next.browserNotifications:v1";
const enabled = () => { try { return localStorage.getItem(ENABLED_KEY) === "true"; } catch { return false; } };
const supported = () => isWeb && "Notification" in window && window.isSecureContext !== false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const changed = () => { for (const listener of listeners) listener(); };

export function SessionNotificationControl() {
  const { t } = useTranslation();
  const available = useSyncExternalStore(subscribeWebBridgeState, () => webBridgeFeature("notifications"), () => false);
  const active = useSyncExternalStore(subscribe, enabled, () => false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported() || !available) return null;
  return <div className="flex flex-col gap-1">
    <button type="button" disabled={busy} aria-pressed={active}
      className="cursor-pointer rounded-md px-2 py-1 text-left text-caption-1-medium text-text-secondary hover:bg-background-secondary-hover disabled:cursor-wait"
      onClick={() => {
        setBusy(true);
        setError(null);
        // Permission is requested in the click handler, never during page startup.
        const permission = active ? Promise.resolve(Notification.permission) : Notification.requestPermission();
        void permission.then((value) => {
          if (!active && value !== "granted") { setError(t("chat.notificationsDenied")); return; }
          localStorage.setItem(ENABLED_KEY, String(!active));
          changed();
        }).catch((error) => setError(errorText(error))).finally(() => setBusy(false));
      }}>
      {t(active ? "chat.disableNotifications" : "chat.enableNotifications")}
    </button>
    {error && <p role="alert" className="text-caption-1-medium text-text-error-primary">{error}</p>}
  </div>;
}

export function useSessionNotifications() {
  const { t } = useTranslation();
  const unseen = useChatStore((state) => state.unseen);
  const active = useChatStore((state) => state.active);
  const sessions = useChatStore((state) => state.sessions);
  const workspaces = useChatStore((state) => state.workspaces);
  const aliases = useChatStore((state) => state.workspaceAliases);
  const unread = Object.values(unseen).filter(Boolean).length;
  const current = active
    ? (sessions ?? []).find((item) => item.engine === active.engine && item.sessionId === active.sessionId && item.workspacePath === active.workspacePath && (item.machine ?? "") === (active.machine ?? ""))
    : undefined;
  const title = active
    ? pageTitle({
        machine: active.machine,
        localName: projectNameForSession(active, workspaces ?? [], aliases ?? {}),
        customTitle: current?.customTitle,
        title: current?.title,
        sessionId: active.sessionId,
        fallback: active.sessionId ? undefined : t("chat.newChat"),
      })
    : "CC GUI";
  useEffect(() => {
    if (!isWeb) return;
    const base = document.title;
    return () => { document.title = base.replace(/^\(\d+\) /, ""); };
  }, []);
  useEffect(() => {
    if (isWeb) document.title = `${unread ? `(${unread}) ` : ""}${title}`;
  }, [unread, title]);
  useEffect(() => {
    if (isWeb) return;
    let cancelled = false;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (!cancelled) return getCurrentWindow().setTitle(title);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [title]);

  useEffect(() => {
    if (!isWeb) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const notices = new Set<Notification>();
    const seen = new Set<string>();
    void listen<Notice>("notifications://session", ({ payload: item }) => {
      if (disposed || !item || !LABELS[item.state] || typeof item.machine !== "string" || typeof item.engine !== "string" || typeof item.id !== "string" || seen.has(item.id)) return;
      seen.add(item.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
      const state = useChatStore.getState();
      const machine = webMultiMachine() ? item.machine : undefined;
      const key = item.sessionId ? sessionKey(item.engine, item.sessionId, item.workspacePath, machine) : null;
      const sameMachine = webMultiMachine() || webMachine() === item.machine;
      const reading = sameMachine && !document.hidden && document.hasFocus() && state.active && key === sessionKey(state.active.engine, state.active.sessionId, state.active.workspacePath, state.active.machine);
      if (sameMachine && key && !reading) useChatStore.setState({ unseen: { ...state.unseen, [key]: true } });
      if (!supported() || !enabled() || Notification.permission !== "granted" || reading) return;
      try {
        const known = (state.sessions ?? []).find((row) => row.engine === item.engine && row.sessionId === item.sessionId && row.workspacePath === item.workspacePath && (row.machine ?? "") === item.machine);
        const project = projectNameForSession(item, state.workspaces ?? [], state.workspaceAliases ?? {});
        const notice = new Notification(t(LABELS[item.state]), { body: [item.machine, item.engine, known?.customTitle?.trim() || project || item.sessionId?.slice(0, 8)].filter(Boolean).join(" · "), tag: `${item.machine}/${item.engine}/${item.sessionId ?? item.id}` });
        notices.add(notice);
        notice.onclose = () => notices.delete(notice);
        notice.onclick = () => {
          notice.close();
          window.focus();
          if (!item.sessionId || !item.workspacePath) return;
          void (async () => {
            if (!webMultiMachine() && webMachine() !== item.machine && !await switchRelayMachine(item.machine)) return;
            dismissCenterSurfaces();
            await useChatStore.getState().selectSession(item.engine, item.sessionId!, item.workspacePath, machine);
          })().catch((error) => useChatStore.setState({ actionError: errorText(error) }));
        };
      } catch {
        // Browsers without desktop Notification support retain unread/title feedback.
      }
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch((error) => {
      if (!disposed) useChatStore.setState({ actionError: errorText(error) });
    });
    const onPreference = () => { if (!enabled()) { for (const notice of notices) notice.close(); notices.clear(); } };
    const offPreference = subscribe(onPreference);
    window.addEventListener("storage", onPreference);
    return () => {
      disposed = true;
      stop?.();
      offPreference();
      window.removeEventListener("storage", onPreference);
      for (const notice of notices) notice.close();
      notices.clear();
    };
  }, [t]);
}
