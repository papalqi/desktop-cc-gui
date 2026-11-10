#!/usr/bin/env node
// Read-only patrol of the CC GUI Hub: machine state, transcript sync failures,
// error/exception logs grouped by signature, and a comparison with the
// previous run. It only issues GET requests through the installed ccgui CLI
// (which owns the Hub login), so it never sends prompts, syncs or interrupts.
//
// Usage: node scripts/hub-patrol.mjs [--state-dir DIR] [--out FILE] [--json]
//   CCGUI_CLI overrides the CLI path (default ~/.ccgui/ccgui.mjs).
//   Each run writes a Markdown report and updates DIR/state.json, so later
//   runs report only new log entries and can tell new problems from old ones.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOG_CATEGORIES = ["exception", "error", "lifecycle"];
const MAX_PAGES_PER_CATEGORY = 300;
const SHORT_RETENTION_MS = 24 * 3600_000;
const STATE_VERSION = 1;

// ---------- pure helpers (exported for tests) ----------

/** Collapse ids, paths, times and numbers so recurrences of one problem share
 *  a signature. Keeps the first line only; stacks are reported separately. */
export function normalizeMessage(message) {
  return String(message ?? "")
    .split(/\r?\n/, 1)[0]
    .replace(/[A-Za-z]:[\\/][^\s:"']+/g, "<path>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?:session|run|cc)[-_][0-9a-z-]{6,}\b/gi, "<id>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}[:-]\d{2}[:-]\d{2}(?:\.\d+)?Z?\b/g, "<time>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function signatureOf(entry) {
  return [entry.category, entry.origin, entry.source ?? "", entry.operation ?? "", normalizeMessage(entry.message)].join(" | ");
}

/** Group log entries by signature with per-machine counts and distinct sessions. */
export function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = signatureOf(entry);
    let group = groups.get(key);
    if (!group) {
      group = {
        signature: key, category: entry.category, origin: entry.origin, source: entry.source ?? null,
        operation: entry.operation ?? null, level: entry.level, count: 0, machines: {}, sessions: new Set(),
        firstAt: entry.at, lastAt: entry.at, sample: entry,
      };
      groups.set(key, group);
    }
    group.count += 1;
    const machine = entry.machine ?? "(hub)";
    group.machines[machine] = (group.machines[machine] ?? 0) + 1;
    // Hub sync records name the session only inside the message ("op engine/id: ...").
    const sessionId = entry.sessionId ?? String(entry.message ?? "").match(/^\S+ \w+\/([\w-]+):/)?.[1];
    if (sessionId) group.sessions.add(sessionId);
    group.firstAt = Math.min(group.firstAt, entry.at);
    if (entry.at >= group.lastAt) { group.lastAt = entry.at; group.sample = entry; }
  }
  return [...groups.values()].map((g) => ({ ...g, sessions: g.sessions.size }));
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Turn collected data into prioritized findings. `previous` is the prior
 *  state (or null on the first run). */
export function deriveFindings({ now, status, groups, coverage, activity, latestVersion, previous }) {
  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, title, detail });
  const known = previous?.signatures ?? {};

  for (const group of groups.filter((g) => g.category === "exception")) {
    add("high", `未捕获异常：${group.signature.split(" | ").pop()}`,
      `${group.count} 次，机器 ${Object.keys(group.machines).join("/")}，最近 ${iso(group.lastAt)}`);
  }

  for (const machine of status.machines) {
    if (!machine.agentConnected) {
      const since = machine.lastCatalogSyncAt ? `，最后同步 ${iso(machine.lastCatalogSyncAt)}（${hoursAgo(now, machine.lastCatalogSyncAt)}）` : "";
      add("info", `${machine.name} 离线`, `执行端未连接${since}`);
    }
    const failed = machine.sync?.failedTranscriptCount ?? 0;
    if (failed > 0) {
      const codes = countBy(machine.sync?.failedTranscripts ?? [], (f) => f.errorCode ?? "unknown");
      add("medium", `${machine.name} 有 ${failed} 个会话记录同步失败`,
        `错误码 ${fmtCounts(codes)}；Hub 会按 retryAt 持续重试`);
    }
    if (machine.logs?.hasError) add("medium", `${machine.name} 日志补拉出错`, "machine.logs.hasError=true");
    const pending = machine.observer?.pendingCount ?? 0;
    if (pending > 0) add("medium", `${machine.name} 有 ${pending} 个待处理 RPC`, "观察连接上仍有未完成请求");
    const version = machine.observer?.version;
    if (machine.agentConnected && version && latestVersion && compareVersions(version, latestVersion) < 0) {
      add("low", `${machine.name} 执行端版本落后`, `${version}，当前最新 ${latestVersion}`);
    }
  }

  if (status.version && latestVersion && compareVersions(status.version, latestVersion) < 0) {
    add("low", "Hub 版本落后", `Hub ${status.version}，仓库 ${latestVersion}`);
  }

  if (coverage.windowMs !== null && coverage.windowMs < SHORT_RETENTION_MS) {
    const top = coverage.writeRate ? Object.entries(coverage.writeRate.producers).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, v]) => `${k} 占 ${v}%`).join("，") : "";
    add("medium", `Hub 日志实际只覆盖约 ${fmtDuration(coverage.windowMs)}`,
      `名义保留 7 天，但 ${coverage.capacity} 条上限已满，更早的记录被挤掉${coverage.writeRate ? `；当前约 ${Math.round(coverage.writeRate.perMinute)} 条/分钟，最近 100 条里 ${top}` : ""}；巡检间隔需短于该窗口`);
  }
  for (const gap of coverage.gaps) {
    add("medium", `${gap.category} 日志有缺口`, `上次读到 id ${gap.afterId}，现存最早 ${gap.oldestId}，中间记录已被清理`);
  }

  // hub/rpc, hub/sync and executor/rpc usually log the same failure; report it once.
  const fresh = new Map();
  for (const group of groups.filter((g) => g.category === "error" && previous && !known[g.signature])) {
    const message = group.signature.split(" | ").pop().replace(/^\S+ \w+\/<id>: /, "");
    const prior = fresh.get(message);
    if (!prior || group.count > prior.count) fresh.set(message, group);
  }
  for (const [message, group] of fresh) {
    add("medium", `新错误：${message}`, `${group.count} 次，${group.sessions} 个会话，机器 ${Object.keys(group.machines).join("/")}`);
  }

  const failedOps = activity.filter((a) => a.result !== "ok");
  if (failedOps.length) {
    add("low", `最近操作中 ${failedOps.length} 次失败`, fmtCounts(countBy(failedOps, (a) => `${a.machine} ${a.operation} ${a.result}`)));
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------- formatting ----------

function iso(ms) { return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z" : "-"; }
function hoursAgo(now, ms) { return `${fmtDuration(now - ms)}前`; }
export function fmtDuration(ms) {
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 72 * 3600_000) return `${(ms / 3600_000).toFixed(1)} 小时`;
  return `${(ms / 86400_000).toFixed(1)} 天`;
}
function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return counts;
}
function fmtCounts(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("，");
}
function cell(text) { return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }

