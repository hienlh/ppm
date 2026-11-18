/**
 * A task's recorded result: what the work came to, who recorded it and when. A handed-off task is
 * checked until it has one; nothing renders while there is none.
 *
 * The header is one row: "Result", then who and when, then the optional action (the detail page's
 * Edit). Who and when is the only part that gives way: it is cut with "…" and carries the full text
 * in its tooltip, and it never runs under the action, which keeps its width. The action used to be
 * laid over the block from outside, so a long name and a full date ran underneath it.
 *
 * A phone has no hover to show a tooltip, so there (below md) who and when takes a line of its own
 * under "Result" and wraps instead of being cut: the date is always readable.
 */
import type { ReactNode } from "react";
import { CheckCircle2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { TaskResult } from "../../../../shared/ppm-tasks";

export interface TaskResultBlockProps {
  result: TaskResult | null;
  className?: string;
  /** Shown at the end of the header row, after who and when. */
  action?: ReactNode;
}

export function formatResultTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TaskResultBlock({ result, className, action }: TaskResultBlockProps) {
  if (!result) return null;
  const meta = `${result.by} · ${formatResultTime(result.at)}`;
  return (
    <section className={cn("rounded-lg border border-success/30 bg-success/5 p-3", className)} data-task-result>
      <header className="mb-1.5 flex min-w-0 items-center gap-1.5 text-xs font-medium text-text max-md:flex-wrap max-md:gap-y-0.5">
        <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-success" />
        <span className="shrink-0">Result</span>
        <span title={meta} data-task-result-meta
          className="ml-auto min-w-0 truncate font-normal text-text-3 max-md:order-last max-md:ml-0 max-md:basis-full max-md:overflow-visible max-md:whitespace-normal max-md:break-words">{meta}</span>
        {/* -my-1.5: the 28 px button sits in the 16 px text row without making the header taller. */}
        {action && <span data-task-result-action className="-my-1.5 flex shrink-0 items-center">{action}</span>}
      </header>
      <p className="whitespace-pre-wrap break-words text-[13px] text-text-2">{result.text}</p>
    </section>
  );
}
