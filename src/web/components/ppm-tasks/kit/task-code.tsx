/**
 * A task's code next to its title: `#12` in a view of the task's own project, `ppm/12` where the
 * view spans projects or belongs to another one (`taskCode`). Small, monospace and muted so the
 * title stays what the eye reads; it never wraps and never shrinks, so a long title gives way first.
 *
 * A click copies the full code (`ppm/12`, which every chat and the Assistant understand wherever it
 * is pasted) and says so in a toast. The click stops there: the row or chip around it does not
 * also open. Inside another button (`nested`) it renders as a span with the button role, because a
 * button inside a button is not valid HTML.
 */
import type { KeyboardEvent, MouseEvent } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { formatTaskRef, taskCode } from "../../../../shared/ppm-tasks-refs";

export interface TaskCodeProps {
  task: { number: number; project: string };
  /** The project the view shows; null when it spans projects. */
  viewProject: string | null;
  /** Rendered inside another button: a span with the button role instead of a button. */
  nested?: boolean;
  /**
   * The code sits in something a tap opens (a list row, a chip, a child task). On a phone the
   * tap then stays the row's: a thumb aiming at the title often lands on the code, and opening is
   * what it meant. The task's page and its long-press sheet still copy on a tap.
   */
  inRow?: boolean;
  /** Out of the Tab order where the list's own keys move the selection (the desktop list). */
  tabIndex?: number;
  className?: string;
}

/** Copies a task's full code and says what was copied. */
export async function copyTaskCode(task: { number: number; project: string }): Promise<void> {
  const full = formatTaskRef(task.number, task.project);
  if (await copyToClipboard(full)) toast.success(`Copied ${full}`);
  else toast.error(`Could not copy ${full}`);
}

// `min-h-0!`/`min-w-0!`: phone cards grow every button inside them to thumb size
// (`THUMB_CARDS`, `THUMB_FIELDS`); the code is text in a line and must keep the line's height.
export const TASK_CODE_CLASS =
  "min-h-0! min-w-0! inline-block shrink-0 cursor-copy whitespace-nowrap rounded-[3px] px-[2px] align-baseline font-mono text-[0.88em] font-normal leading-[inherit] tracking-normal text-text-3 no-underline can-hover:hover:bg-surface-hover can-hover:hover:text-text-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring";

export function TaskCode({ task, viewProject, nested = false, inRow = false, tabIndex, className }: TaskCodeProps) {
  const code = taskCode(task, viewProject);
  const full = formatTaskRef(task.number, task.project);
  const copy = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void copyTaskCode(task);
  };
  const common = {
    "data-task-code": code,
    title: `Copy ${full}`,
    // Starts with what is shown, so voice control can name it by its text.
    "aria-label": `${code}, copy ${full}`,
    className: cn(TASK_CODE_CLASS, inRow && "max-md:pointer-events-none", className),
    onClick: copy,
    // A press that starts on the code is the code's: it neither drags the row (pointer), opens a
    // row's action sheet (a long touch, or Android's long-press `contextmenu`) nor keeps the tab.
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    onContextMenu: (e: MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: MouseEvent) => e.stopPropagation(),
  };
  if (nested) {
    return (
      <span role="button" tabIndex={tabIndex ?? 0} {...common}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === " ") copy(e); }}>
        {code}
      </span>
    );
  }
  // Enter on the button copies (its click); it must not also reach a list's own Enter.
  return <button type="button" tabIndex={tabIndex} {...common} onKeyDown={(e) => e.stopPropagation()}>{code}</button>;
}
