/**
 * The quick view's Links: every link of the task drawn as the task page draws it (`TaskLinkPill`,
 * its live state beside it — a Jira status, a PR open or merged, a chat running), opening the way
 * the page opens it. Past `PEEK_LINK_LIMIT` the rest fold into "+N", which shows them all; "Show
 * fewer" folds them again. A task with no links draws nothing here.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { peekLinks } from "@/lib/ppm-tasks/task-peek-compact";
import type { LinkState } from "../../../../shared/ppm-tasks";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { TaskLinkPill } from "../task-links-card";

/** "+N" and "Show fewer": drawn like a link pill, 32px on a phone with a 44px target. */
const MORE = cn(
  "relative inline-flex h-[22px] min-h-0! items-center whitespace-nowrap rounded-md border border-dashed border-border-soft px-2 text-[11.5px] text-text-2",
  "can-hover:hover:border-border can-hover:hover:text-text max-md:h-8 max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-[7px] max-md:after:content-['']",
);

export function TaskPeekLinks({ task, linkStates, jiraSite, onOpenChat }: {
  task: TaskDto; linkStates: readonly LinkState[]; jiraSite?: string | null; onOpenChat(sessionId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (task.links.length === 0) return null;
  const { shown, hidden } = peekLinks(task.links, expanded);
  return (
    <section aria-label="Links" data-task-peek-links="" data-task-peek-links-expanded={expanded || undefined}>
      <div className="mb-1 text-[11.5px] font-medium text-text-3">Links <span className="font-normal">{task.links.length}</span></div>
      <div className="flex flex-wrap gap-1.5 max-md:gap-x-2 max-md:gap-y-3.5">
        {shown.map((l) => (
          <TaskLinkPill key={`${l.kind}:${l.ref}`} link={l} linkStates={linkStates} jiraSite={jiraSite} onOpenChat={onOpenChat} className="min-w-0 max-w-full" />
        ))}
        {hidden > 0 && (
          <button type="button" onClick={() => setExpanded(true)} className={MORE} data-task-peek-links-more={hidden}
            aria-label={`Show ${hidden} more link${hidden === 1 ? "" : "s"}`} title={`Show ${hidden} more`}>
            +{hidden}
          </button>
        )}
        {expanded && peekLinks(task.links, false).hidden > 0 && (
          <button type="button" onClick={() => setExpanded(false)} className={MORE} data-task-peek-links-fewer="">Show fewer</button>
        )}
      </div>
    </section>
  );
}
