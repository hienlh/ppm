/**
 * What "+N" on a chat's task strip opens: every open task the chat works on, in the strip's order,
 * one row each (status glyph, code, title, and the strip's status, wait, due and snooze labels). A
 * row opens that task's quick view; the list closes. In the popover under the strip on a desktop,
 * in a bottom sheet on a phone (`FooterPopover` decides).
 */
import { ListTodo } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { FooterPopoverHeader } from "@/components/chat/footer-popover";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { TaskCode } from "../kit/task-code";
import { ChatTaskStripMeta } from "./chat-task-strip-meta";

export function ChatTaskStripList({ tasks, projectName, onPick }: { tasks: TaskDto[]; projectName: string | null; onPick(task: TaskDto): void }) {
  return (
    <>
      <FooterPopoverHeader>
        <ListTodo aria-hidden className="size-3.5 shrink-0 text-primary" />
        <b className="text-[13px] font-semibold max-md:text-sm">Tasks this chat works on</b>
        <span className="rounded bg-surface px-1.5 font-mono text-[11px] text-text-3">{tasks.length}</span>
      </FooterPopoverHeader>
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" data-chat-task-strip-list="">
        {tasks.map((t) => (
          <li key={t.id} className="px-1.5 max-md:px-3" data-chat-task-strip-row={t.id}>
            <button type="button" onClick={() => onPick(t)} title={`Show #${t.number} ${t.title}`}
              className={cn(TEXT_CONTROL_HEIGHT, "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left can-hover:hover:bg-surface-hover")}>
              <TaskStatusGlyph baseGroup={t.baseGroup} closedAs={t.closedAs} name={t.statusName} className="shrink-0" />
              <span className="flex min-w-0 flex-1 items-baseline gap-1">
                <TaskCode task={t} viewProject={projectName} nested inRow className="text-[11.5px]" />
                <span className="min-w-0 truncate text-[12.5px] text-text">{t.title}</span>
              </span>
              <ChatTaskStripMeta task={t} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
