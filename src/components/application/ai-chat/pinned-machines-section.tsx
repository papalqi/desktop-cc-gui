import { useState } from "react";
import { useTranslation } from "react-i18next";
import Pin from "lucide-react/dist/esm/icons/pin";
import {
  catalogSessionRunning,
  collectPinnedRows,
  currentRelayMachine,
  listsFromState,
  patchCachedPin,
  runningKeysFromFlags,
  useMachineCatalogMap,
  type PinnedRow,
} from "@/features/chat/machine-catalog";
import { useWatchedRunningMap, useWatchedSessionActivities } from "@/features/chat/machine-run-watch";
import { queryMachine } from "@/lib/machine-bridge";
import {
  commitSidebarMachine,
  holdSidebar,
  planPinnedOpen,
  readSidebarHold,
  releaseSidebarHold,
  relayMachineNames,
  switchRelayMachine,
  type RelayMachineList,
} from "@/features/chat/relay-machines";
import { cx } from "@/utils/cx";
import { webMultiMachine } from "@/lib/web-machine";
import { useChatStore as multiMachineChatStore, sessionKey as chatSessionKey } from "@/features/chat/store";
import { contextTitle, projectNameForSession, sessionDisplayName } from "@/features/chat/session-display-name";

/** Pinned sessions from every relay desktop, in one list. */
export function PinnedMachinesSection({
  list,
  activeThreadId,
  liveRunningKeys = [],
}: {
  list: RelayMachineList;
  activeThreadId?: string;
  /** Sessions running on the desktop the page socket is attached to. */
  liveRunningKeys?: readonly string[];
}) {
  const { t } = useTranslation();
  const catalogs = useMachineCatalogMap();
  const watched = useWatchedRunningMap();
  const activities = useWatchedSessionActivities();
  const sessions = multiMachineChatStore((state) => state.sessions);
  const workspaces = multiMachineChatStore((state) => state.workspaces);
  const aliases = multiMachineChatStore((state) => state.workspaceAliases);
  const scope = multiMachineChatStore((state) => state.sessionScope);
  const unseen = multiMachineChatStore((state) => state.unseen);
  const visibleMachines = relayMachineNames(list);
  const rows = webMultiMachine()
    ? sessions.filter((session) => session.pinned && session.machine && visibleMachines.includes(session.machine) && (scope === "all" || session.origin === "hub"))
      .map((session) => ({ session, machine: session.machine!, workspaceName: projectNameForSession(session, workspaces, aliases) }))
    : collectPinnedRows(Object.fromEntries(Object.entries(catalogs).filter(([machine]) => visibleMachines.includes(machine))), visibleMachines)
      .filter((row) => scope === "all" || row.session.origin === "hub");
  const [failed, setFailed] = useState<string | null>(null);
  const connected = currentRelayMachine();
  const liveRunning = new Set(liveRunningKeys);
  if (rows.length === 0) return null;
  return (
    <section className="flex w-full flex-col gap-2.5">
      <span className="text-body-2-medium text-text-secondary">{t("chat.pinnedTogether")}</span>
      <ul className="flex w-full flex-col gap-1">
        {rows.map((row) => {
          const sessionKey = `${row.session.engine}/${row.session.sessionId}`;
          const key = `${row.machine}/${sessionKey}`;
          const globalKey = chatSessionKey(row.session.engine, row.session.sessionId, row.session.workspacePath, row.machine);
          const display = sessionDisplayName({
            customTitle: row.session.customTitle,
            title: row.session.title,
            sessionId: row.session.sessionId,
            localName: row.workspaceName,
          });
          const title = display.nestedLabel;
          const place = [row.machine, row.workspaceName && row.workspaceName !== title ? row.workspaceName : ""].filter(Boolean).join(" · ");
          const fullName = contextTitle({ machine: row.machine, localName: row.workspaceName, headline: title });
          const heard = watched[row.machine];
          const activity = activities[row.machine]?.[sessionKey]?.state;
          const liveHere = webMultiMachine() ? liveRunning.has(globalKey) : row.machine === connected && liveRunning.has(sessionKey);
          const running =
            heard != null
              ? heard.includes(sessionKey) || liveHere
              : row.machine === connected
                ? liveHere
                : catalogSessionRunning(
                    catalogs[row.machine]?.runningKeys,
                    row.session.engine,
                    row.session.sessionId,
                  );
          const openHere = webMultiMachine() ? activeThreadId === globalKey : row.machine === connected && activeThreadId === sessionKey;
          return (
            <li key={key}>
              <div
                className={cx(
                  "flex w-full items-start gap-2 rounded-2lg p-2 text-left",
                  "hover:bg-background-secondary-hover",
                  openHere && "bg-background-secondary-hover",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer flex-col items-stretch gap-0.5 text-left"
                  title={failed === key ? t("chat.myMachinesSwitchFailed", { name: row.machine }) : fullName}
                  aria-current={openHere ? "page" : undefined}
                  onClick={() => {
                    setFailed(null);
                    void openPinned(list, row).then((ok) => {
                      if (!ok) setFailed(key);
                    });
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Pin className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">
                      {title}
                      {row.session.metadataSyncPending && <span role="status" className="ml-1 text-caption-2-medium text-text-tertiary">{t(row.session.metadataSyncError ? "chat.metadataSyncFailed" : "chat.metadataSyncPending")}</span>}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-caption-1-medium text-text-tertiary">
                      {running && (
                        <span
                          className="sidebar-thread-status sidebar-thread-status-processing"
                          aria-hidden
                        />
                      )}
                      {activity === "awaiting-approval" ? t("chat.sessionAwaitingApproval") : activity === "awaiting-input" ? t("chat.sessionAwaitingInput")
                        : running ? t("chat.sessionRunning") : unseen[webMultiMachine() ? globalKey : sessionKey] ? t("chat.sessionUnseen") : t("chat.sessionStopped")}
                    </span>
                  </span>
                  {place ? (
                    <span className="truncate pl-6 text-caption-1-medium text-text-tertiary">{place}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer text-caption-1-medium text-text-tertiary hover:text-text-secondary"
                  aria-label={t("chat.unpin")}
                  onClick={() => {
                    void unpinPinned(row);
                  }}
                >
                  {t("chat.unpin")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

async function openPinned(list: RelayMachineList, row: PinnedRow): Promise<boolean> {
  if (webMultiMachine()) {
    await multiMachineChatStore.getState().selectSession(row.session.engine, row.session.sessionId, row.session.workspacePath, row.machine);
    return true;
  }
  const held = readSidebarHold();
  const displayed = held?.machine ?? list.current;
  const plan = planPinnedOpen(displayed, currentRelayMachine(), row.machine);
  const { useChatStore } = await import("@/features/chat/store");
  const open = () =>
    useChatStore
      .getState()
      .selectSession(row.session.engine, row.session.sessionId, row.session.workspacePath);
  if (plan === "select") {
    if (held) commitSidebarMachine(row.machine);
    await open();
    return true;
  }
  if (plan === "return") {
    const ok = await switchRelayMachine(row.machine, { keepSidebar: true });
    if (!ok) return false;
    commitSidebarMachine(row.machine);
    await open();
    return true;
  }
  const createdHold = !held;
  if (createdHold) {
    const state = useChatStore.getState();
    holdSidebar(
      displayed,
      listsFromState({
        workspaces: state.workspaces,
        sessions: state.sessions,
        workspaceGroups: state.workspaceGroups,
        workspaceAliases: state.workspaceAliases,
        archivedWorkspaces: state.archivedWorkspaces,
        threadLimit: state.threadLimit,
        runningKeys: runningKeysFromFlags(state.streamingByKey),
      }),
    );
  }
  const ok = await switchRelayMachine(row.machine, { keepSidebar: true });
  if (!ok) {
    if (createdHold) releaseSidebarHold();
    return false;
  }
  await open();
  return true;
}

async function unpinPinned(row: PinnedRow): Promise<void> {
  const { engine, sessionId } = row.session;
  if (webMultiMachine()) {
    await multiMachineChatStore.getState().pinSession(engine, sessionId, false, row.machine);
    return;
  }
  if (row.machine === currentRelayMachine()) {
    const { useChatStore } = await import("@/features/chat/store");
    await useChatStore.getState().pinSession(engine, sessionId, false);
    return;
  }
  try {
    await queryMachine(row.machine, (invoke) =>
      invoke<void>("pin_session", { engine, sessionId, pinned: false }),
    );
    patchCachedPin(row.machine, engine, sessionId, false);
  } catch {
    // The row stays pinned. The next catalog read will match the desktop.
  }
}
