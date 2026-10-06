/**
 * The small pieces every changed-file row is drawn from — in Source Control
 * and in the Review tab alike, so the two read as one surface.
 */
import type { ReactNode } from "react";
import { Check } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { CHANGE_LETTER_NAME, type ChangeLetter, type CheckState } from "@/lib/git-changes-view";

/** The session review's box, with a third state: a dash when only part of the file is staged. */
export function CheckBox({ state, className }: { state: CheckState; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 md:size-4 shrink-0 items-center justify-center rounded-[5px] md:rounded border-[1.5px] transition-colors",
        state === "none"
          ? "border-text-3 group-hover/cb:border-text-2"
          : "border-primary bg-primary text-primary-foreground",
        className,
      )}
    >
      {state === "all" && <Check className="size-3" />}
      {state === "some" && <span className="h-0.5 w-2 rounded-full bg-current" />}
    </span>
  );
}

/**
 * The box as a button filling the row's height: 48px wide on a touch screen,
 * 30px where there is a pointer.
 */
export function CheckCell({ state, label, title, disabled, onToggle, className }: {
  state: CheckState;
  label: string;
  title: string;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "group/cb flex w-12 md:w-[30px] shrink-0 items-center justify-center self-stretch disabled:opacity-50",
        className,
      )}
    >
      <CheckBox state={state} />
    </button>
  );
}

const TILE: Record<ChangeLetter, string> = {
  A: "text-success bg-success/14",
  M: "text-warning bg-warning/14",
  D: "text-error bg-error/14",
  R: "text-primary bg-accent-wash",
  U: "text-error bg-error/14",
};

/** The status letter on a faint tint of its colour. */
export function StatusTile({ letter }: { letter: ChangeLetter }) {
  return (
    <span
      title={CHANGE_LETTER_NAME[letter]}
      aria-label={CHANGE_LETTER_NAME[letter]}
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-[5px] font-mono text-[10.5px] font-semibold leading-none",
        TILE[letter],
      )}
    >
      {letter}
    </span>
  );
}

const MAX_DOTS = 6;

/** One dot per block, filled when it is staged. */
export function BlockDots({ dots }: { dots: boolean[] }) {
  const staged = dots.filter(Boolean).length;
  return (
    <span
      className="inline-flex items-center gap-[3px]"
      title={`${staged} of ${dots.length} ${dots.length === 1 ? "block" : "blocks"} staged`}
    >
      {dots.slice(0, MAX_DOTS).map((on, i) => (
        <i
          key={i}
          className={cn(
            "size-[7px] rounded-full border-[1.5px]",
            on ? "border-primary bg-primary" : "border-text-3/85",
          )}
        />
      ))}
      {dots.length > MAX_DOTS && (
        <span className="font-mono text-[10px] leading-none text-text-3">+{dots.length - MAX_DOTS}</span>
      )}
    </span>
  );
}

/** `+12 −3`, the removed count only when there is one; nothing for no lines at all. */
export function LineCounts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="inline-flex gap-[5px] whitespace-nowrap font-mono text-[11px] font-medium leading-none tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>}
      {removed > 0 && <span className="text-error">{"−"}{removed}</span>}
    </span>
  );
}

/** A group heading inside the list: "Conflicts 2", "Merged 3". */
export function GroupLabel({ children, count, tone }: { children: ReactNode; count: number; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex h-[30px] items-center gap-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-[.07em]",
        tone === "error" ? "text-error" : "text-text-3",
      )}
    >
      {children}
      <CountChip count={count} />
    </div>
  );
}

export function CountChip({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-text/8 px-1.5 font-mono text-[10.5px] font-medium leading-[14px] tracking-normal text-text-2">
      {count}
    </span>
  );
}