export function renderReport({ now, status, findings, groups, coverage, activity, previous, perRunHours }) {
  const lines = [];
  const sev = { high: "🔴 高", medium: "🟠 中", low: "🟡 低", info: "⚪ 信息" };
  lines.push(`# Hub 巡检报告 ${iso(now)}`, "");
  lines.push(`- Hub ${status.version}，已运行 ${fmtDuration(status.uptimeMs)}，RSS ${(status.runtime?.memory?.rss / 2 ** 20).toFixed(0)} MiB`);
  lines.push(`- 本次读取日志：${coverage.read} 条（${LOG_CATEGORIES.join("/")}），覆盖 ${coverage.from ? `${iso(coverage.from)} 起` : "无"}${previous ? `；上次巡检 ${iso(previous.lastRunAt)}` : "；首次巡检，没有对比基线"}`);
  lines.push("");

  lines.push("## 需要关注", "");
  if (!findings.length) lines.push("没有发现需要处理的问题。");
  for (const f of findings) lines.push(`- **${sev[f.severity]}** ${f.title} — ${f.detail}`);
  lines.push("");

  lines.push("## 机器状态", "");
  lines.push("| 机器 | 连接 | 版本 | 运行中 | 同步失败 | 日志同步 | 最后帧 |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const m of status.machines) {
    lines.push(`| ${m.name} | ${m.agentConnected ? "在线" : "离线"} | ${m.observer?.version ?? "-"} | ${m.data?.activeRuns ?? "-"} | ${m.sync?.failedTranscriptCount ?? 0} | ${m.logs?.hasError ? "出错" : m.logs?.lastSyncedAt ? iso(m.logs.lastSyncedAt) : "-"} | ${m.observer?.lastFrameAt ? iso(m.observer.lastFrameAt) : "-"} |`);
  }
  lines.push("");

  const errorGroups = groups.filter((g) => g.category !== "lifecycle").sort((a, b) => b.count - a.count);
  lines.push("## 错误签名（按次数）", "");
  if (!errorGroups.length) lines.push("本次窗口内没有 error/exception 日志。");
  else {
    lines.push("| 次数 | 每小时 | 会话数 | 机器 | 来源 | 签名 | 最近 | 状态 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const g of errorGroups.slice(0, 30)) {
      const prior = previous?.signatures?.[g.signature];
      const rate = perRunHours > 0 ? (g.count / perRunHours).toFixed(1) : "-";
      const state = !previous ? "-" : !prior ? "新" : prior.lastRate && g.count / perRunHours > prior.lastRate * 2 ? "上升" : "已知";
      lines.push(`| ${g.count} | ${rate} | ${g.sessions} | ${cell(fmtCounts(g.machines))} | ${g.origin}/${g.source ?? ""}${g.operation ? ` ${g.operation}` : ""} | ${cell(g.signature.split(" | ").pop())} | ${iso(g.lastAt)} | ${state} |`);
    }
    if (errorGroups.length > 30) lines.push("", `另有 ${errorGroups.length - 30} 个签名未列出，见 JSON 输出。`);
  }
  lines.push("");

  const exceptions = groups.filter((g) => g.category === "exception");
  if (exceptions.length) {
    lines.push("## 异常堆栈样本", "");
    for (const g of exceptions) {
      lines.push(`### ${cell(g.signature.split(" | ").pop())}`, "", "```", String(g.sample.stack ?? g.sample.message ?? "").split(/\r?\n/).slice(0, 12).join("\n"), "```", "");
    }
  }

  const lifecycle = groups.filter((g) => g.category === "lifecycle");
  if (lifecycle.length) {
    lines.push("## 连接与生命周期事件", "");
    for (const g of lifecycle.sort((a, b) => b.count - a.count).slice(0, 15)) {
      lines.push(`- ${g.count}× ${cell(fmtCounts(g.machines))} — ${cell(g.signature.split(" | ").pop() || `${g.source} ${g.operation ?? ""}`)}`);
    }
    lines.push("");
  }

  const durations = {};
  for (const a of activity) if (typeof a.durationMs === "number") (durations[`${a.operation}`] ??= []).push(a.durationMs);
  const slow = Object.entries(durations).map(([op, v]) => ({ op, n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: Math.max(...v) }))
    .sort((a, b) => b.p95 - a.p95);
  if (slow.length) {
    lines.push("## 最近操作耗时（Hub 内存中最近 200 条）", "");
    lines.push("| 操作 | 次数 | p50 ms | p95 ms | 最大 ms |", "| --- | --- | --- | --- | --- |");
    for (const s of slow.slice(0, 10)) lines.push(`| ${s.op} | ${s.n} | ${s.p50} | ${s.p95} | ${s.max} |`);
    lines.push("");
  }

  lines.push("## 采集说明", "");
  lines.push("- 只读：仅调用 Hub 的 GET 诊断接口（status、logs、activity），不同步、不发送、不中断。");
  lines.push("- 日志来自 Hub 的 logs.db（含已同步的执行端日志）。它按条数上限淘汰，性能采样占大头，因此窗口以外的错误看不到；间隔过长的巡检会在“日志有缺口”里体现。");
  lines.push("- 签名把路径、ID、时间、数字归一化后分组；hub/rpc、hub/sync 与 executor/rpc 往往是同一次失败的三条记录。");
  return lines.join("\n") + "\n";
}

