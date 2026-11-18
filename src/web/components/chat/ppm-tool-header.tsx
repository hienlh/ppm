/**
 * The header parts of a card for one of PPM's own tools (tasks, session history, schedules,
 * reports, the Assistant's and the design tools): the chip, the readable line, and the buttons that
 * open what the call named — a task's quick view (the same one a task chip opens) or a chat.
 * Drawn by `ToolCard` in `tool-cards.tsx`; the line itself is `ppmToolSummary` (`@/lib/ppm-tool-call`).
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, History, ListTodo, Loader2, Palette, Search, Send, Sparkles, Wrench } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { openLinkedSession } from "@/lib/session-collab-client";
import { lookupTasksByCode } from "@/lib/ppm-tasks/task-code-lookup";
import type { TaskTabTarget } from "@/lib/ppm-tasks/open-task-tab";
import type { PpmToolIcon, PpmToolSummary } from "@/lib/ppm-tool-call";
import { TaskChipPeek } from "@/components/ppm-tasks/peek/task-chip-peek";
import { isAssistantProject } from "../../../shared/assistant-project";
import { useAgentSessionContext } from "./agent-session-context";
import { useKnownSession } from "./session-collab-tool-card";

const CHIPS: Record<PpmToolIcon, { Icon: React.ElementType; cls: string }> = {
  task: { Icon: ListTodo, cls: "bg-accent-wash text-primary" },
  search: { Icon: Search, cls: "bg-info/15 text-info" },
  turns: { Icon: History, cls: "bg-info/15 text-info" },
  schedule: { Icon: CalendarClock, cls: "bg-warning/15 text-warning" },
  report: { Icon: Send, cls: "bg-info/15 text-info" },
  assistant: { Icon: Sparkles, cls: "bg-accent-2/15 text-accent-2" },
  design: { Icon: Palette, cls: "bg-accent-2/15 text-accent-2" },
  tool: { Icon: Wrench, cls: "bg-panel-2 text-text-2" },
};

/** The chip a PPM tool's card shows: one icon per tool family. */
export function ppmToolChip(icon: PpmToolIcon): { Icon: React.ElementType; cls: string } {
  return CHIPS[icon];
}

/** The line inside the header button: the readable name, then what the call was about. */
export function PpmToolSummaryText({ summary }: { summary: PpmToolSummary }) {
  const known = useKnownSession(summary.session?.sessionId);
  const title = summary.session && known.title ? known.title : undefined;
  const detail = [summary.detail, title].filter(Boolean).join(" · ");
  return (
    <span data-ppm-tool-summary="">
      {summary.label}
      {detail && <span className="text-text-subtle"> {detail}</span>}
    </span>
  );
}

/** Buttons beside the header: open the task it named, open the chat it named. Nothing when it named neither. */
export function PpmToolLinks({ summary, projectName }: { summary: PpmToolSummary; projectName?: string }) {
  const chat = useAgentSessionContext();
  const project = chat?.projectName || projectName || "";
  if (!summary.task && !summary.session) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 pr-1">
      {summary.task && <TaskCodeButton code={summary.task} project={project} />}
      {summary.session && <OpenChatButton session={summary.session} project={project} chatProviderId={chat?.providerId} />}
    </span>
  );
}

const LINK_BUTTON = cn(
  "inline-flex min-h-0! min-w-0 max-w-[10rem] items-center gap-1 rounded-md px-2 text-primary font-medium transition-colors can-hover:hover:bg-accent-wash",
  TEXT_CONTROL_HEIGHT,
);

/** A task's code as a button: the task's quick view, as a task chip opens it. */
function TaskCodeButton({ code, project }: { code: string; project: string }) {
  const [target, setTarget] = useState<TaskTabTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);

  const open = async () => {
    if (target) { setTarget(null); return; }
    setBusy(true);
    try {
      const context = isAssistantProject(project) ? null : project || null;
      const found = (await lookupTasksByCode(code, context, { anywhere: true })) ?? [];
      const task = found[0];
      if (!task) { toast.error(`No task ${code} found`); return; }
      setTarget({ id: task.id, project: task.project, title: task.title, number: task.number });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={(el) => { anchorRef.current = el; }}
        onClick={(e) => { e.stopPropagation(); void open(); }}
        title={`Show task ${code}`}
        aria-haspopup="dialog"
        aria-expanded={!!target}
        data-ppm-tool-task={code}
        className={LINK_BUTTON}
      >
        {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <ListTodo className="size-3.5 shrink-0" />}
        <span className="truncate font-mono text-[11.5px]">{code}</span>
      </button>
      {target && <TaskChipPeek key={target.id} target={target} anchorRef={anchorRef} onClose={() => setTarget(null)} />}
    </>
  );
}

/** Opens the chat a call named, in its own project when the tool said which. */
function OpenChatButton({ session, project, chatProviderId }: {
  session: NonNullable<PpmToolSummary["session"]>;
  project: string;
  chatProviderId?: string;
}) {
  const known = useKnownSession(session.sessionId);
  // A call from the PPM Assistant names other projects; with none named, the chat is not opened in the Assistant's.
  const target = session.project ?? (isAssistantProject(project) ? null : project || null);
  if (!target) return null;
  const providerId = session.providerId ?? known.providerId ?? chatProviderId ?? "";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void openLinkedSession({ projectName: target, providerId, sessionId: session.sessionId, title: known.title, turnId: session.turnId });
      }}
      title={`Open ${known.title ?? "the chat"}`}
      data-ppm-tool-open-chat={session.sessionId}
      className={LINK_BUTTON}
    >
      Open chat
    </button>
  );
}
