/**
 * A task's recorded result: what the work came to, who recorded it and when. A handed-off task is
 * checked until it has one; nothing renders while there is none.
 */
import { CheckCircle2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { TaskResult } from "../../../../shared/ppm-tasks";

export interface TaskResultBlockProps {
  result: TaskResult | null;
  className?: string;
}

export function formatResultTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TaskResultBlock({ result, className }: TaskResultBlockProps) {
  if (!result) return null;
  return (
    <section className={cn("rounded-lg border border-success/30 bg-success/5 p-3", className)} data-task-result>
      <header className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-text">
        <CheckCircle2 aria-hidden className="size-3.5 text-success" />
        Result
        <span className="ml-auto truncate font-normal text-text-3">{result.by} · {formatResultTime(result.at)}</span>
      </header>
      <p className="whitespace-pre-wrap break-words text-[13px] text-text-2">{result.text}</p>
    </section>
  );
}
