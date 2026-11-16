/**
 * A task's history (variant-3 screen 02), shared with the phone's Activity tab (P6, `variant`
 * "phone": 28px avatars, 40px Undo buttons). Tabs History / AI changes / Status only; each row
 * says who did what, when and from where, with "AI change" on rows an AI wrote, Undo on the ones
 * that can still be undone, struck through once undone, and "while you were away" on rows written
 * in an unattended Assistant turn. A note says how long detail and undo last.
 */
import { useState } from "react";
import { History, Info, Undo2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePpmTaskHistory } from "@/hooks/use-ppm-tasks";
import { entryText, isAiEntry, viaText, type HistoryNames } from "@/lib/ppm-tasks/task-history-text";
import { whenShort } from "@/lib/ppm-tasks/task-format";
import { HISTORY_DETAIL_DAYS } from "../../../shared/ppm-tasks";
import type { TaskHistoryFilter, TaskHistoryItem } from "../../../shared/ppm-tasks-api";
import { TaskMemberAvatar } from "./kit/task-member-avatar";
import { TaskUnattendedBadge } from "./kit/task-unattended-badge";

const TABS: Array<{ id: TaskHistoryFilter; label: string }> = [
  { id: "all", label: "History" }, { id: "ai", label: "AI changes" }, { id: "status", label: "Status only" },
];

export interface TaskHistoryTimelineProps {
  taskId: string;
  names: HistoryNames;
  variant?: "desktop" | "phone";
  /** Undoes one AI change; answers when done (the list re-reads on the change event). */
  onUndo(entry: TaskHistoryItem): Promise<void> | void;
}

export function TaskHistoryRow({ entry, names, phone, onUndo, undoing }: {
  entry: TaskHistoryItem; names: HistoryNames; phone: boolean; onUndo(): void; undoing: boolean;
}) {
  const ai = isAiEntry(entry);
  const undone = entry.undoneBy !== null;
  const via = viaText(entry);
  return (
    <li className="flex gap-2.5 py-2" data-history-id={entry.id} data-undone={undone || undefined}>
      <TaskMemberAvatar name={entry.actor.label} memberId={entry.actor.kind === "user" ? "me" : entry.actor.label} ai={ai} size={phone ? "lg" : "md"} />
      <div className="min-w-0 flex-1">
        <p className={cn("break-words text-[13px] text-text", undone && "text-text-3 line-through")}>
          <b className="font-semibold">{entry.actor.label}</b> {entryText(entry, names)}
        </p>
        {entry.reason && <p className="mt-0.5 break-words text-xs text-text-2">“{entry.reason}”</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-3">
          <span>{whenShort(entry.at)}</span>
          {via && <span>{via}</span>}
          {ai && !undone && <span className="rounded bg-accent-2/12 px-1.5 text-[10.5px] font-semibold text-accent-2">AI change</span>}
          {undone && <span>undone</span>}
          {entry.unattended && <TaskUnattendedBadge />}
        </p>
      </div>
      {entry.undoable && (
        <Button size="sm" variant="outline" disabled={undoing} onClick={onUndo} className={cn("shrink-0 self-start text-primary", phone && "h-10")}
          aria-label={`Undo: ${entry.actor.label} ${entryText(entry, names)}`}>
          <Undo2 className="size-3.5" />Undo
        </Button>
      )}
    </li>
  );
}

export function TaskHistoryTimeline({ taskId, names, variant = "desktop", onUndo }: TaskHistoryTimelineProps) {
  const [filter, setFilter] = useState<TaskHistoryFilter>("all");
  const { items, loading, error } = usePpmTaskHistory(taskId, filter);
  const ai = usePpmTaskHistory(taskId, "ai");
  const [undoing, setUndoing] = useState<number | null>(null);
  const phone = variant === "phone";
  const undo = async (e: TaskHistoryItem) => {
    setUndoing(e.id);
    try { await onUndo(e); } finally { setUndoing(null); }
  };
  return (
    <section className="overflow-hidden rounded-lg border border-border-soft bg-panel" data-task-card="history">
      <div role="tablist" className="flex items-center gap-1 border-b border-border-soft px-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={filter === t.id} onClick={() => setFilter(t.id)}
            className={cn("-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2 text-[13px]",
              filter === t.id ? "border-primary font-medium text-text" : "border-transparent text-text-2 hover:text-text")}>
            {t.id === "all" && <History aria-hidden className="size-3.5" />}
            {t.label}
            {t.id === "ai" && ai.items.length > 0 && <span className="rounded bg-surface px-1.5 font-mono text-[10.5px] text-text-3">{ai.items.length}</span>}
          </button>
        ))}
      </div>
      <div className="px-3">
        {error && <p className="py-3 text-xs text-error">{error}</p>}
        {!error && loading && items.length === 0 && <p className="py-3 text-xs text-text-3">Loading history…</p>}
        {!error && !loading && items.length === 0 && <p className="py-3 text-xs text-text-3">Nothing here yet.</p>}
        <ol className="divide-y divide-border-soft">
          {items.map((e) => <TaskHistoryRow key={e.id} entry={e} names={names} phone={phone} undoing={undoing === e.id} onUndo={() => void undo(e)} />)}
        </ol>
        <p className="flex gap-1.5 border-t border-border-soft py-2.5 text-[11.5px] text-text-3">
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          Full detail is kept for {HISTORY_DETAIL_DAYS} days and AI changes can be undone in that time. After that only created, status changes and closed remain.
        </p>
      </div>
    </section>
  );
}
