import { useState } from "react";
import { AlertCircle, AlertTriangle, KeyRound, MessageSquarePlus, Play } from "@/lib/icons";
import { describeTurnStop, isCliSignedOutStop, isSessionMissingStop, type TurnStop } from "../../../shared/turn-stop";

/** What the Continue button sends — the wording PPM's own retry uses for a turn cut short. */
export const CONTINUE_AFTER_STOP = "Continue from where you left off.";

interface TurnStopBarProps {
  /** Null hides the bar. The chat passes it only while the session is idle. */
  stop: TurnStop | null;
  onContinue: () => void;
  /** Opens a new chat tab: offered when Claude Code no longer has this conversation. */
  onNewChat?: () => void;
  /** Opens Settings → Accounts: offered when the Claude CLI is signed out. */
  onOpenAccounts?: () => void;
}

const BUTTON = "flex shrink-0 items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 font-medium transition-colors max-md:min-h-11 max-md:flex-1 max-md:px-4";
const PLAIN = `${BUTTON} border-border bg-background text-text-primary hover:bg-surface`;
const PRIMARY = `${BUTTON} border-primary bg-primary text-primary-foreground hover:bg-primary/90`;

/**
 * A strip above the chat input saying why the last turn ended, when an error ended it — a
 * Max Turns stop above all, which otherwise reads as the session going quiet mid-task. The
 * server sends it on every connect, so a reload keeps it; the next message clears it.
 *
 * Two stops get their own way out. When Claude Code no longer has the conversation, Continue
 * would only fail again, so the bar offers a fresh start here or a new chat instead (the next
 * message starts a new session either way). When the Claude CLI is signed out, it links to
 * Accounts beside Continue, which works again once someone signs in: signing out keeps the
 * transcript.
 */
export function TurnStopBar({ stop, onContinue, onNewChat, onOpenAccounts }: TurnStopBarProps) {
  // "Start fresh here" only puts the bar away: the server already reset the session, so the
  // next message starts a new one. Keyed by the stop, so a later stop shows again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  if (!stop || stop.at === dismissedAt) return null;
  const { title, detail } = describeTurnStop(stop);
  const missing = isSessionMissingStop(stop);
  const signedOut = !missing && isCliSignedOutStop(stop);
  const Icon = missing ? AlertTriangle : AlertCircle;
  return (
    <div
      role="status"
      data-testid="turn-stop-bar"
      data-stop-kind={missing ? "session-missing" : signedOut ? "signed-out" : "error"}
      className={`flex shrink-0 flex-wrap items-center gap-2 border-t px-2 py-1.5 text-xs max-md:text-sm ${
        missing ? "border-warning/25 bg-warning/10" : "border-error/20 bg-error/10"
      }`}
    >
      <Icon className={`size-3.5 shrink-0 ${missing ? "text-warning" : "text-error"}`} />
      <div className="min-w-0 flex-[1_1_14rem] leading-snug">
        <p className={`font-medium ${missing ? "text-warning-ink" : "text-error"}`}>{title}</p>
        {detail && <p className="line-clamp-2 break-words text-text-secondary max-md:line-clamp-3">{detail}</p>}
      </div>
      <div className="flex shrink-0 gap-1.5 max-md:w-full">
        {missing ? (
          <>
            <button type="button" className={PRIMARY} onClick={() => setDismissedAt(stop.at)}>Start fresh here</button>
            {onNewChat && (
              <button type="button" className={PLAIN} onClick={onNewChat}>
                <MessageSquarePlus className="size-3.5" />
                New chat
              </button>
            )}
          </>
        ) : (
          <>
            {signedOut && onOpenAccounts && (
              <button type="button" className={PLAIN} onClick={onOpenAccounts}>
                <KeyRound className="size-3.5" />
                Accounts
              </button>
            )}
            <button type="button" onClick={onContinue} className={PLAIN}>
              <Play className="size-3.5" />
              Continue
            </button>
          </>
        )}
      </div>
    </div>
  );
}
