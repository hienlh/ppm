/**
 * Which of the PPM Assistant's cards go to the user's phone, and when.
 *
 * A new card goes to Telegram at once, unless quiet hours are on: then it is `held` in the
 * database, and the first moment they are over — a clock timer at the window's end, or the bridge
 * starting after PPM was off through it — sends one "While you were away" header and the held
 * cards, oldest first. A held card that stopped waiting meanwhile (answered in PPM, gone with its
 * request) is skipped rather than sent late. An `urgent` card always goes at once: the report tool
 * already made any urgent card past the per-window cap into a held decision. So does a card that
 * answers a reply the user typed on Telegram moments ago: it is the answer they are waiting for.
 *
 * A chat's approval or question made while nothing could carry it to the phone (the bridge not
 * running yet, or running with no chat connected) is not lost: once a chat can be reached it goes
 * out under one "Still waiting for you" header, if it still waits — the chat it came from is stopped
 * until someone answers, and nobody may know that otherwise. Other kinds made then stay in PPM.
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
import { listHeldCardRows, listUnsentWaitingCardRows, setCardOutbound } from "./assistant-cards-outbound-db.ts";
import { repliesBeingAnswered } from "./replies-being-answered.ts";
import { isAnswerCard } from "./card-reply-followup-tracker.ts";
import { CARD_FOLLOWUP_LOUD_MS } from "../../shared/assistant-limits.ts";

const log = createLogger("assistant-cards");

/** Where cards are shown on the phone: the Telegram bridge while it runs. */
export interface CardOutboundSink {
  /** Whether a send now reaches anyone: the bridge runs and some chat is connected. */
  ready(): boolean;
  /** Shows these cards, after `header` when there is one. */
  send(cards: AssistantCard[], header?: string): void;
  /** A card shown earlier stopped waiting: its copies lose their buttons and say how it ended. */
  changed(card: AssistantCard): void;
  /**
   * A card sent earlier has stood unanswered past `APPROVAL_OVERDUE_MS`: one more message, with a
   * sound whether or not the user is at PPM, saying the chat has waited since `waitingSince`.
   */
  overdue?(card: AssistantCard): void;
}

export interface CardOutboundDeps {
  cards: Pick<AssistantCards, "onChange" | "toCard">;
  clock: AssistantClock;
  /** When the quiet window now running ends; null outside quiet hours. */
  quietEnd(): number | null;
  held(): CardRow[];
  /** Open approvals and questions that never went out (see the header); none when left out. */
  unsentWaiting?(): CardRow[];
  row(id: string): CardRow | null;
  setOutbound(id: string, outbound: CardOutbound, at: number): void;
  /**
   * Whether the card answers a reply the user typed on Telegram moments ago (within
   * {@link CARD_FOLLOWUP_LOUD_MS}): they are holding the phone and waiting for it, so quiet hours
   * do not hold it — the same rule as the follow-up it replaces. Never when left out.
   */
  answersPhone?(card: AssistantCard): boolean;
}

/** The real {@link CardOutboundDeps.answersPhone}: a reply on Telegram the card's turn is answering. */
function answersPhoneNow(card: AssistantCard): boolean {
  if (!isAnswerCard(card)) return false;
  const now = assistantClock.now();
  return repliesBeingAnswered(card.sessionId).some((a) =>
    a.origin.channel === "telegram" && card.createdAt >= a.repliedAt && now - a.repliedAt <= CARD_FOLLOWUP_LOUD_MS);
}

const realDeps: CardOutboundDeps = {
  cards: assistantCards,
  clock: assistantClock,
  quietEnd: currentQuietWindowEnd,
  held: listHeldCardRows,
  unsentWaiting: listUnsentWaitingCardRows,
  row: getCardRow,
  setOutbound: (id, outbound, at) => { setCardOutbound(id, outbound, at); },
  answersPhone: answersPhoneNow,
};

const STILL_SHOWN = new Set(["open", "info"]);
const MIN_TIMER_MS = 1000;

export const awayHeader = (n: number): string => `While you were away: ${n} item${n === 1 ? "" : "s"}`;
export const stillWaitingHeader = (n: number): string => `Still waiting for you: ${n} item${n === 1 ? "" : "s"}`;

