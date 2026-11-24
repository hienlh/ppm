/**
 * The PPM Assistant's cards: created by PPM only (from a manager chat's report, from what PPM saw in
 * a manager chat, from a rules or budget event), stored, and announced on `/ws/global`. A card never
 * waits on a model turn: it is in front of the user the moment it is stored.
 *
 * Every status change is compare-and-set, so the first answer wins on every surface and a second
 * one learns it was too late. Listeners (the wake queue, later the Telegram outbound) hear every
 * created or changed card; they only record and enqueue.
 */
import { configService } from "../config.service.ts";
import { createLogger } from "../logger.ts";
import { projectKey as keyOf } from "../project-name-for-path.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import {
  reportProvenanceLine, WAITING_CARD_KINDS,
  type AssistantCard, type AssistantCardAnswer, type AssistantCardKind, type AssistantCardPayload,
  type AssistantCardsPage, type AssistantCardStatus, type AssistantWaiting, type CardFollowUp,
} from "../../shared/assistant-cards.ts";
import {
  casCardStatus, getCardRow, insertCardRow, listCardRows, listOpenCardRows, patchOpenCardPayload, setAnsweredCardAnswer, setCardFollowUp, setCardWake,
  type CardRow, type CardWake,
} from "./assistant-cards-db.ts";
import { cardOkOffered } from "./card-ok-rule.ts";

const log = createLogger("assistant-cards");

export interface NewCard {
  kind: AssistantCardKind;
  projectName: string | null;
  projectPath: string | null;
  /** The project's key when the caller has it rather than the path. */
  projectKey?: string | null;
  sessionId: string | null;
  title: string;
  body?: string;
  payload?: AssistantCardPayload;
  /** The card carries news the Assistant must be told (done, failed and urgent reports, the digest). */
  wake?: boolean;
}

/**
 * `shown`: a queued approval or question card reached the front of its chat and can be answered
 * now (Telegram sends it then). `overdue`: an approval or question card has stood unanswered past
 * `APPROVAL_OVERDUE_MS` (Telegram rings once more).
 */
export type CardChange = "created" | "changed" | "shown" | "overdue";
export type CardListener = (card: AssistantCard, change: CardChange) => void;

export interface CardsEnv {
  now(): number;
  projects(): Array<{ name: string; path: string }>;
  announce(card: AssistantCard, waiting: AssistantWaiting, waitingMoved: boolean): void;
}

const realEnv: CardsEnv = {
  now: () => assistantClock.now(),
  projects: () => configService.get("projects"),
  announce: (card, waiting, moved) => {
    void import("./assistant-cards-announce.ts").then(({ announceCard }) => announceCard(card, waiting, moved)).catch(() => {});
  },
};

/** What `transition` reports: the card after the attempt, and whether this caller changed it. */
export type TransitionResult = { ok: true; card: AssistantCard } | { ok: false; card: AssistantCard | null };

