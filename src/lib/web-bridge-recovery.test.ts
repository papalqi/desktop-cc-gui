import { describe, expect, it } from "vitest";
import { bridgeRecovery, relayDesktopUp } from "./web-bridge-recovery";

const APP = '<div id="root"></div>';
const LOGIN = "<h1>中转登录</h1>";
const PAIRING = "<h1>输入配对密钥</h1>";

describe("bridgeRecovery", () => {
  it("reloads when the relay forgot the browser login", () => {
    expect(bridgeRecovery('{"ok":true}', null)).toBe("reload");
  });

  it("retries while the desktop agent is down and the session is still valid", () => {
    expect(bridgeRecovery('{"ok":true,"agent":false,"agents":[]}', null)).toBe("retry");
    expect(relayDesktopUp('{"ok":true,"agent":false}')).toBe(false);
  });

  it("reloads into a pairing page when hello never arrived", () => {
    expect(bridgeRecovery('{"ok":true,"agent":true,"agents":[{"name":"PC5"}]}', PAIRING)).toBe(
      "reload",
    );
  });

  it("retries when the document is still the app", () => {
    expect(bridgeRecovery('{"ok":true,"agent":true}', APP)).toBe("retry");
    expect(relayDesktopUp('{"ok":true,"agent":true}')).toBe(true);
  });

  it("retries when /health is the LAN app shell rather than relay JSON", () => {
    expect(bridgeRecovery(APP, null)).toBe("retry");
    expect(relayDesktopUp(APP)).toBe(false);
  });

  it("reloads a non-app document and ignores a missing page body", () => {
    expect(bridgeRecovery('{"ok":true,"agent":true}', LOGIN)).toBe("reload");
    expect(bridgeRecovery('{"ok":true,"agent":true}', null)).toBe("retry");
  });
});
