/**
 * Settings → Voice: the words PPM learned for one project, with where each came from and an Undo.
 * Undone words stay listed under "Undone" with a Restore, because an undone word is remembered (it
 * is never learned again from the clean-up) and the user should be able to see and reverse that.
 *
 * Below `md` each word is a card with its Undo beside it; from `md` up, a table. Undo is a real
 * button in both, never a hover-only control.
 */
import { useMemo, useState } from "react";
import { Undo2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BlockedWord, LearnedWord } from "../../../shared/voice-message";

type Tab = "week" | "all" | "undone";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "today 02:14", "yesterday", "Tue", "12 Nov": how long ago, as briefly as reads clearly. */
export function learnedWhen(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days <= 0) return `today ${when.toTimeString().slice(0, 5)}`;
  if (days === 1) return "yesterday";
  if (days < 7) return when.toLocaleDateString(undefined, { weekday: "short" });
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * When a learned word was learned and last used, as a row shows it: "used today 03:09" once it has
 * been said since it was learned, else "learned Tue". The other date goes in the title.
 */
export function learnedDates(l: LearnedWord, now: Date = new Date()): { text: string; title: string } {
  const learned = `learned ${learnedWhen(l.at, now)}`;
  if (!l.lastUsedAt || l.lastUsedAt === l.at) return { text: learned, title: learned };
  const used = `used ${learnedWhen(l.lastUsedAt, now)}`;
  return { text: used, title: `${learned}, last ${used}` };
}

/** What the source badge says: "clean-up · 3×", "your edit". */
export function learnedSourceLabel(l: LearnedWord): string {
  if (l.source === "cleanup") return `clean-up · ${l.hits ?? 1}×`;
  return "your edit";
}

/** The learned words of today (local day), for "Undo everything learned today". */
export function learnedToday(learned: readonly LearnedWord[], now: Date = new Date()): string[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return learned.filter((l) => Date.parse(l.at) >= start).map((l) => l.word);
}

interface Props {
  learned: LearnedWord[];
  blocked: BlockedWord[];
  busy?: boolean;
  onUndo: (words: string[]) => void;
  onRestore: (word: string) => void;
}

export function VoiceLearnedWordsList({ learned, blocked, busy, onUndo, onRestore }: Props) {
  const [tab, setTab] = useState<Tab>("week");
  const now = useMemo(() => new Date(), [learned, blocked]);
  const newestFirst = useMemo(() => [...learned].sort((a, b) => b.at.localeCompare(a.at)), [learned]);
  const week = newestFirst.filter((l) => now.getTime() - Date.parse(l.at) < WEEK_MS);
  const today = learnedToday(learned, now);
  const shown = tab === "week" ? week : newestFirst;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-panel" data-voice-learned-list="">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-soft px-3 py-2">
        <TabButton active={tab === "week"} onClick={() => setTab("week")}>This week · {week.length}</TabButton>
        <TabButton active={tab === "all"} onClick={() => setTab("all")}>All · {learned.length}</TabButton>
        <TabButton active={tab === "undone"} onClick={() => setTab("undone")}>Undone · {blocked.length}</TabButton>
        <span className="flex-1" />
        {tab !== "undone" && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || today.length === 0}
            onClick={() => onUndo(today)}
            className="h-11 w-full border-destructive/40 text-destructive md:h-[30px] md:w-auto"
          >
            Undo everything learned today{today.length ? ` (${today.length})` : ""}
          </Button>
        )}
      </div>

      {tab === "undone" ? (
        blocked.length === 0 ? <Empty>Nothing undone. A word you undo stays here, and is never learned again until you restore it.</Empty> : (
          <ul>
            {[...blocked].sort((a, b) => b.at.localeCompare(a.at)).map((b) => (
              <Row key={`blocked-${b.word}`} word={b.word} heard={b.from} badge="undone · never again" when={{ text: `undone ${learnedWhen(b.at, now)}`, title: "" }} dim>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => onRestore(b.word)} className="h-11 md:h-[30px]">Restore</Button>
              </Row>
            ))}
          </ul>
        )
      ) : shown.length === 0 ? (
        <Empty>{tab === "week" ? "Nothing learned this week." : "Nothing learned yet. Words appear here once the clean-up has fixed them a few times, or when you correct a transcript."}</Empty>
      ) : (
        <ul>
          {shown.map((l) => (
            <Row key={`learned-${l.word}`} word={l.word} heard={l.from} badge={learnedSourceLabel(l)}
              badgeTone={l.source === "cleanup" ? "cleanup" : "edit"} when={learnedDates(l, now)} phrase={l.kind === "phrase"}>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onUndo([l.word])} className="h-11 gap-1.5 md:h-[30px]"
                aria-label={`Undo learned word ${l.word}`}>
                <Undo2 className="size-3.5" />Undo
              </Button>
            </Row>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn("h-11 rounded-lg px-2.5 text-[12.5px] md:h-[30px]", active ? "bg-panel-2 text-text" : "text-text-2 hover:text-text")}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-4 text-xs leading-relaxed text-text-3">{children}</p>;
}

function Row({ word, heard, badge, badgeTone, when, dim, phrase, children }: {
  word: string; heard: string; badge: string; badgeTone?: "cleanup" | "edit"; when: { text: string; title: string }; dim?: boolean; phrase?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={cn(
      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-border-soft px-4 py-2.5 first:border-t-0",
      "md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_9.5rem_auto]",
      dim && "text-text-dim",
    )}>
      <span className="min-w-0 truncate text-sm font-semibold" title={phrase ? "Only the clean-up uses this one; Whisper is not told." : undefined}>
        {word}
      </span>
      <span className="col-span-2 row-start-2 min-w-0 truncate text-[12.5px] text-text-3 line-through md:col-span-1 md:row-start-auto">{heard}</span>
      <span className="col-span-2 row-start-3 flex items-center gap-2 md:col-span-1 md:row-start-auto">
        <span className={cn(
          "whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px]",
          badgeTone === "cleanup" ? "border-accent-2/40 text-accent-2" : badgeTone === "edit" ? "border-warning/40 text-warning" : "border-border text-text-3",
        )}>{badge}</span>
        <span className="text-xs text-text-3 md:hidden" title={when.title || undefined}>{when.text}</span>
      </span>
      <span className="hidden text-xs text-text-3 md:block" title={when.title || undefined}>{when.text}</span>
      <span className="col-start-2 row-start-1 justify-self-end md:col-start-auto md:row-start-auto">{children}</span>
    </li>
  );
}
