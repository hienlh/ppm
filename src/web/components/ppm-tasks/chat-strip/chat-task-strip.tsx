/**
 * The strip at the top of a chat that works on tasks (a task names it as its working session):
 * "#12 Fix login", its status, on whom it waits and until when, its due date and its snooze — the
 * same labels the task lists use. A press opens the task's quick view (`TaskChipPeek`: a popover
 * under the strip on a desktop, a bottom sheet on a phone), which edits the usual fields in place.
 * A chat working on several tasks shows the first in "what to do first" order and "+N", which
 * lists them all; a row there opens that task's quick view.
 *
 * One line at every width: the title gives way first, then the status words and the due date
 * (container queries on the chat's own width, which a split panel or a design window decides).
 * Controls are the standard 28px (26px on a phone); see `control-size.ts`.
 */
import { useRef, useState } from "react";
import { ListTodo } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { usePpmTaskList } from "@/hooks/use-ppm-tasks";
import type { TaskTabTarget } from "@/lib/ppm-tasks/open-task-tab";
import { chatTaskStripLabel, chatTaskStripView, chatTasksQuery } from "@/lib/ppm-tasks/chat-task-strip-logic";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { FooterPopover } from "@/components/chat/footer-popover";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { TaskCode } from "../kit/task-code";
import { TaskChipPeek } from "../peek/task-chip-peek";
import { ChatTaskStripList } from "./chat-task-strip-list";
import { ChatTaskStripMeta } from "./chat-task-strip-meta";

const targetOf = (t: TaskDto): TaskTabTarget => ({ id: t.id, project: t.project, title: t.title, number: t.number });

/** The strip for the chat `sessionId`, or nothing when it works on no open task. */
export function ChatTaskStrip({ sessionId, projectName }: { sessionId: string; projectName: string | null }) {
  const { tasks } = usePpmTaskList(chatTasksQuery(sessionId));
  const view = chatTaskStripView(tasks, sessionId);
  const [peek, setPeek] = useState<TaskTabTarget | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const mainRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  if (!view) return null;
  const t = view.primary;
  // Anchored where it was opened from: the strip's task, or "+N" for a task picked from the list.
  const anchorRef = peek && peek.id !== t.id && view.extra > 0 ? moreRef : mainRef;
  return (
    // `max-md:pr-10`: on a phone the app's BETA ribbon sits in the top-right 40px square (app.tsx).
    <div className="relative shrink-0 border-b border-border px-2 py-1 max-md:pr-10 md:px-3" data-chat-task-strip={t.id} data-chat-task-strip-count={view.all.length}
      role="region" aria-label={chatTaskStripLabel(view)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <button ref={mainRef} type="button" onClick={() => setPeek((p) => (p?.id === t.id ? null : targetOf(t)))}
          aria-haspopup="dialog" aria-expanded={peek?.id === t.id} title={`Show #${t.number} ${t.title}`} data-chat-task-strip-open=""
          className={cn(TEXT_CONTROL_HEIGHT,
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-xs can-hover:hover:bg-surface-hover aria-expanded:bg-accent-wash max-md:gap-1.5 max-md:px-1")}>
          <ListTodo aria-hidden className="size-3.5 shrink-0 text-text-3 max-md:hidden" />
          <TaskStatusGlyph baseGroup={t.baseGroup} closedAs={t.closedAs} name={t.statusName} className="shrink-0" />
          <span className="flex min-w-0 flex-1 items-baseline gap-1">
            <TaskCode task={t} viewProject={projectName} nested inRow className="text-[11.5px]" />
            <span data-chat-task-strip-title="" className="min-w-0 truncate text-[12.5px] text-text">{t.title}</span>
          </span>
          <ChatTaskStripMeta task={t} />
        </button>
        {view.extra > 0 && (
          <button ref={moreRef} type="button" onClick={() => setListOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={listOpen}
            aria-label={`${view.extra} more ${view.extra === 1 ? "task" : "tasks"} this chat works on`} data-chat-task-strip-more=""
            className={cn(TEXT_CONTROL_HEIGHT,
              "inline-flex shrink-0 items-center rounded-full border border-border-soft bg-panel-2 px-2 font-mono text-[11px] text-text-2 can-hover:hover:border-border can-hover:hover:text-text aria-expanded:border-accent-wash-border aria-expanded:bg-accent-wash")}>
            +{view.extra}
          </button>
        )}
      </div>
      {view.extra > 0 && (
        <FooterPopover open={listOpen} onClose={() => setListOpen(false)} label="Tasks this chat works on" anchorRef={moreRef} align="right"
          className="bottom-auto top-full mb-0 mt-0.5 w-[min(100%,420px)] origin-top-right">
          <ChatTaskStripList tasks={view.all} projectName={projectName} onPick={(task) => { setListOpen(false); setPeek(targetOf(task)); }} />
        </FooterPopover>
      )}
      {peek && <TaskChipPeek key={peek.id} target={peek} anchorRef={anchorRef} onClose={() => setPeek(null)} />}
    </div>
  );
}
