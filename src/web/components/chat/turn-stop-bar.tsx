import { useState } from "react";
import { AlertCircle, History, KeyRound, MessageSquarePlus, Play } from "@/lib/icons";
import {
  describeTurnStop, isCliSignedOutStop, isSessionMissingStop, sessionMissingRecoveryOff, SESSION_MISSING_HEAD, type TurnStop,
} from "../../../shared/turn-stop";

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
  /** Opens Settings → AI Provider: offered when recovery was off and would have kept this chat. */
  onOpenRecoverySettings?: () => void;
}

const BUTTON = "flex shrink-0 items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 font-medium transition-colors max-md:min-h-11 max-md:flex-1 max-md:px-4";
const PLAIN = `${BUTTON} border-border bg-background text-text-primary hover:bg-surface`;
/** The note's actions: text buttons on a desktop, 44px pills with a hairline on a phone. */
const NOTE_ACTION = "inline-flex items-center gap-1.5 font-medium transition-colors max-md:min-h-11 max-md:flex-1 max-md:justify-center max-md:rounded-full max-md:border max-md:border-border-soft max-md:bg-surface";

/**
 * A strip above the chat input saying why the last turn ended, when an error ended it — a
 * Max Turns stop above all, which otherwise reads as the session going quiet mid-task. The
 * server sends it on every connect, so a reload keeps it; the next message clears it.
 *
 * Two stops get their own way out. When Claude Code no longer has the conversation, Continue
 * would only fail again, so it is drawn as a note at the end of the conversation (no box, the
 * meta text's size and colour: designs/resume-recovery-notices, direction A) offering a fresh
 * start here or a new chat (the next message starts a new session either way). When the Claude
 * CLI is signed out, it links to Accounts beside Continue, which works again once someone signs
 * in: signing out keeps the transcript.
 */
export function TurnStopBar({ stop, onContinue, onNewChat, onOpenAccounts, onOpenRecoverySettings }: TurnStopBarProps) {
  // "Start fresh here" only puts the note away: the server already reset the session, so the
  // next message starts a new one. Keyed by the stop, so a later stop shows again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  if (!stop || stop.at === dismissedAt) return null;
  if (isSessionMissingStop(stop)) {
    return (
      <div role="status" data-testid="turn-stop-bar" data-stop-kind="session-missing" className="flex shrink-0 items-start gap-2 px-4 pb-2 pt-1 text-[13px] text-text-secondary">
        <History className="mt-[3px] size-3.5 shrink-0 text-text-subtle" />
        <div className="min-w-0 flex-1 leading-normal">
          <p><span className="font-medium text-text-primary">{SESSION_MISSING_HEAD}.</span> Your next message starts a new session.</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 max-md:gap-2">
            <button type="button" className={`${NOTE_ACTION} text-primary`} onClick={() => setDismissedAt(stop.at)}>
              <Play className="size-3" />
              Start fresh here
            </button>
            {onNewChat && (
              <button type="button" className={`${NOTE_ACTION} text-text-secondary hover:text-text-primary`} onClick={onNewChat}>
                <MessageSquarePlus className="size-3" />
                New chat
              </button>
            )}
            {onOpenRecoverySettings && sessionMissingRecoveryOff(stop) && (
              <button type="button" className="ml-auto text-xs text-text-subtle transition-colors hover:text-text-secondary max-md:hidden" onClick={onOpenRecoverySettings}>
                Recover chats like this automatically
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  const { title, detail } = describeTurnStop(stop);
  const signedOut = isCliSignedOutStop(stop);
  return (
    <div
      role="status"
      data-testid="turn-stop-bar"
      data-stop-kind={signedOut ? "signed-out" : "error"}
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-error/20 bg-error/10 px-2 py-1.5 text-xs max-md:text-sm"
    >
      <AlertCircle className="size-3.5 shrink-0 text-error" />
      <div className="min-w-0 flex-[1_1_14rem] leading-snug">
        <p className="font-medium text-error">{title}</p>
        {detail && <p className="line-clamp-2 break-words text-text-secondary max-md:line-clamp-3">{detail}</p>}
      </div>
      <div className="flex shrink-0 gap-1.5 max-md:w-full">
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
      </div>
    </div>
  );
}
