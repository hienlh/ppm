/**
 * A task's page on a phone (variant-3 screen 03): the split becomes a push. Top bar: back (to the
 * Tasks list in the navigation drawer, this task still selected), project, number, ···. Tabs
 * Details / Activity (its count, and a dot when something changed while the user was away). The
 * bottom bar — the thumb zone — holds the status button (the project's statuses in a sheet) and
 * Done (Reopen once closed). Every edit goes through `useTaskWrite`, which keeps the tab and
 * offers "Tell the manager now?" as a bottom sheet.
 */
import { useCallback, useState } from "react";
import { ArrowLeft, Check, ChevronDown, MoreHorizontal, RotateCcw } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useManagerChats } from "@/hooks/use-manager-chats";
import { usePpmTaskHistory } from "@/hooks/use-ppm-tasks";
import { askManagerAboutTask, managerOf } from "@/lib/ppm-tasks/ask-manager-about-task";
import { openTaskChat, openTaskTab, workingProvider } from "@/lib/ppm-tasks/open-task-tab";
import { revealTaskInSidebar } from "@/lib/ppm-tasks/reveal-task-in-sidebar";
import type { TaskPatch } from "../../../../shared/ppm-tasks";
import type { TaskDetailViewProps } from "../task-detail-desktop";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { TaskHistoryTimeline } from "../task-history-timeline";
import { TaskNewDialog } from "../task-new-dialog";
import { TaskProjectSettingsDialog } from "../settings/task-project-settings-dialog";
import { TaskManagerPromptHost } from "../task-manager-prompt-toast";
import { useTaskConfirm } from "../task-confirm-dialog";
import { useTaskWrite } from "../use-task-write";
import { TaskDetailMobileDetails } from "./task-detail-mobile-details";
import { TaskFieldEditorSheet, type TaskSheetKind } from "./task-field-editor-sheet";
import { changeTaskStatus } from "./task-status-change";

const NO_PROJECTS: never[] = [];
const AWAY_NOTICE_MS = 24 * 3_600_000;
const TAB = "relative inline-flex h-11 flex-1 items-center justify-center gap-1.5 border-b-2 text-[15px]";

