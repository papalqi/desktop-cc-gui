import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "@/lib/i18n";
import { ipc, ipcForMachine, type AppSettings, type SessionMeta, type SessionPage } from "@/lib/ipc";
import { useChatStore, sessionKey } from "@/features/chat/store";
import { MessageTimeline } from "@/features/chat/components/MessageTimeline";
import { SessionViewControls } from "@/features/chat/SessionViewControls";

// In-memory IPC only. No model, native app, Hub, credentials or user files.
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const machines = ["PC0", "PC6"];
const workspace = "E:/same";
const key = (machine: string) => sessionKey("codex", "same", workspace, machine);
const meta = (machine: string, origin: "hub" | "local" = "hub"): SessionMeta => ({ machine, engine: "codex", sessionId: origin === "hub" ? "same" : "local",
  workspacePath: workspace, filePath: "/fixture.jsonl", fileSize: 1, fileMtimeMs: 1, title: machine, preview: "中文🙂",
  createdAt: 1, updatedAt: 1, messageCount: 6, pinned: false, customTitle: null, origin });
const page = (machine: string): SessionPage => ({ messages: Array.from({ length: 6 }, (_, index) => ({ seq: index + 1,
  role: index % 2 ? "assistant" : "user", text: `${machine} · ${index} 中文🙂\n\n**原文**\n\n\`\`\`ts\nconst value = 1;\n\`\`\``, ts: null })),
  nextBefore: null, subagentHistory: [] });
let settings: AppSettings = { sessionScope: "all", sessionSort: "workspace" };
let rows = machines.map((machine) => meta(machine));
let catalogDelay = 0;
const calls: string[] = [];
Object.assign(ipc, {
  listSessions: async (scope: string) => { const result = scope === "remote" ? rows : [...rows, meta("PC0", "local")]; await wait(catalogDelay); return result; },
  listArchivedSessions: async () => [], listActiveRuns: async () => [],
  getAppSettings: async () => settings, updateAppSettings: async (value: AppSettings) => { settings = value; },
});
for (const machine of machines) Object.assign(ipcForMachine(machine), {
  loadSessionPage: async () => { await wait(machine === "PC0" ? 300 : 20); return page(machine); },
  listPlanReviews: async () => [], listEngines: async () => [{ id: "codex", available: true, enabled: true, supportsImages: false }],
  getCliConfig: async () => ({}), getAppSettings: async () => ({}),
  pinSession: async (_engine: string, _id: string, pinned: boolean) => { calls.push(machine); rows = rows.map((row) => row.machine === machine ? { ...row, pinned } : row); },
});

function seed() {
  useChatStore.getState().prepareMachineSwitch();
  settings = { sessionScope: "all", sessionSort: "workspace" };
  rows = machines.map((machine) => meta(machine)); calls.length = 0;
  useChatStore.setState({ activeEngine: "codex", sessions: rows, workspaces: [], engines: [], sessionScope: "all", sessionSort: "workspace",
    active: null, openTabs: [], bySession: {}, archivedSessionKeys: {}, streamingByKey: {}, retryingByKey: {}, unseen: {},
    enginesByMachine: {}, providersByMachine: {}, serviceTiersByMachine: {}, actionError: null,
    drafts: { [key("PC0")]: "PC0 draft", [key("PC6")]: "PC6 draft" },
  });
}
seed();

function Pane({ machine }: { machine: string }) {
  const session = useChatStore((state) => state.bySession[key(machine)]);
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col border border-border-primary" data-machine={machine}>
    <h2 className="p-2">{machine} · codex / same · E:/same</h2>
    {session && <MessageTimeline sessionKey={key(machine)} session={session} streaming={session.streaming} workspacePath={workspace} onLoadEarlier={() => {}} />}
  </section>;
}

function Harness() {
  const active = useChatStore((state) => state.active);
  const [result, setResult] = useState<unknown>("Ready");
  const run = async () => {
    seed(); setResult("Running");
    const first = useChatStore.getState().selectSession("codex", "same", workspace, "PC0");
    await wait(10);
    await useChatStore.getState().selectSession("codex", "same", workspace, "PC6");
    const cached = useChatStore.getState().bySession[key("PC6")];
    await first;
    await useChatStore.getState().pinSession("codex", "same", true, "PC6");
    catalogDelay = 200;
    const older = useChatStore.getState().refreshSessions();
    await wait(10); catalogDelay = 0;
    await useChatStore.getState().setSessionScope("remote");
    await older;
    const state = useChatStore.getState();
    const checks = {
      foreground: state.active?.machine === "PC6" && state.openTabs.length === 2,
      history: machines.every((machine) => state.bySession[key(machine)].messages.every((message) => message.text.startsWith(machine))),
      cached: state.bySession[key("PC6")].messages === cached.messages,
      drafts: state.drafts[key("PC0")] === "PC0 draft" && state.drafts[key("PC6")] === "PC6 draft",
      pin: calls.join() === "PC6" && rows.find((row) => row.machine === "PC6")?.pinned === true && rows.find((row) => row.machine === "PC0")?.pinned === false,
      scope: state.sessionScope === "remote" && state.sessions.length === 2 && state.sessions.every((row) => row.origin === "hub"),
    };
    const report = { status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks, route: window.location.search };
    setResult(report); return report;
  };
  useEffect(() => { Object.assign(window, { __multiMachineTest: run }); });
  return <main className="flex h-screen flex-col gap-3 bg-background-primary p-3 text-text-primary">
    <div className="flex gap-3"><button onClick={() => void run()}>Run multi-machine regression</button>
      {machines.map((machine) => <button key={machine} role="tab" aria-selected={active?.machine === machine}
        onClick={() => void useChatStore.getState().selectSession("codex", "same", workspace, machine)}>{machine}</button>)}</div>
    <div className="max-w-sm"><SessionViewControls /></div>
    <output className="whitespace-pre-wrap" data-result>{typeof result === "string" ? result : JSON.stringify(result)}</output>
    <div className="flex min-h-0 flex-1 gap-3"><Pane machine="PC0" /><Pane machine="PC6" /></div>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<React.StrictMode><Harness /></React.StrictMode>);
