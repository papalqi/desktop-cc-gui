import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import BookOpen from "lucide-react/dist/esm/icons/book-open";
import i18n from "@/lib/i18n";
import { panelTabRegistry } from "@ccgui/plugin-sdk";
import { FilesPanel } from "@/features/files/FilesPanel";
import { ChangesPanel } from "@/features/git/ChangesPanel";
import { ProfilePanel } from "@/features/profile/ProfilePanel";
import { machineResourceKey } from "@/lib/web-machine";

/**
 * Builtin right-panel tabs, registered through the same extension-point
 * registry plugins use (plan §4.2 #4 — files/changes are the dogfood
 * surface). Module-scope side effect, imported once by ChatPage; the
 * registry's upsert semantics make HMR re-runs harmless.
 */

/** ChangesPanel keeps its per-workspace remount (key) and full-width class
 *  exactly as it was inlined in ChatSidePanel. */
export const ChangesTab = ({ workspacePath, machine, visible = true }: { workspacePath: string; machine?: string; visible?: boolean }) => (
  <ChangesPanel key={machineResourceKey(workspacePath, machine)} workspacePath={workspacePath} machine={machine} visible={visible} className="w-full" />
);

/** The profile reader ignores the workspace; it needs visibility so the
 *  iframe unmounts while another tab is shown. */
export const ProfileTab = ({ visible = true }: { workspacePath: string; visible?: boolean }) => (
  <ProfilePanel visible={visible} />
);

panelTabRegistry.register({
  id: "files",
  label: () => i18n.t("files.tab"),
  icon: FolderSymlink,
  order: 0,
  component: FilesPanel,
});
panelTabRegistry.register({
  id: "changes",
  label: () => i18n.t("git.changes"),
  icon: GitBranch,
  order: 1,
  component: ChangesTab,
});
panelTabRegistry.register({
  id: "profile",
  label: () => i18n.t("profile.tab"),
  icon: BookOpen,
  order: 2,
  component: ProfileTab,
});
