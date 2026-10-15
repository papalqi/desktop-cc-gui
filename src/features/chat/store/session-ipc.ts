import { ipc, ipcForMachine } from "@/lib/ipc";
import { parseDraftSessionKey, parseSessionKey } from "./persistence";

/** Replies and background work keep the machine encoded in their owning key. */
export function sessionIpc(key: string): typeof ipc {
  const machine = (parseDraftSessionKey(key) ?? parseSessionKey(key))?.machine;
  return machine ? ipcForMachine(machine) : ipc;
}