export function TaskDetailMobile({ detail, settings }: TaskDetailViewProps) {
  const { task, children } = detail;
  const [tab, setTab] = useState<"details" | "activity">("details");
  const [sheet, setSheet] = useState<TaskSheetKind | null>(null);
  const [childOpen, setChildOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [confirm, confirmElement] = useTaskConfirm();
  const write = useTaskWrite(confirm);
  const { actions, run } = write;
  const managers = useManagerChats();
  const history = usePpmTaskHistory(task.id, "all");
  // Recent unattended changes: older ones keep their badge in Activity, without the Details notice.
  const away = history.items.filter((e) => e.unattended && e.undoneBy === null && e.at > Date.now() - AWAY_NOTICE_MS).length;
  const closed = task.baseGroup === "closed";

  const patch = useCallback((p: TaskPatch & { decision?: { question?: string | null; options: string[] } }) =>
    void run(task.id, () => actions.update(task, p)), [actions, run, task]);
  const openChat = useCallback((sid: string) => openTaskChat(task.project, sid, workingProvider(task)), [task]);
  // The working chat is often the manager chat, busy with many tasks: it opens with this one as a chip.
  const openWorkingChat = useCallback((sid: string) => openTaskChat(task.project, sid, workingProvider(task), task), [task]);
  const startChat = useCallback(() => void write.startChat(task), [task, write]);

  return (
    <div className="flex h-full flex-col bg-background" data-task-detail={task.id} data-task-detail-mobile="">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border-soft bg-panel px-1">
        <button type="button" aria-label="Back to tasks" onClick={() => revealTaskInSidebar(task, { openList: true })}
          className="grid size-11 place-items-center rounded-full text-text-2 active:bg-surface-hover"><ArrowLeft className="size-5" /></button>
        <span className="max-w-[45%] truncate rounded bg-surface px-1.5 text-[13px] font-medium text-text">{task.project}</span>
        <span className="shrink-0 font-mono text-xs text-text-3">· {task.number}</span>
        <span className="flex-1" />
        <button type="button" aria-label="Task actions" onClick={() => setSheet("more")}
          className="grid size-11 place-items-center rounded-full text-text-2 active:bg-surface-hover"><MoreHorizontal className="size-5" /></button>
      </header>
      <div role="tablist" aria-label="Task" className="flex shrink-0 border-b border-border-soft bg-panel">
        <button type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}
          className={cn(TAB, tab === "details" ? "border-primary font-medium text-text" : "border-transparent text-text-2")}>Details</button>
        <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}
          aria-label={`Activity, ${history.items.length} entries${away ? `, ${away} while you were away` : ""}`}
          className={cn(TAB, tab === "activity" ? "border-primary font-medium text-text" : "border-transparent text-text-2")}>
          Activity
          <span className="rounded bg-surface px-1.5 font-mono text-[11px] text-text-3">{history.items.length}</span>
          {away > 0 && <span aria-hidden data-task-away-dot="" className="size-2 rounded-full bg-warning" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === "details" ? (
          <TaskDetailMobileDetails detail={detail} settings={settings} deciding={deciding} awayChanges={away}
            onPatch={patch} onOpenChat={openChat} onOpenWorkingChat={openWorkingChat} onStartChat={startChat} onSheet={setSheet} onShowActivity={() => setTab("activity")}
            onDecide={(optionId) => { setDeciding(true); void write.decide(task, optionId).finally(() => setDeciding(false)); }}
            onAddLink={async (link) => !!(await run(task.id, () => actions.addLink(task, link)))}
            onRemoveLink={(link) => void run(task.id, () => actions.removeLink(task, link))} />
        ) : (
          <div className="px-3 py-3">
            <TaskHistoryTimeline taskId={task.id} variant="phone" names={{ statuses: settings?.statuses, members: settings?.members }}
              onUndo={async (e) => { await run(task.id, () => actions.undo(task.id, e.id)); }} />
          </div>
        )}
      </div>
      <footer className="flex shrink-0 gap-2 border-t border-border-soft bg-panel px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button type="button" onClick={() => setSheet("status")} aria-label={`Status: ${task.statusName}. Change`} data-task-status-button=""
          className="flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-panel px-3 text-[15px] text-text active:bg-surface-hover">
          <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} size="lg" />
          <span className="min-w-0 truncate">{task.statusName}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-text-3" />
        </button>
        {closed ? (
          <button type="button" onClick={() => void run(task.id, () => actions.reopen(task))}
            className="flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl border border-primary px-3 text-[15px] font-medium text-primary">
            <RotateCcw className="size-4" />Reopen
          </button>
        ) : (
          <button type="button" onClick={() => void run(task.id, () => actions.close(task, { closedAs: "done" }))} data-task-mark-done=""
            className="flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-3 text-[15px] font-medium text-primary-foreground active:bg-primary/90">
            <Check className="size-[18px]" />Done
          </button>
        )}
      </footer>
      <TaskFieldEditorSheet kind={sheet} task={task} childTasks={children} settings={settings} hasManager={!!managerOf(task.project, managers)}
        onClose={() => setSheet(null)} onPatch={patch} onStatus={(id) => changeTaskStatus(write, task, id, settings?.statuses)}
        onOpenTask={(t) => openTaskTab(t, { keep: true })} onAddChild={() => setChildOpen(true)} onManageFields={() => setFieldsOpen(true)}
        onAskManager={() => void askManagerAboutTask(task, managers)} onStartChat={startChat} />
      <TaskNewDialog open={childOpen} onOpenChange={setChildOpen} scope="project" project={task.project} projects={NO_PROJECTS}
        parent={task} onCreated={(c) => openTaskTab(c, { keep: true })} />
      <TaskProjectSettingsDialog open={fieldsOpen} onOpenChange={setFieldsOpen} project={task.project} initialSection="fields" />
      {confirmElement}
      <TaskManagerPromptHost />
    </div>
  );
}
