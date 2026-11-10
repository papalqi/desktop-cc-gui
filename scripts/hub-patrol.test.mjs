import assert from "node:assert/strict";
import test from "node:test";
import { deriveFindings, groupEntries, normalizeMessage, percentile } from "./hub-patrol.mjs";

const missingFile = (sessionId, day) => ({
  at: 1_000 + day, origin: "executor", category: "error", level: "error", source: "rpc", machine: "PC0",
  operation: "session_log_since", sessionId,
  message: `open C:\\Users\\me\\.codex\\sessions\\2026\\10\\${day}\\rollout-2026-10-${day}T10-21-05-${sessionId}.jsonl: 系统找不到指定的文件。 (os error 2)`,
});

test("recurrences of one failure share a signature regardless of ids, paths and numbers", () => {
  const a = normalizeMessage(missingFile("01a19a0f-6c1d-7b33-8f75-32f692e5a347", 16).message);
  const b = normalizeMessage(missingFile("01a18bb0-16f9-7ab3-ada6-d8682648ef03", 30).message);
  assert.equal(a, b);
  assert.match(a, /^open <path>: 系统找不到指定的文件。 \(os error <n>\)$/);
  assert.equal(normalizeMessage("session_log_since codex/01a1534f-96a6-7df2-ac1d-9c39598c1dbe: boom"), "session_log_since codex/<id>: boom");
  assert.equal(normalizeMessage("line one\n    at stack frame"), "line one");
  assert.equal(normalizeMessage("path is outside the registered workspaces: C:/Users/me/.codex/sessions/2026"), "path is outside the registered workspaces: <path>");
});

test("groups count entries, machines and distinct sessions", () => {
  const entries = [
    missingFile("01a19a0f-6c1d-7b33-8f75-32f692e5a347", 16),
    missingFile("01a19a0f-6c1d-7b33-8f75-32f692e5a347", 16),
    { ...missingFile("01a18bb0-16f9-7ab3-ada6-d8682648ef03", 30), machine: "PC6" },
  ];
  const [group, ...rest] = groupEntries(entries);
  assert.equal(rest.length, 0);
  assert.equal(group.count, 3);
  assert.equal(group.sessions, 2);
  assert.deepEqual(group.machines, { PC0: 2, PC6: 1 });
});

test("percentile picks nearest rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
});

const status = {
  version: "1.3.0",
  machines: [
    { name: "PC0", agentConnected: true, observer: { version: "1.3.3", pendingCount: 0 }, sync: { failedTranscriptCount: 2, failedTranscripts: [{ errorCode: "executor_rejected" }, { errorCode: "executor_rejected" }] }, logs: {} },
    { name: "PC5", agentConnected: false, observer: { state: "offline" }, sync: { failedTranscriptCount: 0 }, logs: {}, lastCatalogSyncAt: 0 },
  ],
};
const coverage = { read: 0, from: null, gaps: [], windowMs: 75 * 60_000, count: 50_000, capacity: 50_000 };

test("findings flag sync failures, short log coverage, stale versions and offline machines", () => {
  const findings = deriveFindings({ now: 3_600_000, status, groups: [], coverage, activity: [], latestVersion: "1.3.3", previous: null });
  const titles = findings.map((f) => f.title);
  assert.ok(titles.includes("PC0 有 2 个会话记录同步失败"));
  assert.ok(titles.some((t) => t.startsWith("Hub 日志实际只覆盖约")));
  assert.ok(titles.includes("Hub 版本落后"));
  assert.ok(titles.includes("PC5 离线"));
  assert.deepEqual(findings.map((f) => f.severity), [...findings.map((f) => f.severity)].sort((a, b) => ["high", "medium", "low", "info"].indexOf(a) - ["high", "medium", "low", "info"].indexOf(b)));
});

test("new error signatures are only reported once a baseline exists, exceptions always", () => {
  const groups = groupEntries([missingFile("01a19a0f-6c1d-7b33-8f75-32f692e5a347", 16), { ...missingFile("x", 1), category: "exception", message: "TypeError: boom" }]);
  const quiet = { ...coverage, windowMs: null };
  const first = deriveFindings({ now: 0, status: { machines: [] }, groups, coverage: quiet, activity: [], latestVersion: null, previous: null });
  assert.deepEqual(first.map((f) => f.severity), ["high"]);
  const second = deriveFindings({ now: 0, status: { machines: [] }, groups, coverage: quiet, activity: [], latestVersion: null, previous: { signatures: {} } });
  assert.deepEqual(second.map((f) => f.severity), ["high", "medium"]);
  const triple = groupEntries(["hub", "executor"].map((origin) => ({ ...missingFile("01a19a0f-6c1d-7b33-8f75-32f692e5a347", 16), origin })));
  const once = deriveFindings({ now: 0, status: { machines: [] }, groups: triple, coverage: quiet, activity: [], latestVersion: null, previous: { signatures: {} } });
  assert.equal(once.length, 1, "the same failure logged by hub and executor is one finding");
  const known = Object.fromEntries(groups.map((g) => [g.signature, {}]));
  const third = deriveFindings({ now: 0, status: { machines: [] }, groups, coverage: quiet, activity: [], latestVersion: null, previous: { signatures: known } });
  assert.deepEqual(third.map((f) => f.severity), ["high"]);
});
