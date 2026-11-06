/**
 * Shown while the chat is in the history window: says which turn is on screen and takes the reader
 * back to the newest message in one tap.
 *
 * It floats over the bottom of the conversation, outside the scroll container, so it stays put while
 * the window scrolls. On a phone it is docked a fixed 8 px above the composer instead
 * (`composer-edge.ts`), so it stays in the thumb zone however many bars sit under the conversation. The dot says
 * the live conversation has moved on since the jump: something streamed, or a new message arrived.
 */
import { ChevronsDown } from "@/lib/icons";

export function BackToLatestPill({ turnN, liveActivity, onClick, docked = false }: {
  /** The turn at the top of the window's viewport, when it is known. */
  turnN: number | null;
  liveActivity: boolean;
  onClick: () => void;
  /** Placed in the composer's edge element (a phone) rather than over the window. */
  docked?: boolean;
}) {
  return (
    <div data-back-to-latest={docked ? "docked" : "window"} className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4 ${docked ? "bottom-2" : "bottom-3"}`}>
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