export function createAssistantCards(env: CardsEnv = realEnv) {
  const listeners = new Set<CardListener>();
  const isWaiting = (row: CardRow) => row.status === "open" && WAITING_CARD_KINDS.includes(row.kind);

  /** The project's name as PPM lists it now, else the name it had when the card was made. */
  function nameOf(row: CardRow, projects = env.projects()): string | null {
    if (!row.projectKey) return row.payload.projectName ?? null;
    return projects.find((p) => keyOf(p.path) === row.projectKey)?.name ?? row.payload.projectName ?? null;
  }

  function toCard(row: CardRow, projects = env.projects()): AssistantCard {
    const { projectName: _stored, ...payload } = row.payload;
    const projectName = nameOf(row, projects);
    // The stored answer carries the follow-up for rewrites to keep; a card shows it on its own.
    const { followUp: _inAnswer, ...answer } = (row.answer ?? {}) as AssistantCardAnswer & { followUp?: unknown };
    const card: AssistantCard = {
      id: row.id, kind: row.kind, projectName, projectKey: row.projectKey, sessionId: row.sessionId,
      title: row.title, body: row.body, payload, status: row.status, answer: row.answer ? answer : null,
      ...(row.followUp ? { followUp: row.followUp } : {}),
      provenance: reportProvenanceLine(row.kind, projectName, payload.subagent === true, payload.detected === true, payload.byAssistant === true),
      outbound: row.outbound,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
    // Judged on the card as shown (its project and provenance lines count towards what must fit).
    return cardOkOffered(card) ? { ...card, okOffered: true } : card;
  }

  /**
   * Every card that waits on the user, oldest first: exactly what the waiting counts are made of,
   * so a count on screen always matches the cards the user can find behind it.
   */
  function openCards(projectName?: string): AssistantCard[] {
    const projects = env.projects();
    const cards = listOpenCardRows().map((row) => toCard(row, projects));
    return projectName === undefined ? cards : cards.filter((c) => c.projectName === projectName);
  }

  function waiting(): AssistantWaiting {
    const byProject: Record<string, number> = {};
    const cards = openCards();
    for (const card of cards) {
      if (card.projectName) byProject[card.projectName] = (byProject[card.projectName] ?? 0) + 1;
    }
    return { total: cards.length, byProject };
  }

  function tell(row: CardRow, change: CardChange, waitingMoved: boolean): AssistantCard {
    const card = toCard(row);
    env.announce(card, waiting(), waitingMoved);
    for (const listener of [...listeners]) {
      try { listener(card, change); } catch (e) { log.warn(`card listener failed: ${(e as Error).message}`); }
    }
    return card;
  }

  return {
    toCard,
    waiting,
    openCards,
    onChange(listener: CardListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    create(input: NewCard): AssistantCard {
      const status: AssistantCardStatus = input.kind === "rules_note" ? "info" : "open";
      const row = insertCardRow({
        kind: input.kind,
        projectKey: input.projectKey ?? (input.projectPath ? keyOf(input.projectPath) : null),
        sessionId: input.sessionId,
        title: input.title,
        body: input.body ?? "",
        payload: { ...(input.payload ?? {}), ...(input.projectName ? { projectName: input.projectName } : {}) },
        status,
        wake: input.wake ? "pending" : "none",
        at: env.now(),
      });
      log.info(`card ${row.id} ${row.kind}${input.projectName ? ` project=${input.projectName}` : ""}${input.wake ? " wake" : ""}`);
      return tell(row, "created", isWaiting(row));
    },
    get(id: string): AssistantCard | null {
      const row = getCardRow(id);
      return row ? toCard(row) : null;
    },
    row: getCardRow,
    /** Moves an open card to `to`; the second caller gets `ok: false` and the card as it is. */
    transition(id: string, to: Exclude<AssistantCardStatus, "open" | "info">, answer: AssistantCardAnswer | null): TransitionResult {
      const before = getCardRow(id);
      if (!before) return { ok: false, card: null };
      if (!casCardStatus(id, "open", to, answer, env.now())) return { ok: false, card: toCard(getCardRow(id) ?? before) };
      const after = getCardRow(id)!;
      return { ok: true, card: tell(after, "changed", isWaiting(before)) };
    },
    /**
     * Puts a card this caller just answered back to open: what the answer had to do (forward the
     * user's words) did not happen, so the card still waits. Only from `answered`, only once.
     */
    reopen(id: string, note?: string): boolean {
      const at = env.now();
      // An open card keeps a note only to say why it waits again ("did not reach the manager").
      if (!casCardStatus(id, "answered", "open", note ? { by: "ppm", channel: "ppm", at, note } : null, at)) return false;
      const row = getCardRow(id);
      if (row) tell(row, "changed", isWaiting(row));
      return true;
    },
    /**
     * Puts the manager's answer to a reply under the card and tells every PPM tab. Card listeners
     * are not told: nothing about whether the card waits changed, and its Telegram copies were
     * answered in place by the follow-up itself.
     */
    setFollowUp(id: string, followUp: CardFollowUp): boolean {
      if (!setCardFollowUp(id, followUp, env.now())) return false;
      const row = getCardRow(id);
      if (row) env.announce(toCard(row), waiting(), false);
      return true;
    },
    /**
     * Updates what an open card says about its request (queued, overdue) and tells every PPM tab
     * and card listener with `change`; false when the card no longer waits.
     */
    patchPayload(id: string, patch: Partial<AssistantCardPayload>, change: Extract<CardChange, "changed" | "shown" | "overdue">): AssistantCard | null {
      if (!patchOpenCardPayload(id, patch, env.now())) return null;
      const row = getCardRow(id);
      return row ? tell(row, change, false) : null;
    },
    /** Adds to the answer of a card still answered (how its words were delivered); false otherwise. */
    amendAnswer(id: string, patch: Partial<AssistantCardAnswer>): boolean {
      const row = getCardRow(id);
      if (!row || row.status !== "answered" || !row.answer) return false;
      return setAnsweredCardAnswer(id, { ...row.answer, ...patch }, env.now());
    },
    setWake(id: string, wake: CardWake): void {
      setCardWake(id, wake, env.now());
    },
    list(q: { before?: number; limit: number; projectName?: string }): AssistantCardsPage {
      let projectKey: string | undefined;
      if (q.projectName !== undefined) {
        const project = env.projects().find((p) => p.name === q.projectName);
        // A project PPM no longer lists has no cards to show under that name.
        if (!project) return { cards: [], nextBefore: null };
        projectKey = keyOf(project.path);
      }
      const rows = listCardRows({ ...(q.before !== undefined ? { before: q.before } : {}), limit: q.limit + 1, ...(projectKey ? { projectKey } : {}) });
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const projects = env.projects();
      return { cards: page.map((r) => toCard(r, projects)), nextBefore: more ? page.at(-1)!.createdAt : null };
    },
  };
}

export type AssistantCards = ReturnType<typeof createAssistantCards>;

/** The process-wide card store. */
export const assistantCards = createAssistantCards();
