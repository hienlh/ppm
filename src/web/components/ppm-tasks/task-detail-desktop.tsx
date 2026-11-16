/**
 * A task's page on a desktop (variant-3 screen 02): content and history on the left, the working
 * session and every property on the right. Below 760px of its own width (an ~800px floating
 * window, a narrow split) the two columns stack, so nothing overflows sideways. Every edit goes
 * through `useTaskWrite`, which keeps the preview tab and offers "Tell the manager now?".
 */
import { useCallback, useState } from "react";
import { useManagerChats } from "@/hooks/use-manager-chats";
import { askManagerAboutTask, managerOf } from "@/lib/ppm-tasks/ask-manager-about-task";
import { openTaskChat, openTaskTab, workingProvider } from "@/lib/ppm-tasks/open-task-tab";
import type { TaskPatch } from "../../../shared/ppm-tasks";
import type { TaskDetailResponse, TaskProjectSettings } from "../../../shared/ppm-tasks-api";
import { TaskDetailHeader } from "./task-detail-header";
import { TaskResultCard } from "./task-result-card";
import { TaskNotesCard } from "./task-notes-card";
import { TaskDecisionCard } from "./task-decision-card";
import { TaskLinksCard } from "./task-links-card";
import { TaskChildrenCard } from "./task-children-card";
import { TaskHistoryTimeline } from "./task-history-timeline";
import { TaskPropertiesPanel } from "./task-properties-panel";
import { TaskWorkingSessionBlock } from "./task-working-session-block";
import { TaskNewDialog } from "./task-new-dialog";
import { TaskProjectSettingsDialog } from "./settings/task-project-settings-dialog";
import { TaskManagerPromptHost } from "./task-manager-prompt-toast";
import { useTaskConfirm } from "./task-confirm-dialog";
import { useTaskWrite } from "./use-task-write";

/** A write's fields, the decision's options included. */
type TaskEdit = TaskPatch & { decision?: { question?: string | null; options: string[] } };

/** What the task tab hands to the page it renders (the desktop page now; P6 adds the phone page). */
export interface TaskDetailViewProps {
  detail: TaskDetailResponse;
  settings: TaskProjectSettings | null;
  /** The tab still shows the task as a preview (replaced by the next selection). */
  preview: boolean;
}

export function TaskDetailDesktop({ detail, settings, preview }: TaskDetailViewProps) {
  const { task, children, linkStates } = detail;
  const [confirm, confirmElement] = useTaskConfirm();
  const write = useTaskWrite(confirm);
  const managers = useManagerChats();
  const [childOpen, setChildOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const { actions, run } = write;

  const patch = useCallback((p: TaskEdit) => void run(task.id, () => actions.update(task, p)), [actions, run, task]);
  const setStatus = useCallback((statusId: string) => {
    if (statusId === task.statusId) return;
    const target = settings?.statuses.find((s) => s.id === statusId);
    if (target?.baseGroup === "closed") void run(task.id, () => actions.close(task, { statusId }));
    else if (task.baseGroup === "closed") void run(task.id, () => actions.reopen(task, statusId));
    else patch({ statusId });
  }, [actions, patch, run, settings, task]);
  const openChat = useCallback((sid: string) => openTaskChat(task.project, sid, workingProvider(task)), [task]);

  return (
    <div className="@container h-full bg-background" data-task-detail={task.id}>
      <div className="h-full overflow-y-auto @[760px]:grid @[760px]:grid-cols-[minmax(0,1fr)_300px] @[760px]:overflow-hidden">
        <main className="min-w-0 space-y-3 px-5 py-4 @[760px]:overflow-y-auto">
          <TaskDetailHeader task={task} members={settings?.members} preview={preview} hasManager={!!managerOf(task.project, managers)}
            onRename={(title) => patch({ title })} onAskManager={() => void askManagerAboutTask(task, managers)}
            onMarkDone={() => void run(task.id, () => actions.close(task, { closedAs: "done" }))}
            onReopen={() => void run(task.id, () => actions.reopen(task))} />
          {(task.type === "decision" || task.decision) && (
            <TaskDecisionCard task={task} busy={deciding}
              onChoose={(optionId) => { setDeciding(true); void write.decide(task, optionId).finally(() => setDeciding(false)); }}
              onEditOptions={(decision) => patch({ decision })} />
          )}
          <TaskResultCard task={task} onSave={(result) => patch({ result })} />
          <TaskNotesCard task={task} onSave={patch} />
          <TaskLinksCard task={task} linkStates={linkStates} onOpenChat={openChat}
            onAdd={async (link) => !!(await run(task.id, () => actions.addLink(task, link)))}
            onRemove={(link) => void run(task.id, () => actions.removeLink(task, link))} />
          <TaskChildrenCard children={children} members={settings?.members} onOpen={(c) => openTaskTab(c)} onAdd={() => setChildOpen(true)} />
          <TaskHistoryTimeline taskId={task.id} names={{ statuses: settings?.statuses, members: settings?.members }}
            onUndo={async (e) => { await run(task.id, () => actions.undo(task.id, e.id)); }} />
        </main>
        <aside className="space-y-4 border-t border-border-soft bg-panel px-4 py-4 @[760px]:overflow-y-auto @[760px]:border-l @[760px]:border-t-0">
          <TaskWorkingSessionBlock working={task.workingSession} check={task.check} onOpen={openChat} onStartChat={() => void write.startChat(task)} />
          <TaskPropertiesPanel task={task} settings={settings} onPatch={patch} onStatus={setStatus}
            onOpenTask={(id) => openTaskTab({ id, project: task.project, title: "Task" })} onManageFields={() => setFieldsOpen(true)} />
        </aside>
      </div>
      <TaskNewDialog open={childOpen} onOpenChange={setChildOpen} scope="project" project={task.project} projects={[]}
        parent={task} onCreated={(c) => openTaskTab(c, { keep: true })} />
      <TaskProjectSettingsDialog open={fieldsOpen} onOpenChange={setFieldsOpen} project={task.project} initialSection="fields" />
      {confirmElement}
      <TaskManagerPromptHost />
    </div>
  );
}
