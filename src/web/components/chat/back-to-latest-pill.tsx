/**
 * Shown while the chat is in the history window: says which turn is on screen and takes the reader
 * back to the newest message in one tap.
 *
 * It floats over the bottom of the conversation, just above the composer — the thumb zone on a
 * phone — and outside the scroll container, so it stays put while the window scrolls. The dot says
 * the live conversation has moved on since the jump: something streamed, or a new message arrived.
 */
import { ChevronsDown } from "@/lib/icons";

export function BackToLatestPill({ turnN, liveActivity, onClick }: {
  /** The turn at the top of the window's viewport, when it is known. */
  turnN: number | null;
  liveActivity: boolean;
  onClick: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto inline-flex min-h-[44px] max-w-full items-center gap-2 rounded-full border border-border bg-surface/95 px-4 text-sm text-text-primary shadow-lg backdrop-blur-sm hover:bg-surface-elevated active:bg-surface-elevated"
      >
        {turnN !== null && <span className="truncate text-text-secondary">Viewing turn {turnN}</span>}
        {turnN !== null && <span aria-hidden className="text-text-subtle">·</span>}
        <span className="inline-flex items-center gap-1.5 font-medium">
          <ChevronsDown className="size-4 shrink-0" />
          Back to latest
        </span>
        {liveActivity && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="New activity" role="status" />}
      </button>
    </div>
  );
}
