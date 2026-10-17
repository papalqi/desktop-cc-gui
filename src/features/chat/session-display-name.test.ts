import { describe, expect, it } from "vitest";
import {
  contextTitle,
  pageTitle,
  pathLeaf,
  projectNameForSession,
  searchProjectLabel,
  sessionDisplayName,
} from "./session-display-name";

describe("sessionDisplayName", () => {
  it("uses the engine title as the headline and keeps that summary on a nested row", () => {
    const named = sessionDisplayName({
      customTitle: null,
      title: "帮我看看登录",
      sessionId: "abcdef123456",
      localName: "支付后端",
    });
    expect(named.headline).toBe("帮我看看登录");
    expect(named.nestedLabel).toBe("帮我看看登录");
    expect(named.summary).toBe("");

    const renamed = sessionDisplayName({
      customTitle: " 复盘 ",
      title: "帮我看看登录",
      sessionId: "abcdef123456",
      localName: "支付后端",
    });
    expect(renamed.headline).toBe("复盘");
    expect(renamed.nestedLabel).toBe("复盘");
    expect(renamed.summary).toBe("帮我看看登录");
  });

  it("falls back to the project, then a short id, when the summary is empty", () => {
    expect(sessionDisplayName({ title: " ", sessionId: "abcdef123456", localName: "pay" }).headline).toBe("pay");
    expect(sessionDisplayName({ title: " ", sessionId: "abcdef123456", localName: "pay" }).nestedLabel).toBe("pay");
    expect(sessionDisplayName({ title: "", sessionId: "abcdef123456" }).headline).toBe("abcdef12");
    expect(pathLeaf("E:\\projects\\desktop-cc-gui\\")).toBe("desktop-cc-gui");
  });

  it("builds a tab title without repeating the project", () => {
    expect(contextTitle({ machine: "PC5", localName: "pay", headline: "帮我看看" })).toBe("PC5 · pay · 帮我看看");
    expect(pageTitle({ machine: "PC5", localName: "pay", customTitle: "pay" })).toBe("PC5 · pay");
    expect(pageTitle({ machine: "PC6", localName: "支付后端", title: "帮我看看登录" })).toBe("PC6 · 帮我看看登录 · 支付后端");
    expect(pageTitle({ machine: "PC6", localName: "支付后端", customTitle: "复盘", title: "帮我看看登录" })).toBe("PC6 · 复盘 · 支付后端");
    expect(pageTitle({ machine: "PC6", localName: "支付后端", fallback: "新对话" })).toBe("PC6 · 新对话 · 支付后端");
    expect(pageTitle({})).toBe("CC GUI");
    expect(projectNameForSession(
      { workspacePath: "E:/pay", machine: "PC6" },
      [{ id: "PC6/w", path: "E:/pay", name: "pay", machine: "PC6" }],
      { "PC6/w": "支付后端" },
    )).toBe("支付后端");
  });

  it("uses the catalog name in search, and the API name when the workspace is absent", () => {
    const workspaces = [{ id: "PC6/w", path: "E:/pay", name: "pay", machine: "PC6" }];
    expect(searchProjectLabel(
      { workspacePath: "E:/pay", machine: "PC6", workspaceName: "E:/pay", workspaceAlias: null },
      workspaces,
      { "PC6/w": "支付后端" },
    )).toBe("支付后端");
    expect(searchProjectLabel(
      { workspacePath: "E:/other", machine: "PC0", workspaceAlias: "网页名", workspaceName: "E:/other/folder" },
      workspaces,
      {},
    )).toBe("网页名");
    expect(searchProjectLabel(
      { workspacePath: "E:/other/folder", machine: "PC0", workspaceName: null, workspaceAlias: null },
      [],
      {},
    )).toBe("folder");
  });
});
