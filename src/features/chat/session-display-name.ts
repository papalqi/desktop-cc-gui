/** Names shown for a session. The engine `title` is the Codex thread name
 * when CC GUI has one, otherwise the engine summary. The local project is
 * the workspace alias or folder name. */

export function pathLeaf(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function localProjectName(input: {
  alias?: string | null;
  workspaceName?: string | null;
  workspacePath?: string | null;
}): string {
  const alias = input.alias?.trim();
  if (alias) return alias;
  const name = input.workspaceName?.trim();
  if (name) return name;
  return pathLeaf(input.workspacePath);
}

export interface SessionDisplay {
  localName: string;
  /** Engine summary when it is not already the standalone headline. */
  summary: string;
  /** User rename, else engine title, else local project, else a short id. */
  headline: string;
  /** Under a project row: user name, else summary, else local project. */
  nestedLabel: string;
}

export function sessionDisplayName(input: {
  customTitle?: string | null;
  title?: string | null;
  sessionId?: string | null;
  localName?: string | null;
}): SessionDisplay {
  const custom = input.customTitle?.trim() ?? "";
  const local = input.localName?.trim() ?? "";
  const summaryText = input.title?.trim() ?? "";
  const id = input.sessionId?.slice(0, 8) ?? "";
  const headline = custom || summaryText || local || id;
  const nestedLabel = custom || summaryText || local || id;
  const summary = summaryText && summaryText !== headline ? summaryText : "";
  return { localName: local, summary, headline, nestedLabel };
}

/** Skip a piece that repeats the previous one. */
export function contextTitle(parts: {
  machine?: string | null;
  localName?: string | null;
  headline?: string | null;
}): string {
  const bits: string[] = [];
  for (const value of [parts.machine, parts.localName, parts.headline]) {
    const text = value?.trim() ?? "";
    if (text && bits[bits.length - 1] !== text) bits.push(text);
  }
  return bits.join(" · ");
}

export function projectNameForSession(
  session: { workspacePath?: string | null; machine?: string | null },
  workspaces: readonly { id: string; path: string; name: string; machine?: string | null }[],
  aliases: Record<string, string> | null | undefined,
): string {
  const path = session.workspacePath ?? "";
  const machine = session.machine ?? "";
  const found = workspaces.find((item) => item.path === path && (item.machine ?? "") === machine)
    ?? (machine ? undefined : workspaces.find((item) => item.path === path));
  return localProjectName({
    alias: found ? aliases?.[found.id] : undefined,
    workspaceName: found?.name,
    workspacePath: path,
  });
}

/** Content-search project column. A workspace in the open catalog uses that
 * name; otherwise the API alias, folder, or path leaf. */
export function searchProjectLabel(
  hit: {
    workspacePath?: string | null;
    machine?: string | null;
    workspaceAlias?: string | null;
    workspaceName?: string | null;
  },
  workspaces: readonly { id: string; path: string; name: string; machine?: string | null }[],
  aliases: Record<string, string> | null | undefined,
): string {
  const catalogName = projectNameForSession(hit, workspaces, aliases);
  const known = workspaces.some((item) => item.path === (hit.workspacePath ?? "") && (item.machine ?? "") === (hit.machine ?? ""));
  if (known) return catalogName;
  return hit.workspaceAlias?.trim() || hit.workspaceName?.trim() || catalogName;
}

/** Browser tab, window title, and session tab: machine, then the headline,
 * then the project when it is not already the headline. An empty new chat
 * uses `fallback` (新对话) before the project. No session falls back to CC GUI. */
export function pageTitle(input: {
  machine?: string | null;
  localName?: string | null;
  customTitle?: string | null;
  title?: string | null;
  sessionId?: string | null;
  fallback?: string | null;
}): string {
  const project = input.localName?.trim() ?? "";
  const headline = input.customTitle?.trim()
    || input.title?.trim()
    || input.fallback?.trim()
    || project
    || input.sessionId?.slice(0, 8)
    || "";
  const bits: string[] = [];
  for (const value of [input.machine, headline]) {
    const text = value?.trim() ?? "";
    if (text && bits[bits.length - 1] !== text) bits.push(text);
  }
  if (project && project !== headline && bits[bits.length - 1] !== project) bits.push(project);
  return bits.join(" · ") || "CC GUI";
}
