import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.cookie = "ccgui_machine=; Max-Age=0";
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC0");
});

it("separates identical session and draft identities on different machines", async () => {
  const { sessionKey, parseSessionKey, parseDraftSessionKey, pendingWorkspaceOfKey, dedupeTabs } = await import("./persistence");
  const pc0 = { machine: "PC0", engine: "codex", sessionId: "same", workspacePath: "E:/repo" };
  const pc6 = { ...pc0, machine: "PC6" };
  expect(sessionKey("codex", "same", "", "PC0")).toBe("PC0/codex/same");
  expect(sessionKey("codex", "same", "", "PC6")).toBe("PC6/codex/same");
  expect(parseSessionKey("PC6/codex/same")).toEqual({ machine: "PC6", engine: "codex", sessionId: "same" });
  expect(parseSessionKey("codex/legacy")).toEqual({ engine: "codex", sessionId: "legacy" });
  const draft = sessionKey("codex", null, "E:/中文🙂", "PC6");
  expect(parseDraftSessionKey(draft)).toEqual({ machine: "PC6", engine: "codex", workspacePath: "E:/中文🙂" });
  expect(pendingWorkspaceOfKey("codex", draft)).toBe("E:/中文🙂");
  expect(dedupeTabs([pc0, pc6, pc0])).toEqual([pc0, pc6]);
});

it("persists unread identities per page mode without sharing identical machine session IDs", async () => {
  const p = await import("./persistence");
  p.persistUnseen({ "PC0/codex/same": true, "PC6/codex/same": false });
  expect(p.readPersistedUnseen()).toEqual({ "PC0/codex/same": true });
  window.history.replaceState(null, "", "/CCGUI/?machine=PC0");
  expect(p.readPersistedUnseen()).toEqual({});
  window.history.replaceState(null, "", "/CCGUI/?global=1&machine=PC6");
  expect(p.readPersistedUnseen()).toEqual({ "PC0/codex/same": true });
});

it("migrates only the known machine's legacy tabs and persists global tabs together", async () => {
  const tabs = [{ engine: "codex", sessionId: "same", workspacePath: "E:/repo" }];
  localStorage.setItem("ccgui-next.openTabs:v1:PC0", JSON.stringify(tabs));
  localStorage.setItem("ccgui-next.activeSession:v1:PC0", JSON.stringify(tabs[0]));
  const p = await import("./persistence");
  expect(p.readPersistedTabs()).toEqual([{ ...tabs[0], machine: "PC0" }]);
  const pc6 = { ...tabs[0], machine: "PC6" };
  p.persistTabs([...p.readPersistedTabs(), pc6], pc6);
  expect(new URLSearchParams(window.location.search).get("machine")).toBe("PC6");
  expect(new URLSearchParams(window.location.search).get("session")).toBe("same");
  expect(new URLSearchParams(window.location.search).get("engine")).toBe("codex");
  const { setWebMachine } = await import("@/lib/web-machine");
  setWebMachine("PC6");
  expect(p.readPersistedTabs()).toHaveLength(2);
  expect(p.readPersistedActive()).toEqual(pc6);
  expect(localStorage.getItem("ccgui-next.openTabs:v1:PC0")).toBe(JSON.stringify(tabs));
});