export function createCardOutbound(deps: CardOutboundDeps = realDeps) {
  let sink: CardOutboundSink | null = null;
  let off: (() => void) | null = null;
  let timer: Cancel | null = null;

  const answersPhone = (card: AssistantCard): boolean => {
    try { return deps.answersPhone?.(card) ?? false; } catch { return false; }
  };

  const safeQuietEnd = (): number | null => {
    try { return deps.quietEnd(); } catch (e) { log.warn(`quiet hours unreadable, sending: ${(e as Error).message}`); return null; }
  };

  function schedule(at: number): void {
    timer?.();
    timer = deps.clock.setTimer(() => { timer = null; flush(); }, Math.max(MIN_TIMER_MS, at - deps.clock.now()));
  }

  /** A card that must not wait for quiet hours to end: urgent, answering the phone, or a schedule's chat stuck on it. */
  const ringsNow = (card: AssistantCard): boolean => card.kind === "urgent" || card.payload.scheduledTurn === true || answersPhone(card);

  function onCreated(card: AssistantCard): void {
    // A card waiting behind another of its chat has no buttons yet: it goes out once in front.
    if (card.payload.queued) return;
    const now = deps.clock.now();
    if (!sink?.ready()) {
      log.info(`card ${card.id} not sent to Telegram: no Telegram chat can be reached`);
      return deps.setOutbound(card.id, "skipped", now);
    }
    const end = ringsNow(card) ? null : safeQuietEnd();
    if (end !== null) {
      deps.setOutbound(card.id, "held", now);
      log.info(`card ${card.id} held for the end of quiet hours`);
      if (!timer) schedule(end);
      return;
    }
    deps.setOutbound(card.id, "sent", now);
    log.info(`card ${card.id} sent to Telegram`);
    sink.send([card]);
  }

  /** A queued card reached the front of its chat: it goes out now, as a new card would. */
  function onShown(card: AssistantCard): void {
    const outbound = deps.row(card.id)?.outbound;
    if (outbound === "sent" || outbound === "held") return;
    onCreated(card);
  }

  /** A card left unanswered too long: rung once more, or sent now if it never went out. */
  function onOverdue(card: AssistantCard): void {
    if (!STILL_SHOWN.has(card.status) || !sink?.ready()) return;
    const outbound = deps.row(card.id)?.outbound;
    if (outbound !== "sent") {
      // Held for quiet hours, or made while nothing could be reached: a schedule's stuck chat goes
      // now; anything else keeps waiting for quiet hours to end like every other held card.
      if (outbound === "held" && !ringsNow(card)) return;
      deps.setOutbound(card.id, "sent", deps.clock.now());
      log.info(`card ${card.id} sent to Telegram (overdue)`);
      sink.send([card]);
      return;
    }
    if (!ringsNow(card) && safeQuietEnd() !== null) return;
    log.info(`card ${card.id} overdue: reminding on Telegram`);
    sink.overdue?.(card);
  }

  function onChanged(card: AssistantCard): void {
    // Answered on the phone, then opened again because the words never arrived: the copy there has
    // lost its buttons, so the card goes out once more, saying why.
    if (card.status === "open" && card.answer?.note) {
      if (deps.row(card.id)?.outbound === "sent" && sink?.ready()) sink.send([card]);
      return;
    }
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

  /**
   * Sends the open approvals and questions that never went out, now that a chat can be reached;
   * in quiet hours they are held for the window's end like any card made then.
   */
  function catchUp(): void {
    if (!sink?.ready() || !deps.unsentWaiting) return;
    let rows: CardRow[];
    try { rows = deps.unsentWaiting(); } catch (e) { log.warn(`unsent cards unreadable: ${(e as Error).message}`); return; }
    if (rows.length === 0) return;
    const now = deps.clock.now();
    const end = safeQuietEnd();
    if (end !== null) {
      for (const row of rows) deps.setOutbound(row.id, "held", now);
      if (!timer) schedule(end);
      return;
    }
    const cards = rows.map((row) => deps.cards.toCard(row));
    for (const card of cards) deps.setOutbound(card.id, "sent", now);
    log.info(`${cards.length} waiting card(s) that never reached the phone sent`);
    sink.send(cards, stillWaitingHeader(cards.length));
  }

  return {
    /** The bridge started: cards go to it, and what quiet hours held goes out if they are over. */
    attach(s: CardOutboundSink): void {
      sink = s;
      off ??= deps.cards.onChange((card, change) => {
        if (change === "created") onCreated(card);
        else if (change === "shown") onShown(card);
        else if (change === "overdue") onOverdue(card);
        else onChanged(card);
      });
      flush();
      catchUp();
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
    /** A chat may have become reachable (connected, bound): what never went out goes now. */
    catchUp,
  };
}

export type CardOutboundGate = ReturnType<typeof createCardOutbound>;

/** The process-wide gate; the Telegram bridge attaches to it while it runs. */
export const cardOutbound = createCardOutbound();
