import { useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Terminal } from "@/lib/icons";
import type { ResumeHandoffEntry } from "../../../types/chat";

/** The one line a recovered chat shows, from the `session_recovered` event (`resume-handoff.ts`). */
export interface SessionRecoveredEvent {
  type: "session_recovered";
  turns: number;
  omittedTurns: number;
  entries: ResumeHandoffEntry[];
}

/** Turns listed before "Show N earlier turns": the newest ones, the ones the answer leans on. */
const NEWEST_SHOWN = 3;

/** "the last 14 turns" / "all 14 earlier turns": how much PPM sent, in words. */
export function recoveredTurnsLabel(turns: number, omittedTurns: number): string {
  if (turns === 1) return omittedTurns > 0 ? "the last turn" : "the one earlier turn";
  return omittedTurns > 0 ? `the last ${turns} turns` : `all ${turns} earlier turns`;
}

/**
 * Claude Code no longer had this chat, so PPM started a new Claude session in it and sent along
 * what it kept. A note in the conversation rather than a box (designs/resume-recovery-notices,
 * direction A): the meta text's size and colour, an icon in front, and "What was sent" opening
 * the turns as a quiet list under a hairline.
 */
export function SessionRecoveredNotice({ event }: { event: SessionRecoveredEvent }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const entries = event.entries ?? [];
  const hidden = all ? 0 : Math.max(0, entries.length - NEWEST_SHOWN);
  const shown = entries.slice(hidden);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div role="status" data-testid="session-recovered-notice" className="flex items-start gap-2 py-0.5 text-[13px] text-text-secondary">
      <RotateCcw className="mt-[3px] size-3.5 shrink-0 text-text-subtle" />
      <div className="min-w-0 flex-1 leading-normal">
        <p>
          New Claude session — PPM sent {recoveredTurnsLabel(event.turns, event.omittedTurns)} it kept.{" "}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            // A 44px target on touch without stretching the line it sits in: the padding is
            // taken back by the negative margin, so only the hit area grows.
            className="inline-flex items-center gap-0.5 whitespace-nowrap font-medium text-primary max-md:-my-3.5 max-md:py-3.5"
          >
            What was sent
            <Chevron className="size-3" />
          </button>
        </p>
        {open && (
          <div data-testid="session-recovered-sent" className="mt-2 border-l-2 border-border py-0.5 pl-3">
            <p className="mb-1.5 text-[11.5px] text-text-subtle">
              Sent to the new session · {event.turns} {event.turns === 1 ? "turn" : "turns"}, tool output not included
            </p>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setAll(true)}
                className="mb-2 text-[11.5px] font-medium text-primary max-md:min-h-11"
              >
                Show {hidden} earlier {hidden === 1 ? "turn" : "turns"}
              </button>
            )}
            <ol className="grid gap-2">
              {shown.map((entry) => (
                <li key={entry.n} className="flex gap-2 select-text">
                  <span className="w-5 shrink-0 pt-0.5 font-mono text-[11px] text-text-subtle">{entry.n}</span>
                  <div className="min-w-0 space-y-0.5 text-[12.5px] leading-normal">
                    <p className="break-words"><span className="inline-block min-w-[46px] text-[11px] font-semibold text-text-subtle max-md:block">You</span>{entry.user}</p>
                    {entry.tools && (
                      <p className="flex items-center gap-1 font-mono text-[11px] text-text-subtle md:pl-[46px]"><Terminal className="size-3" />{entry.tools}</p>
                    )}
                    <p className="break-words"><span className="inline-block min-w-[46px] text-[11px] font-semibold text-text-subtle max-md:block">Claude</span>{entry.answer}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
