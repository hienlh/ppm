/**
 * The bottom sheets a phone task page opens from its rows and buttons: the project's statuses (the
 * bottom bar's status button), every property (assignee, waiting on, urgency, due, fields…), the
 * result, the child tasks, and ··· (Copy link, Ask manager, Start a new chat). The property editor
 * is the desktop's own panel with its fields grown to 44px, so both stay one implementation.
 */
import type { ReactNode } from "react";
import { Link, MessageSquare, Plus } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { PPM_TASK_LIMITS, type TaskPatch } from "../../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSettings } from "../../../../shared/ppm-tasks-api";
import { copyTaskLink } from "@/lib/ppm-tasks/open-task-tab";
import { PlainTextEditor } from "../task-card";
import { TaskPropertiesPanel } from "../task-properties-panel";
import { TaskChildrenCard } from "../task-children-card";
import { TaskStatusGrid } from "./task-status-grid";

export type TaskSheetKind = "status" | "properties" | "result" | "children" | "more";

export interface TaskFieldEditorSheetProps {
  kind: TaskSheetKind | null;
  task: TaskDto;
  childTasks: readonly TaskDto[];
  settings: TaskProjectSettings | null;
  hasManager: boolean;
  onClose(): void;
  onStatus(statusId: string): void;
  onPatch(patch: TaskPatch): unknown;
  onOpenTask(task: Pick<TaskDto, "id" | "project" | "title">): void;
  onAddChild(): void;
  onManageFields(): void;
  onAskManager(): void;
  onStartChat(): void;
}

const TITLES: Record<TaskSheetKind, string> = {
  status: "Status", properties: "Properties", result: "Result", children: "Child tasks", more: "Task actions",
};

const ACTION = "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-text active:bg-surface-hover [&_svg]:size-[18px] [&_svg]:text-text-3";

/** Grows the desktop panel's 28px selects, inputs and buttons to thumb size. */
const THUMB_FIELDS = "[&_select]:h-11 [&_select]:text-[15px] [&_input]:h-11 [&_input]:text-[15px] [&_button]:min-h-11";

function Body({ kind, p, close }: { kind: TaskSheetKind; p: TaskFieldEditorSheetProps; close(then?: () => void): void }): ReactNode {
  const { task } = p;
  switch (kind) {
    case "status":
      return <TaskStatusGrid project={task.project} statuses={p.settings?.statuses ?? []} currentId={task.statusId}
        onPick={(id) => close(() => p.onStatus(id))} />;
    case "properties":
      return (
        <div className={THUMB_FIELDS}>
          <TaskPropertiesPanel task={task} settings={p.settings} onPatch={p.onPatch} onStatus={p.onStatus}
            onOpenTask={(id) => close(() => p.onOpenTask({ id, project: task.project, title: "Task" }))}
            onManageFields={() => close(p.onManageFields)} />
        </div>
      );
    case "result":
      return (
        <PlainTextEditor value={task.result?.text ?? ""} label="Result" placeholder="What the work came to" rows={5} maxLength={PPM_TASK_LIMITS.result}
          onCancel={() => close()}
          onSave={(v) => close(() => { const text = v.trim(); if (text !== (task.result?.text ?? "")) p.onPatch({ result: text ? { text } : null }); })} />
      );
    case "children":
      return <div className="[&_li_button]:min-h-11"><TaskChildrenCard children={p.childTasks} members={p.settings?.members}
        onOpen={(c) => close(() => p.onOpenTask(c))} onAdd={() => close(p.onAddChild)} /></div>;
    case "more":
      return (
        <div className="-mx-1">
          <button type="button" className={ACTION} onClick={() => close(() => void copyTaskLink(task))}><Link />Copy link</button>
          {p.hasManager && <button type="button" className={ACTION} onClick={() => close(p.onAskManager)}><MessageSquare />Ask manager about this</button>}
          <button type="button" className={ACTION} onClick={() => close(p.onStartChat)}><Plus />Start a new chat for this task</button>
        </div>
      );
  }
}

export function TaskFieldEditorSheet(p: TaskFieldEditorSheetProps) {
  const close = (then?: () => void) => { p.onClose(); then?.(); };
  return (
    <BottomSheet open={!!p.kind} onClose={p.onClose} className="flex max-h-[88%] flex-col">
      {p.kind && (
        <div role="dialog" aria-label={TITLES[p.kind]} data-task-sheet={p.kind} className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 px-4 pb-2 text-[15px] font-semibold text-text">{TITLES[p.kind]}</p>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
            <Body kind={p.kind} p={p} close={close} />
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
