import { AlertCircle, Play } from "@/lib/icons";
import { describeTurnStop, type TurnStop } from "../../../shared/turn-stop";

/** What the Continue button sends — the wording PPM's own retry uses for a turn cut short. */
export const CONTINUE_AFTER_STOP = "Continue from where you left off.";

interface TurnStopBarProps {
  /** Null hides the bar. The chat passes it only while the session is idle. */
  stop: TurnStop | null;
  onContinue: () => void;
}

/**
 * A strip above the chat input saying why the last turn ended, when an error ended it — a
 * Max Turns stop above all, which otherwise reads as the session going quiet mid-task. The
 * server sends it on every connect, so a reload keeps it; the next message clears it.
 */
export function TurnStopBar({ stop, onContinue }: TurnStopBarProps) {
  if (!stop) return null;
  const { title, detail } = describeTurnStop(stop);
  return (
    <div
      role="status"
      data-testid="turn-stop-bar"
      className="flex shrink-0 items-center gap-2 border-t border-error/20 bg-error/10 px-2 py-1.5 text-xs max-md:text-sm"
    >
      <AlertCircle className="size-3.5 shrink-0 text-error" />
      <div className="min-w-0 flex-1 leading-snug">
        <p className="font-medium text-error">{title}</p>
        {detail && <p className="line-clamp-2 break-words text-text-secondary max-md:line-clamp-3">{detail}</p>}
      </div>
      <button
        type="button"
        onClick={onContinue}
        className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2.5 py-1.5 font-medium text-text-primary transition-colors hover:bg-surface max-md:min-h-11 max-md:px-4"
      >
        <Play className="size-3.5" />
        Continue
      </button>
    </div>
  );
}
