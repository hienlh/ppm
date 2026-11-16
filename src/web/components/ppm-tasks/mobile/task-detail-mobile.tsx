/**
 * A task's page on a phone (variant-3 screen 03): the split becomes a push. Top bar: back (to the
 * Tasks list in the navigation drawer, this task still selected), project, number, ···. Tabs
 * Details / Activity (its count, and a dot when something changed while the user was away). The
 * bottom bar — the thumb zone — holds the status button (the project's statuses in a sheet) and
 * Done (Reopen once closed). Every edit goes through `useTaskWrite`, which keeps the tab and
 * offers "Tell the manager now?" as a bottom sheet.
 */
import { useCallback, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Maximize2, MoreHorizontal, RotateCcw, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useManagerChats } from "@/hooks/use-manager-chats";
import { usePpmTaskHistory } from "@/hooks/use-ppm-tasks";
import { askManagerAboutTask, managerOf } from "@/lib/ppm-tasks/ask-manager-about-task";
import { openTaskChat, workingProvider } from "@/lib/ppm-tasks/open-task-tab";
import { openTask } from "@/lib/ppm-tasks/open-task";
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
import { TaskCode } from "../kit/task-code";

const NO_PROJECTS: never[] = [];
const AWAY_NOTICE_MS = 24 * 3_600_000;
const TAB = "relative inline-flex h-11 flex-1 items-center justify-center gap-1.5 border-b-2 text-[15px]";

export function TaskDetailMobile({ detail, settings, sheet: inSheet }: TaskDetailViewProps) {
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
  // In the sheet, a chat the page opens shows behind it: the sheet (and the drawer) go first.
  const leave = inSheet?.onLeave;
  const openChat = useCallback((sid: string) => { leave?.(); openTaskChat(task.project, sid, workingProvider(task)); }, [task, leave]);
  // The working chat is often the manager chat, busy with many tasks: it opens with this one as a chip.
  const openWorkingChat = useCallback((sid: string) => { leave?.(); openTaskChat(task.project, sid, workingProvider(task), task); }, [task, leave]);
  // Start chat may ask first (the page's own dialog), so the sheet goes only once a chat opened.
  const startChat = useCallback(() => void write.startChat(task).then((sid) => { if (sid) leave?.(); }), [task, write, leave]);
  // Without a manager chat nothing opens (a toast says so): the sheet stays.
  const askManager = useCallback(() => { if (managerOf(task.project, managers)) leave?.(); void askManagerAboutTask(task, managers); }, [task, managers, leave]);

  return (
    <div className="flex h-full flex-col bg-background" data-task-detail={task.id} data-task-detail-mobile="">
      <header className={cn("flex h-12 shrink-0 items-center gap-1 border-b border-border-soft bg-panel px-1", inSheet && "pl-3")}>
        {!inSheet && (
          <button type="button" aria-label="Back to tasks" onClick={() => revealTaskInSidebar(task, { openList: true })}
            className="grid size-11 place-items-center rounded-full text-text-2 active:bg-surface-hover"><ArrowLeft className="size-5" /></button>
        )}
        <span data-task-code-pair="" className="flex min-w-0 max-w-[60%] items-baseline gap-1">
          <span data-task-code-title="" className="min-w-0 truncate rounded bg-surface px-1.5 text-[13px] font-medium text-text">{task.project}</span>
          <span aria-hidden className="shrink-0 text-xs text-text-3">/</span>
          <TaskCode task={task} viewProject={task.project} className="text-[13px]" />
        </span>
        <span className="flex-1" />
        {inSheet && (
          // Sized to the chat footer's row: a button with text 26px, an icon button 22px.
          <button type="button" data-task-sheet-full-screen="" onClick={inSheet.onExpand}
            className="inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border-soft bg-panel-2 px-[5px] text-[11.5px] text-text-2 active:bg-surface-hover [&_svg]:size-3.5">
            <Maximize2 aria-hidden />Full screen
          </button>
        )}
        {/* In the sheet ··· is the chip row's icon button, the size of × beside it (22 px). */}
        <button type="button" aria-label="Task actions" data-task-actions="" onClick={() => setSheet("more")}
          className={inSheet
            ? "inline-flex h-[22px] min-w-[24px] shrink-0 items-center justify-center rounded-full text-text-2 active:bg-surface-hover [&_svg]:size-3.5"
            : "grid size-11 place-items-center rounded-full text-text-2 active:bg-surface-hover"}><MoreHorizontal className={inSheet ? undefined : "size-5"} /></button>
        {inSheet && (
          <button type="button" aria-label="Close" data-task-sheet-close="" onClick={inSheet.onClose}
            className="mr-1 inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full text-text-2 active:bg-surface-hover [&_svg]:size-3.5">
            <X aria-hidden />
          </button>
        )}
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
      {/* In the sheet the sheet's own padding already clears the home indicator. */}
      <footer className={cn("flex shrink-0 gap-2 border-t border-border-soft bg-panel px-3 pt-2", inSheet ? "pb-1" : "pb-[max(0.5rem,env(safe-area-inset-bottom))]")}>
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
        onOpenTask={(t) => openTask(t, { keep: true })} onAddChild={() => setChildOpen(true)} onManageFields={() => setFieldsOpen(true)}
        onAskManager={askManager} onStartChat={startChat} />
      <TaskNewDialog open={childOpen} onOpenChange={setChildOpen} scope="project" project={task.project} projects={NO_PROJECTS}
        parent={task} onCreated={(c) => openTask(c, { keep: true })} />
      <TaskProjectSettingsDialog open={fieldsOpen} onOpenChange={setFieldsOpen} project={task.project} initialSection="fields" />
      {confirmElement}
      <TaskManagerPromptHost />
    </div>
  );
}
