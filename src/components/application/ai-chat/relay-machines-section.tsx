import { useState } from "react";
import { useTranslation } from "react-i18next";
import Monitor from "lucide-react/dist/esm/icons/monitor";
import Settings2 from "lucide-react/dist/esm/icons/settings-2";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import { Button } from "@/components/base/buttons/button";
import { ConfirmDialog, ModalShell } from "@/components/dialogs";
import { currentRelayMachine } from "@/features/chat/machine-catalog";
import {
  commitSidebarMachine,
  machineRowIsButton,
  manageRelayMachines,
  readSidebarHold,
  relayMachineRows,
  switchRelayMachine,
  useSidebarHold,
  type RelayMachineList,
  type RelayMachinePolicy,
} from "@/features/chat/relay-machines";
import { cx } from "@/utils/cx";

/** Relay browser only. Choosing a machine swaps the
 *  connection in place; the document does not reload. */
export function RelayMachinesSection({ list }: { list: RelayMachineList }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [retiring, setRetiring] = useState<RelayMachinePolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [policyFailed, setPolicyFailed] = useState(false);
  const hold = useSidebarHold();
  const socket = currentRelayMachine();
  const rows = relayMachineRows(list);
  const save = async (action: Parameters<typeof manageRelayMachines>[0]) => {
    if (saving) return;
    setSaving(true); setPolicyFailed(false);
    try { await manageRelayMachines(action); }
    catch { setPolicyFailed(true); }
    finally { setSaving(false); }
  };
  return (
    <section data-ccgui-relay-machines="" className="flex w-full flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-body-2-medium text-text-secondary">{t("chat.myMachines")}</span>
        {list.machines && <Button variant="ghost" size="xs" iconOnly leadingIcon={Settings2}
          aria-label={t("chat.manageMachines")} title={t("chat.manageMachines")} onClick={() => setManaging(true)} />}
      </div>
      {rows.length === 0 && <p className="text-caption-1-medium text-text-tertiary">{t("chat.myMachinesEmpty")}</p>}
      <ul className="flex w-full flex-col gap-1">
        {rows.map((row) => {
          const available = row.online || Boolean(list.knownNames?.includes(row.name));
          const className = cx(
            "flex w-full items-center gap-2 rounded-2lg p-2 text-left transition-colors duration-150 ease",
            row.current && "bg-background-secondary-hover",
            !row.current && available && "hover:bg-background-secondary-hover",
            !row.online && "opacity-50",
          );
          const body = (
            <>
              <Monitor className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">
                {row.name}
              </span>
              {row.current && (
                <span className="shrink-0 text-caption-1-medium text-text-tertiary">
                  {t("chat.myMachinesCurrent")}
                </span>
              )}
              {!row.online && (
                <span className="shrink-0 text-caption-1-medium text-text-tertiary">
                  {t("chat.myMachinesOffline")}
                </span>
              )}
            </>
          );
          const opens = machineRowIsButton(
            available,
            row.current,
            row.name,
            hold?.machine ?? null,
            socket,
          );
          if (!opens) {
            return (
              <li key={row.name}>
                <div
                  className={className}
                  aria-current={row.current ? "page" : undefined}
                  title={row.online ? undefined : t("chat.myMachinesOfflineHint", { name: row.name })}
                >
                  {body}
                </div>
              </li>
            );
          }
          return (
            <li key={row.name}>
              <button
                type="button"
                className={cx(className, "cursor-pointer")}
                title={
                  failed === row.name
                    ? t("chat.myMachinesSwitchFailed", { name: row.name })
                    : !row.online
                      ? t("chat.myMachinesOfflineHistoryHint", { name: row.name })
                      : t("chat.myMachinesSwitch", { name: row.name })
                }
                onClick={() => {
                  setFailed(null);
                  const held = readSidebarHold();
                  if (!held) {
                    void switchRelayMachine(row.name).then((ok) => {
                      if (!ok) setFailed(row.name);
                    });
                    return;
                  }
                  void switchRelayMachine(row.name, { keepSidebar: true }).then((ok) => {
                    if (!ok) {
                      setFailed(row.name);
                      return;
                    }
                    commitSidebarMachine(row.name);
                  });
                }}
              >
                {body}
              </button>
            </li>
          );
        })}
      </ul>
      {managing && !retiring && <ModalShell label={t("chat.manageMachines")} onClose={() => setManaging(false)} className="w-112 max-w-[calc(100vw-2rem)]">
        <h2 className="mb-3 text-body-medium text-text-primary">{t("chat.manageMachines")}</h2>
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {(list.machines ?? []).map((machine, index, machines) => <div key={machine.name} className="flex items-center gap-1" data-machine-policy={machine.name}>
            <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">{machine.name}
              {machine.retired ? ` · ${t("chat.machineRetired")}` : machine.hidden ? ` · ${t("chat.machineHidden")}` : ""}</span>
            <Button variant="ghost" size="xs" iconOnly leadingIcon={ArrowUp} disabled={saving || index === 0}
              aria-label={t("chat.machineMoveUp", { name: machine.name })} onClick={() => {
                const names = machines.map((row) => row.name); [names[index - 1], names[index]] = [names[index], names[index - 1]];
                void save({ names });
              }} />
            <Button variant="ghost" size="xs" iconOnly leadingIcon={ArrowDown} disabled={saving || index === machines.length - 1}
              aria-label={t("chat.machineMoveDown", { name: machine.name })} onClick={() => {
                const names = machines.map((row) => row.name); [names[index + 1], names[index]] = [names[index], names[index + 1]];
                void save({ names });
              }} />
            {!machine.retired && <Button variant="ghost" size="xs" disabled={saving} onClick={() => { void save({ name: machine.name, hidden: !machine.hidden }); }}>
              {t(machine.hidden ? "chat.machineShow" : "chat.machineHide")}</Button>}
            {machine.machineId && !machine.retired && <Button variant="ghost" size="xs" disabled={saving} onClick={() => setRetiring(machine)}>{t("chat.machineRetire")}</Button>}
          </div>)}
        </div>
        {saving && <p role="status" className="mt-2 text-caption-1-medium text-text-tertiary">{t("chat.machinePolicySaving")}</p>}
        {policyFailed && <p role="alert" className="mt-2 text-body-2-medium text-text-primary">{t("chat.machinePolicyFailed")}</p>}
        <div className="mt-4 flex justify-end"><Button variant="secondary" size="small" onClick={() => setManaging(false)}>{t("common.close")}</Button></div>
      </ModalShell>}
      {retiring && <ConfirmDialog danger message={t("chat.machineRetireConfirm", { name: retiring.name })} confirmLabel={t("chat.machineRetire")}
        onCancel={() => setRetiring(null)} onConfirm={() => { const machineId = retiring.machineId; setRetiring(null); if (machineId) void save({ machineId, action: "retire" }); }} />}
    </section>
  );
}
