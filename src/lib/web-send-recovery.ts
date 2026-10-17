import i18n from "i18next";
import type { SendResult } from "./ipc";
import { queryMachine } from "./machine-bridge";
import { WebBridgeDisconnectedError, webBridgeFeature } from "./transport";
import { webMachine } from "./web-machine";

/** Hub `get_run_delivery` answer for a run id this page submitted. */
export interface RunDelivery {
  runId: string;
  delivery: "in-flight" | "acknowledged" | "failed" | "indeterminate" | "not-received" | "waiting-executor";
  active: boolean;
  sessionId: string | null;
  terminal: "done" | "error" | null;
}

/** The prompt may be running on the machine; sending it again could run it twice. */
export class SendDeliveryUnknownError extends Error {}

export type DeliveryQuery = (machine: string, runId: string) => Promise<RunDelivery>;
export type DeliveryClose = (machine: string, runId: string) => Promise<RunDelivery>;

const RECOVERY_DEADLINE_MS = 60_000;
/** The hub holds an in-flight answer this long; under the machine-bridge timeout. */
const HUB_WAIT_MS = 4_000;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 5_000;

const queryHub: DeliveryQuery = (machine, runId) =>
  queryMachine(machine, (invoke) => invoke<RunDelivery>("get_run_delivery", { runId, waitMs: HUB_WAIT_MS }));

const closeHub: DeliveryClose = (machine, runId) =>
  queryMachine(machine, (invoke) => invoke<RunDelivery>("close_unreceived_run", { runId }));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A socket lost after the send left this page says nothing about the run. Ask
 * the hub that received it, over a separate socket to that machine, instead of
 * reporting a failure the user would answer by sending the prompt again.
 */
export async function sendWithDeliveryRecovery(
  args: { runId?: string; sessionId: string | null },
  send: () => Promise<SendResult>,
  query: DeliveryQuery = queryHub,
  targetMachine?: string,
  close: DeliveryClose = closeHub,
): Promise<SendResult> {
  const machine = targetMachine ?? webMachine();
  const runId = args.runId;
  const recoverable = Boolean(runId && machine && webBridgeFeature("delivery"));
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof WebBridgeDisconnectedError)) throw error;
    if (!error.sent) throw new Error(i18n.t("chat.sendNotDelivered"));
    if (!recoverable) throw new SendDeliveryUnknownError(i18n.t("chat.sendDeliveryUnknown"));
    const answer = await awaitDelivery(machine!, runId!, query);
    switch (answer?.delivery) {
      case "acknowledged":
        return { runId: runId!, sessionId: answer.sessionId ?? args.sessionId };
      case "not-received":
        return closeUnreceived(machine!, runId!, args.sessionId, close);
      case "failed":
        throw new Error(i18n.t("chat.sendRejected"));
      case "waiting-executor":
        throw new SendDeliveryUnknownError(i18n.t("chat.sendWaitingExecutor"));
      default:
        throw new SendDeliveryUnknownError(i18n.t("chat.sendDeliveryUnknown"));
    }
  }
}

async function closeUnreceived(
  machine: string,
  runId: string,
  sessionId: string | null,
  close: DeliveryClose,
): Promise<SendResult> {
  let closed: RunDelivery;
  try {
    closed = await close(machine, runId);
  } catch {
    throw new SendDeliveryUnknownError(i18n.t("chat.sendDeliveryUnknown"));
  }
  if (closed.delivery === "acknowledged" || closed.delivery === "in-flight") {
    return { runId, sessionId: closed.sessionId ?? sessionId };
  }
  if (closed.delivery === "failed") throw new Error(i18n.t("chat.sendRejected"));
  if (closed.delivery === "not-received") throw new Error(i18n.t("chat.sendNotDelivered"));
  throw new SendDeliveryUnknownError(
    closed.delivery === "waiting-executor" ? i18n.t("chat.sendWaitingExecutor") : i18n.t("chat.sendDeliveryUnknown"),
  );
}

async function awaitDelivery(machine: string, runId: string, query: DeliveryQuery): Promise<RunDelivery | null> {
  const deadline = Date.now() + RECOVERY_DEADLINE_MS;
  let retryMs = RETRY_MIN_MS;
  let last: RunDelivery | null = null;
  while (Date.now() < deadline) {
    try {
      last = await query(machine, runId);
      if (last.delivery !== "in-flight") return last;
      retryMs = RETRY_MIN_MS;
    } catch {
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
    await sleep(Math.min(retryMs, Math.max(0, deadline - Date.now())));
  }
  return last;
}
