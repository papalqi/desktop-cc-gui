import { expect, it } from "vitest";
import i18n from "./i18n";
import { errorText } from "./errors";

it("localizes provider migration conflicts from native and web errors", async () => {
  const path = "D:\\配置\\config.toml";
  const backup = "D:\\备份\\config.toml";
  const message = "CCGUI_PROVIDER_MIGRATION_CONFLICT:" + JSON.stringify({ path, backup });
  await i18n.changeLanguage("zh");
  expect(errorText(message)).toContain("旧版渠道配置无法自动恢复");
  expect(errorText(message)).toContain(path);
  await i18n.changeLanguage("en");
  expect(errorText(new Error(message))).toContain("Both files have been preserved");
  expect(errorText(new Error(message))).toContain(backup);
});

it("preserves unknown and malformed errors", () => {
  expect(errorText("CCGUI_PROVIDER_MIGRATION_CONFLICT:invalid")).toBe("CCGUI_PROVIDER_MIGRATION_CONFLICT:invalid");
  expect(errorText(new Error("disk full"))).toBe("disk full");
});

it("tells the interface to wait when the machine is offline", async () => {
  await i18n.changeLanguage("zh");
  expect(errorText("machine is offline")).toBe("未连接。本地操作需等待机器连接。");
  expect(errorText(new Error("Machine is offline"))).toBe("未连接。本地操作需等待机器连接。");
  await i18n.changeLanguage("en");
  expect(errorText("the machine is offline")).toBe("Offline. Local actions wait until the machine reconnects.");
});
