import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebBridgeState } from "@/lib/transport";

const bridge = vi.hoisted(() => {
  let state: WebBridgeState = "open";
  const listeners = new Set<() => void>();
  return {
    set(next: WebBridgeState) {
      state = next;
      for (const listener of listeners) listener();
    },
    webBridgeState: () => state,
    subscribeWebBridgeState: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@/lib/transport", () => ({
  webBridgeState: bridge.webBridgeState,
  subscribeWebBridgeState: bridge.subscribeWebBridgeState,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers();
  bridge.set("open");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const { BridgeStatusBanner } = await import("./BridgeStatusBanner");
  act(() => root.render(<BridgeStatusBanner />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("stays hidden through a short blip and shows a lasting outage", () => {
  expect(container.textContent).toBe("");
  act(() => bridge.set("reconnecting"));
  act(() => vi.advanceTimersByTime(1_500));
  act(() => bridge.set("open"));
  act(() => vi.advanceTimersByTime(5_000));
  expect(container.textContent).toBe("");

  act(() => bridge.set("reconnecting"));
  act(() => vi.advanceTimersByTime(2_000));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("chat.bridgeReconnecting");
  act(() => bridge.set("open"));
  expect(container.textContent).toBe("");
});

it("names a first connection separately from a lost one", () => {
  act(() => bridge.set("connecting"));
  act(() => vi.advanceTimersByTime(2_000));
  expect(container.textContent).toBe("chat.bridgeConnecting");
});