// ---------- I/O ----------

function cliPath() { return process.env.CCGUI_CLI ?? join(homedir(), ".ccgui", "ccgui.mjs"); }

function apiGet(path) {
  const raw = execFileSync(process.execPath, [cliPath(), "api", "GET", path], { encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
  const newline = raw.indexOf("\n");
  const head = raw.slice(0, newline).trim();
  const body = raw.slice(newline + 1);
  const httpStatus = Number(head.replace(/^http=/, ""));
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`${path}: non-JSON response (${head})`); }
  if (httpStatus !== 200 || !json.ok) throw new Error(`${path}: ${head} ${json.error?.code ?? ""} ${json.error?.message ?? ""}`.trim());
  return json.data;
}

function readLogs(category, afterId) {
  const entries = [];
  let cursor = afterId, head = null, oldestId = null, epoch = null, truncated = false;
  for (let page = 0; page < MAX_PAGES_PER_CATEGORY; page += 1) {
    const query = new URLSearchParams({ category, limit: "100", afterId: String(cursor) });
    if (head !== null) query.set("untilId", String(head));
    const data = apiGet(`/_relay/api/logs?${query}`);
    if (page === 0) { head = data.head; oldestId = data.oldestId; epoch = data.epoch; truncated = data.truncated; }
    entries.push(...data.entries);
    if (!data.hasMore || data.nextId == null || data.nextId === cursor) break;
    cursor = data.nextId;
  }
  return { entries, head, oldestId, epoch, truncated };
}

