import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "@/lib/i18n";
import { ipc, type SessionMeta, type SessionPage } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { persistTabs } from "@/features/chat/store/persistence";
import { MessageTimeline } from "@/features/chat/components/MessageTimeline";
import { performanceRecorder } from "@/lib/performance-diagnostics";
import { startPerformanceMonitor } from "@/lib/performance-monitor";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tab = (sessionId: string) => ({ engine: "codex", sessionId, workspacePath: "/fixture" });
const meta = (sessionId: string): SessionMeta => ({ ...tab(sessionId), filePath: `/fixture/${sessionId}.jsonl`, fileSize: 1,
  fileMtimeMs: 1, title: sessionId, preview: "", createdAt: 1, updatedAt: 1, messageCount: 32, pinned: false, customTitle: null });
const page = (sessionId: string): SessionPage => ({
  messages: Array.from({ length: 32 }, (_, index) => ({ seq: index + 1, role: index % 2 ? "assistant" : "user",
    text: `${sessionId} · ${index} 中文🙂\n\n${index % 2 ? "**保留原文**\n\n```ts\nconst value = 1;\n```" : "会话切换后必须仍停在用户选择的会话。"}`, ts: "2000" })),
  nextBefore: null, subagentHistory: [],
});
let catalogDelay = 0;
let historyDelay = 0;
let scanned = [meta("a"), meta("b"), meta("c")];
Object.assign(ipc, {
  listWorkspaces: async () => [{ id: "fixture", path: "/fixture", name: "fixture", lastOpenedAt: null, sortOrder: null, groupId: null }],
  listSessions: async () => { const result = scanned; await wait(catalogDelay); return result; },
  listArchivedSessions: async () => [], listActiveRuns: async () => [],
  listEngines: async () => [{ id: "codex", available: true, enabled: true, supportsImages: false }],
  getAppSettings: async () => ({}), getCliConfig: async () => ({}), listPlanReviews: async () => [],
  loadSessionPage: async (_engine: string, sessionId: string) => { await wait(historyDelay); return page(sessionId); },
});

function seed() {
  useChatStore.getState().prepareMachineSwitch();
  scanned = [meta("a"), meta("b"), meta("c")];
  useChatStore.setState({ activeEngine: "codex", archivedSessionKeys: {}, sessions: scanned, openTabs: [tab("a"), tab("b"), tab("c")],
    active: tab("b"), bySession: {
      "codex/a": { ...EMPTY_SESSION, historyLoaded: false },
      "codex/b": { ...EMPTY_SESSION, messages: page("b").messages, historyLoaded: true },
      "codex/c": { ...EMPTY_SESSION, messages: page("c").messages, historyLoaded: true },
    } });
  persistTabs(useChatStore.getState().openTabs, useChatStore.getState().active);
}
seed();

function Harness() {
  const active = useChatStore((s) => s.active);
  const state = useChatStore((s) => active?.sessionId ? s.bySession[`codex/${active.sessionId}`] : undefined);
  const [result, setResult] = useState<unknown>("Ready");
  useEffect(() => startPerformanceMonitor(() => ({ sessions: 3, messages: 96, streaming: 0 })), []);
  const run = async () => {
    performanceRecorder.setEnabled(false); performanceRecorder.setEnabled(true);
    seed(); setResult("Running"); catalogDelay = 350; historyDelay = 250;
    const unexpected: string[] = [];
    let wanted = "b";
    const stop = useChatStore.subscribe((s, previous) => {
      if (s.active?.sessionId !== previous.active?.sessionId && s.active?.sessionId !== wanted) unexpected.push(s.active?.sessionId ?? "none");
    });
    try {
      const refresh = useChatStore.getState().refreshSessions();
      await wait(50); wanted = "c"; await useChatStore.getState().selectSession("codex", "c", "/fixture");
      await refresh; await wait(450);
      const backgroundLoaded = useChatStore.getState().bySession["codex/a"].messages.length === 32;
      const cached = useChatStore.getState().bySession["codex/c"];
      scanned = [meta("a"), meta("b")];
      const replace = useChatStore.getState().replaceMachineCatalog();
      await wait(50); wanted = "b"; await useChatStore.getState().selectSession("codex", "b", "/fixture");
      await replace; await wait(120);
      const preserved = useChatStore.getState().bySession["codex/c"] === cached;
      for (let i = 0; i < 12; i++) {
        wanted = i % 2 ? "b" : "c";
        await useChatStore.getState().selectSession("codex", wanted, "/fixture");
        await wait(70);
      }
      const finalSession = useChatStore.getState().active?.sessionId;
      const status = unexpected.length === 0 && backgroundLoaded && preserved && finalSession === wanted ? "PASS" : "FAIL";
      const report = { status, unexpected, backgroundLoaded, preserved, finalSession, diagnostics: performanceRecorder.snapshot() };
      setResult(report); return report;
    } finally { stop(); catalogDelay = 0; historyDelay = 0; }
  };
  useEffect(() => { (window as unknown as { __sessionSwitchTest: () => Promise<unknown> }).__sessionSwitchTest = run; });
  return <main className="flex h-screen flex-col bg-background-primary p-4 text-text-primary">
    <div className="flex gap-4"><button onClick={() => void run()}>Run session-switch regression</button>
      {["a", "b", "c"].map((id) => <button key={id} role="tab" aria-selected={active?.sessionId === id}
        onClick={() => void useChatStore.getState().selectSession("codex", id, "/fixture")}>{id}</button>)}</div>
    <output className="block max-h-28 overflow-auto whitespace-pre-wrap" data-result>{typeof result === "string" ? result : JSON.stringify(result)}</output>
    {state && active && <MessageTimeline key={active.sessionId} sessionKey={`codex/${active.sessionId}`} session={state}
      streaming={state.streaming} workspacePath="/fixture" onLoadEarlier={() => {}} />}
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<React.StrictMode><Harness /></React.StrictMode>);
