import { Info } from "@/lib/icons";

/** The one line a recovered chat shows, from the `session_recovered` event (`resume-handoff.ts`). */
export interface SessionRecoveredEvent {
  type: "session_recovered";
  turns: number;
  omittedTurns: number;
  sent: string;
}

/** "the last 14 turns" / "the one earlier turn": how much PPM sent, in words. */
export function recoveredTurnsLabel(turns: number, omittedTurns: number): string {
  if (turns === 1) return omittedTurns > 0 ? "the last turn" : "the one earlier turn";
  return omittedTurns > 0 ? `the last ${turns} turns` : `all ${turns} earlier turns`;
}

/**
 * Claude Code no longer had this chat, so PPM started a new Claude session in it and sent along
 * what it kept. One line, not an error: the chat goes on. What was sent sits behind a disclosure,
 * so anyone wondering why the answer remembers less than before can read exactly what it got.
 */
export function SessionRecoveredNotice({ event }: { event: SessionRecoveredEvent }) {
  return (
    <div
      role="status"
      data-testid="session-recovered-notice"
      className="flex items-start gap-2 rounded-md border border-info/35 bg-info/10 px-2.5 py-2 text-xs text-text-primary max-md:text-sm"
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
      <div className="min-w-0 flex-1 leading-snug">
        <p>
          Started a new Claude session for this chat: Claude Code on this computer no longer had the old one.
          PPM sent along {recoveredTurnsLabel(event.turns, event.omittedTurns)} it kept.
        </p>
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-primary max-md:min-h-11 max-md:py-2">What was sent</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 font-mono text-[11px] text-text-secondary">
            {event.sent}
          </pre>
        </details>
      </div>
    </div>
  );
}