function readActivity() {
  const entries = [];
  let afterId = 0;
  for (let page = 0; page < 3; page += 1) {
    const data = apiGet(`/_relay/api/activity?limit=100&afterId=${afterId}`);
    entries.push(...data.entries);
    if (!data.hasMore || data.nextId == null) break;
    afterId = data.nextId;
  }
  return entries;
}

function repoVersion() {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).version;
  } catch { return null; }
}

function parseArgs(argv) {
  const args = { stateDir: join(homedir(), ".ccgui", "patrol"), out: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--state-dir") args.stateDir = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--json") args.json = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(cliPath())) throw new Error(`ccgui CLI not found at ${cliPath()}; install it or set CCGUI_CLI`);
  mkdirSync(join(args.stateDir, "reports"), { recursive: true });
  const statePath = join(args.stateDir, "state.json");
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const usablePrevious = previous?.version === STATE_VERSION ? previous : null;

  const now = Date.now();
  const status = apiGet("/_relay/api/status");
  const activity = readActivity();

  const entries = [];
  const coverage = { read: 0, from: null, gaps: [], windowMs: null, count: status.logs?.count, capacity: status.logs?.retention?.capacity };
  const cursors = {};
  for (const category of LOG_CATEGORIES) {
    const prior = usablePrevious?.logEpoch === status.logs?.epoch ? usablePrevious.cursors?.[category] ?? 0 : 0;
    const result = readLogs(category, prior);
    if (prior > 0 && result.oldestId != null && result.oldestId > prior + 1) {
      coverage.gaps.push({ category, afterId: prior, oldestId: result.oldestId });
    }
    cursors[category] = result.head ?? prior;
    entries.push(...result.entries);
  }
  coverage.read = entries.length;
  coverage.from = entries.length ? Math.min(...entries.map((e) => e.at)) : null;
  // The oldest retained record of any category bounds what any run can see.
  const oldestPage = apiGet("/_relay/api/logs?limit=1&afterId=0");
  const oldest = oldestPage.entries[0];
  if (oldest && (status.logs?.count ?? 0) >= (status.logs?.retention?.capacity ?? Infinity)) coverage.windowMs = now - oldest.at;
  // Sample the newest records of every category to show what fills the budget.
  if (oldestPage.head) {
    const recent = apiGet(`/_relay/api/logs?limit=100&afterId=${Math.max(0, oldestPage.head - 100)}`).entries;
    if (recent.length > 1) {
      const times = recent.map((e) => e.at);
      coverage.writeRate = { perMinute: (recent.length / Math.max(1, Math.max(...times) - Math.min(...times))) * 60_000,
        producers: countBy(recent, (e) => [e.category, e.origin, e.source, e.machine, e.operation].filter(Boolean).join(" ")) };
    }
  }

  const groups = groupEntries(entries);
  const perRunHours = usablePrevious ? (now - usablePrevious.lastRunAt) / 3600_000
    : coverage.from ? (now - coverage.from) / 3600_000 : 0;
  const findings = deriveFindings({ now, status, groups, coverage, activity, latestVersion: repoVersion(), previous: usablePrevious });
  const report = renderReport({ now, status, findings, groups, coverage, activity, previous: usablePrevious, perRunHours });

  const signatures = { ...(usablePrevious?.signatures ?? {}) };
  for (const g of groups) {
    const prior = signatures[g.signature];
    signatures[g.signature] = {
      firstSeen: prior?.firstSeen ?? g.firstAt, lastSeen: g.lastAt, total: (prior?.total ?? 0) + g.count,
      runs: (prior?.runs ?? 0) + 1, lastRate: perRunHours > 0 ? g.count / perRunHours : null,
    };
  }
  writeFileSync(statePath, JSON.stringify({ version: STATE_VERSION, lastRunAt: now, logEpoch: status.logs?.epoch, cursors, signatures }, null, 1));

  const stamp = new Date(now).toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const reportPath = args.out ?? join(args.stateDir, "reports", `${stamp}.md`);
  writeFileSync(reportPath, report);
  if (args.json) console.log(JSON.stringify({ reportPath, findings, groups: groups.map(({ sample, ...g }) => g) }, null, 1));
  else process.stdout.write(`${report}\n报告已写入 ${reportPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`hub-patrol: ${error.message}`); process.exit(1); });
}
