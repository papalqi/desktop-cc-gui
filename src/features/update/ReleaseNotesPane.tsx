import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import Info from "lucide-react/dist/esm/icons/info";
import RefreshCcw from "lucide-react/dist/esm/icons/refresh-ccw";
import { ActionFeedbackIcon, useActionFeedback, type ActionFeedback } from "@/components/base/action-feedback";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";
import { CHANGELOG_DATA, changelogEntryFor, type ChangelogEntry } from "@/version/changelog";
import { useReleaseNotesTabStore } from "./notes-tab";
import { useUpdateDescription } from "./stage-message";
import { useUpdateStore, type UpdateStage } from "./store";

/**
 * Resolve content to display. Shows both EN and ZH when both exist,
 * ordered by the active UI language (zh / zh-TW get Chinese first).
 */
function resolveChangelogContent(
  entry: ChangelogEntry,
  language?: string,
): { lang: "zh" | "en"; text: string }[] {
  const parts = [
    { lang: "zh" as const, text: entry.content.zh },
    { lang: "en" as const, text: entry.content.en },
  ].filter((part) => part.text);
  return (language ?? "").toLowerCase().startsWith("zh") ? parts : parts.reverse();
}

/** One local release-notes markdown body in the app's prose mapping. */
function ChangelogMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h4 className="pt-1 pb-1 text-body-medium text-text-primary">{children}</h4>
        ),
        p: ({ children }) => <p className="py-0.5 text-body-regular text-text-primary">{children}</p>,
        ul: ({ children }) => (
          <ul className="flex list-disc flex-col gap-1 py-1 pl-5 text-body-regular text-text-primary marker:text-text-tertiary">
            {children}
          </ul>
        ),
        li: ({ children }) => <li className="pl-0.5">{children}</li>,
        strong: ({ children }) => (
          <strong className="font-semibold text-text-primary">{children}</strong>
        ),
        code: ({ children }) => (
          <code className="rounded-sm bg-background-tertiary-default px-1 py-0.5 font-mono text-[0.85em] text-text-primary">
            {children}
          </code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** 本地版本记录里与 `version` 同名的条目；没有版本号（手动打开页签）时取最新
 *  一条，读到的就是最近一次发布的说明。有版本号但没有对应条目时不回落到
 *  别的版本——不能把 v1.0.7 的说明挂在 v1.0.8 的标题下。 */
function localEntryFor(version?: string): ChangelogEntry | undefined {
  return version ? changelogEntryFor(version) : CHANGELOG_DATA[0];
}

/**
 * 版本更新页签（中心面，单实例）：本地 `CHANGELOG_DATA` 的版本说明（双语按
 * 当前语言排序），没有对应条目时显示「该版本未附带说明」。
 *
 * 升级后首启（`upgrade-announcement.ts`）会宣布一次本地记录的版本说明，并在
 * 未读期间给页签圆点与页头的「新版本」标记，版本号来自页签 store 的
 * `unreadVersion`。
 *
 * 页头可就地「检查更新」（结果行复用设置页同一份文案，见
 * `useUpdateDescription`）；下载与安装由 Hub 自更新在后台完成。
 */
/** Pane header: title, announced version/date and the check action. */
function ReleaseHeader({
  displayVersion,
  displayDate,
  unread,
  stage,
  checkFeedback,
  onCheck,
}: {
  displayVersion: string | undefined;
  displayDate: string | undefined;
  /** 升级后首启的未读标记：版本号旁挂「新版本」。 */
  unread: boolean;
  stage: UpdateStage;
  checkFeedback: ActionFeedback;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-separator-border px-4">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="shrink-0 text-title-3-medium text-text-primary">{t("changelog.title")}</h1>
        {displayVersion && (
          <span className="shrink-0 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium text-text-secondary">
            v{displayVersion}
          </span>
        )}
        {unread && (
          <span className="shrink-0 rounded-full bg-pill-tab-blue-selected-background px-2 py-0.5 text-caption-1-medium text-accent-500">
            {t("changelog.newVersion")}
          </span>
        )}
        {displayDate && (
          <span className="shrink-0 text-caption-1-regular text-text-tertiary">{displayDate}</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="small"
          variant="secondary"
          disabled={stage === "checking"}
          onClick={onCheck}
        >
          <span className="flex items-center gap-1.5">
            <ActionFeedbackIcon
              icon={RefreshCcw}
              feedback={checkFeedback}
              spin
              iconClassName="size-3.5"
            />
            {t("settings.checkUpdates")}
          </span>
        </Button>
      </div>
    </div>
  );
}

/** Check/download result line; 检查中转圈由按钮承担，这里只给文字结果。 */
function ReleaseDescription({
  description,
  failed,
}: {
  description: string | undefined;
  failed: boolean;
}) {
  if (!description) return null;
  return (
    <div
      role={failed ? "alert" : undefined}
      className={cx(
        "flex shrink-0 items-start gap-2 border-b border-separator-border px-4 py-2 text-body-2-medium",
        failed ? "text-text-error-primary" : "text-text-secondary",
      )}
    >
      {failed ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <span className="min-w-0">{description}</span>
    </div>
  );
}

/** Release-notes body: bilingual local entry, or the empty copy. */
function ReleaseBody({ parts }: { parts: { lang: "zh" | "en"; text: string }[] }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-4">
        {parts.length > 0 ? (
          parts.map((part, idx) => (
            <div
              key={part.lang}
              className={cx(idx > 0 && "border-t border-separator-border pt-3")}
            >
              <ChangelogMarkdown text={part.text} />
            </div>
          ))
        ) : (
          <p className="text-body-regular text-text-secondary">
            {t("settings.updateNotesEmpty")}
          </p>
        )}
      </div>
    </div>
  );
}

export function ReleaseNotesPane() {
  const { i18n } = useTranslation();
  const stage = useUpdateStore((s) => s.stage);
  const version = useUpdateStore((s) => s.version);
  const unreadVersion = useReleaseNotesTabStore((s) => s.unreadVersion);
  const error = useUpdateStore((s) => s.error);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  // 检查更新是刷新型动作：转圈 → 对号（§4.1）。检查失败（stage error）不出
  // 对号，失败信息由结果行用 role="alert" 说明。
  const checkAction = useActionFeedback({ spin: true });

  // 页签标题上的版本：升级后首启宣布的未读版本，否则是本地最新条目。
  const local = useMemo(() => localEntryFor(unreadVersion), [unreadVersion]);
  const displayVersion = unreadVersion ?? local?.version;
  const displayDate = local?.date;
  const parts = local ? resolveChangelogContent(local, i18n.language) : [];
  const description = useUpdateDescription({ stage, version, error });
  const failed = stage === "error";

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background-primary-default">
      <ReleaseHeader
        displayVersion={displayVersion}
        displayDate={displayDate}
        unread={unreadVersion !== undefined}
        stage={stage}
        checkFeedback={checkAction.feedback}
        onCheck={() =>
          void checkAction.start(
            () => checkForUpdates(),
            // 非抛错型动作把失败写进 store（store.ts 的 error 分支）。
            () => useUpdateStore.getState().stage === "error",
          )
        }
      />
      <ReleaseDescription description={description} failed={failed} />
      <ReleaseBody parts={parts} />
    </div>
  );
}
