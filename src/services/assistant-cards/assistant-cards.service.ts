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
  type AssistantCardsPage, type AssistantCardStatus, type AssistantWaiting,
} from "../../shared/assistant-cards.ts";
import {
  casCardStatus, getCardRow, insertCardRow, listCardRows, listOpenCardRows, setAnsweredCardAnswer, setCardWake, type CardRow, type CardWake,
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

export type CardChange = "created" | "changed";
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
    const card: AssistantCard = {
      id: row.id, kind: row.kind, projectName, projectKey: row.projectKey, sessionId: row.sessionId,
      title: row.title, body: row.body, payload, status: row.status, answer: row.answer,
      provenance: reportProvenanceLine(row.kind, projectName, payload.subagent === true, payload.detected === true),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
    // Judged on the card as shown (its project and provenance lines count towards what must fit).
    return cardOkOffered(card) ? { ...card, okOffered: true } : card;
  }

  function waiting(): AssistantWaiting {
    const projects = env.projects();
    const byProject: Record<string, number> = {};
    let total = 0;
    for (const row of listOpenCardRows()) {
      total++;
      const name = nameOf(row, projects);
      if (name) byProject[name] = (byProject[name] ?? 0) + 1;
    }
    return { total, byProject };
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
