/**
 * Which of the PPM Assistant's cards go to the user's phone, and when.
 *
 * A new card goes to Telegram at once, unless quiet hours are on: then it is `held` in the
 * database, and the first moment they are over — a clock timer at the window's end, or the bridge
 * starting after PPM was off through it — sends one "While you were away" header and the held
 * cards, oldest first. A held card that stopped waiting meanwhile (answered in PPM, gone with its
 * request) is skipped rather than sent late. An `urgent` card always goes at once: the report tool
 * already made any urgent card past the per-window cap into a held decision.
 *
 * Only cards are held. The user's own conversation with the Assistant on Telegram is never held,
 * and the wake turns PPM would start are gated by the wake queue itself, so nothing waits mid-stream.
 */
import { createLogger } from "../logger.ts";
import { assistantClock, type AssistantClock, type Cancel } from "../assistant-wake/assistant-clock.ts";
import { currentQuietWindowEnd } from "../assistant-wake/wake-quiet-hours.ts";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { getCardRow, type CardOutbound, type CardRow } from "./assistant-cards-db.ts";
import { listHeldCardRows, setCardOutbound } from "./assistant-cards-outbound-db.ts";

const log = createLogger("assistant-cards");

/** Where cards are shown on the phone: the Telegram bridge while it runs. */
export interface CardOutboundSink {
  /** Whether a send now reaches anyone: the bridge runs and some chat is connected. */
  ready(): boolean;
  /** Shows these cards, after `header` when there is one. */
  send(cards: AssistantCard[], header?: string): void;
  /** A card shown earlier stopped waiting: its copies lose their buttons and say how it ended. */
  changed(card: AssistantCard): void;
}

export interface CardOutboundDeps {
  cards: Pick<AssistantCards, "onChange" | "toCard">;
  clock: AssistantClock;
  /** When the quiet window now running ends; null outside quiet hours. */
  quietEnd(): number | null;
  held(): CardRow[];
  row(id: string): CardRow | null;
  setOutbound(id: string, outbound: CardOutbound, at: number): void;
}

const realDeps: CardOutboundDeps = {
  cards: assistantCards,
  clock: assistantClock,
  quietEnd: currentQuietWindowEnd,
  held: listHeldCardRows,
  row: getCardRow,
  setOutbound: (id, outbound, at) => { setCardOutbound(id, outbound, at); },
};

const STILL_SHOWN = new Set(["open", "info"]);
const MIN_TIMER_MS = 1000;

export const awayHeader = (n: number): string => `While you were away: ${n} item${n === 1 ? "" : "s"}`;

export function createCardOutbound(deps: CardOutboundDeps = realDeps) {
  let sink: CardOutboundSink | null = null;
  let off: (() => void) | null = null;
  let timer: Cancel | null = null;

  const safeQuietEnd = (): number | null => {
    try { return deps.quietEnd(); } catch (e) { log.warn(`quiet hours unreadable, sending: ${(e as Error).message}`); return null; }
  };

  function schedule(at: number): void {
    timer?.();
    timer = deps.clock.setTimer(() => { timer = null; flush(); }, Math.max(MIN_TIMER_MS, at - deps.clock.now()));
  }

  function onCreated(card: AssistantCard): void {
    const now = deps.clock.now();
    if (!sink?.ready()) return deps.setOutbound(card.id, "skipped", now);
    const end = card.kind === "urgent" ? null : safeQuietEnd();
    if (end !== null) {
      deps.setOutbound(card.id, "held", now);
      log.info(`card ${card.id} held for the end of quiet hours`);
      if (!timer) schedule(end);
      return;
    }
    deps.setOutbound(card.id, "sent", now);
    sink.send([card]);
  }

  function onChanged(card: AssistantCard): void {
    if (STILL_SHOWN.has(card.status)) return;
    if (deps.row(card.id)?.outbound === "sent") sink?.changed(card);
  }

  /** Sends what quiet hours held, once they are over; skips cards that stopped waiting. */
  function flush(): void {
    const end = safeQuietEnd();
    if (end !== null) { schedule(end); return; }
    const rows = deps.held();
    if (rows.length === 0 || !sink?.ready()) return;
    const now = deps.clock.now();
    const sendable: AssistantCard[] = [];
    for (const row of rows) {
      if (STILL_SHOWN.has(row.status)) sendable.push(deps.cards.toCard(row));
      else deps.setOutbound(row.id, "skipped", now);
    }
    if (sendable.length === 0) return;
    for (const card of sendable) deps.setOutbound(card.id, "sent", now);
    log.info(`quiet hours over: ${sendable.length} held card(s) sent`);
    sink.send(sendable, awayHeader(sendable.length));
  }

  return {
    /** The bridge started: cards go to it, and what quiet hours held goes out if they are over. */
    attach(s: CardOutboundSink): void {
      sink = s;
      off ??= deps.cards.onChange((card, change) => (change === "created" ? onCreated(card) : onChanged(card)));
      flush();
    },
    detach(s?: CardOutboundSink): void {
      if (s && sink !== s) return;
      sink = null;
      off?.();
      off = null;
      timer?.();
      timer = null;
    },
    flush,
  };
}

export type CardOutboundGate = ReturnType<typeof createCardOutbound>;

/** The process-wide gate; the Telegram bridge attaches to it while it runs. */
export const cardOutbound = createCardOutbound();
