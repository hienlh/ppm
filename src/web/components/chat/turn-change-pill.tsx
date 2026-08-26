/**
 * Resting state of the turn change rollup: a pill appended to the message action bar.
 *
 * Only the button lives here — the caller owns `open` so the tray can render *below*
 * the action bar instead of inside its flex row.
 */
import { cn } from "@/lib/utils";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";

export function changeTotals(changes: TurnFileChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    added += c.linesAdded;
    removed += c.linesRemoved;
  }
  return { added, removed };
}

export function TurnChangePill({ count, totals, open, onToggle, ref }: {
  count: number;
  totals: { added: number; removed: number };
  open: boolean;
  onToggle: () => void;
  /** Lets the caller restore focus here when the tray closes. */
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const label = `${count} file${count !== 1 ? "s" : ""}`;

  return (
    <>
      <span aria-hidden className="mx-1.5 h-3.5 w-px bg-border-soft" />
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${label} changed this turn, ${totals.added} added, ${totals.removed} removed`}
        className={cn(
          // Borderless on purpose: the sibling Copy/Fork controls are ghost buttons, and
          // a bordered pill next to them reads as a heavy block, especially on mobile.
          // The touch height stays — without a border it costs nothing visually.
          "inline-flex items-center gap-[7px] rounded-full font-mono text-[11.5px]",
          "px-3 min-h-11 md:min-h-0 md:px-[9px] md:py-[5px]",
          "text-text-secondary transition-colors hover:bg-surface hover:text-text-primary",
        )}
      >
        <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-primary" />
        <span>{label}</span>
        <span className="flex items-center gap-[5px] tabular-nums">
          <span className="text-success">+{totals.added}</span>
          <span className="text-error">{"−"}{totals.removed}</span>
        </span>
      </button>
    </>
  );
}
