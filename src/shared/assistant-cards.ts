/**
 * The PPM Assistant's cards: what needs the user, built by PPM from a manager chat's report or from
 * what PPM saw in that chat, and stored so every surface (the Assistant window, Telegram, the
 * morning digest) shows the same thing. Shared by the server and the browser.
 */
import type { DigestProject } from "./assistant-digest.ts";

export const ASSISTANT_CARD_KINDS = [
  "needs_decision", "urgent", "approval", "question", "done", "failed", "digest", "rules_note", "rules_change", "budget",
] as const;
export type AssistantCardKind = (typeof ASSISTANT_CARD_KINDS)[number];

export const ASSISTANT_CARD_STATUSES = ["open", "answered", "dismissed", "resolved", "gone", "info"] as const;
export type AssistantCardStatus = (typeof ASSISTANT_CARD_STATUSES)[number];

/** Kinds that wait on the user while open: the waiting counts are made of these. */
export const WAITING_CARD_KINDS: readonly AssistantCardKind[] = [
  "needs_decision", "urgent", "approval", "question", "rules_change", "budget",
];

/** Kinds the user may dismiss. */
export const DISMISSABLE_CARD_KINDS: readonly AssistantCardKind[] = ["needs_decision", "urgent", "done", "failed", "budget"];

/** Kinds answered through `POST /cards/:id/answer`. */
export const ANSWERABLE_CARD_KINDS: readonly AssistantCardKind[] = ["approval", "question"];

/** Kinds that may take the user's OK (`POST /cards/:id/ok`). */
export const OK_CARD_KINDS: readonly AssistantCardKind[] = ["needs_decision", "urgent"];

/** Kinds whose reply goes to the card's manager chat; any other card's reply goes to the Assistant. */
export const MANAGER_REPLY_CARD_KINDS: readonly AssistantCardKind[] = [
  "needs_decision", "urgent", "approval", "question", "done", "failed",
];

/** The kinds a manager chat may file with `report_to_assistant`. */
export const REPORT_KINDS = ["needs_decision", "urgent", "done", "failed", "digest"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Who answered a card, where, and when. */
export interface AssistantCardAnswer {
  by: "user" | "ppm";
  channel: "ppm" | "telegram" | "chat";
  at: number;
  /** For an approval: whether it was allowed. */
  approved?: boolean;
  /** What happened, in a few words ("No longer waiting", "Sent with your OK on Telegram"). */
  note?: string;
  /** The user's OK on a needs-decision card, forwarded to its manager. */
  ok?: boolean;
  /**
   * The user's words forwarded to the manager chat: `pending` until the chat took them into a turn
   * (they may wait behind an approval), `delivered` once it did. A card whose words never arrive
   * is opened again with a note, so an answer is never lost while the card says it was given.
   */
  delivery?: "pending" | "delivered";
  /** The id the forwarded words were sent under, which the turn they open is announced with. */
  clientMessageId?: string;
  /** The manager chat the words went to. */
  deliveredTo?: string;
}

/** A draft message a manager asks the user to approve sending. */
export interface CardDraft {
  to: string;
  text: string;
  sha256: string;
}

/** What a card carries beyond its title and body; every field is optional and kind-specific. */
export interface AssistantCardPayload {
  /** Report cards: the manager's draft. */
  draft?: CardDraft;
  /** Digest cards before the digest was put together by PPM: one manager's items. */
  items?: string[];
  /** Digest cards: the user's local date the digest belongs to ("YYYY-MM-DD"). */
  date?: string;
  /** Digest cards: one section per project that was asked, in the order they were asked. */
  projects?: DigestProject[];
  /** Report cards: filed by a subagent of the manager rather than the manager itself. */
  subagent?: boolean;
  /** Report cards: the manager asked for urgent, and the per-window cap turned it into a decision. */
  urgentCapped?: boolean;
  /** Approval and question cards: the request in the manager chat this mirrors. */
  requestId?: string;
  /** Approval cards: the part a person must see before Allow means anything. */
  deciding?: {
    kind: string; title: string; facts: Array<{ label: string; value: string }>; text: string;
    label?: string; lang?: string; complete: boolean; incompleteReason?: string;
  };
  /** Question cards: the questions, as every surface answers them by id. */
  questions?: Array<{
    id: string; question: string; header?: string; multiSelect?: boolean; allowsFreeText?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  /** Rules notes: the lines added and removed. */
  added?: string[];
  removed?: string[];
  /** A held rules change: every added and removed line, in file order, as the card shows them. */
  changes?: Array<{ op: "add" | "remove"; line: string }>;
  /**
   * A held rules change: `changes` is the whole change, every line uncut and unaltered, so
   * Approve on the card approves exactly what it shows. Absent means decide in Settings.
   */
  rulesComplete?: boolean;
  rulesHash?: string;
  rulesReason?: string;
  /** Budget cards: the Assistant session that paused. */
  assistantSessionId?: string;
  /** Failed cards PPM raised: how the turn ended. */
  detected?: boolean;
}

export interface AssistantCard {
  id: string;
  kind: AssistantCardKind;
  /** The project's name as PPM lists it, when the card belongs to one. */
  projectName: string | null;
  projectKey: string | null;
  /** The manager chat the card came from, when it came from one. */
  sessionId: string | null;
  title: string;
  body: string;
  payload: AssistantCardPayload;
  status: AssistantCardStatus;
  answer: AssistantCardAnswer | null;
  /** Server-written line separating a manager's own words from PPM's ("Written by the X manager AI"). */
  provenance: string | null;
  /**
   * A needs-decision card may take "OK, send" (or "OK"): the title, body and draft are shown whole
   * and nothing in them was hidden as a secret. Worked out by the server, on every surface alike.
   */
  okOffered?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AssistantWaiting {
  total: number;
  byProject: Record<string, number>;
}

export interface AssistantCardsPage {
  cards: AssistantCard[];
  /** Pass as `before` to read the next older page; null when there is none. */
  nextBefore: number | null;
}

/** The whole final text of a wake turn that has nothing to tell the user. */
export const NO_REPLY_TEXT = "[no reply]";

/** Whether a turn's final text is the "nothing to say" answer, so it can be collapsed. */
export function isNoReplyText(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim().toLowerCase() === NO_REPLY_TEXT;
}

/** The server-written line on the morning digest PPM put together. */
export const DIGEST_PROVENANCE = "Put together by PPM; each item was written by that project's manager AI";

/**
 * The server-written line on a card filed by a manager chat; null for PPM's own cards, a failure
 * PPM saw itself (`detected`) included.
 */
export function reportProvenanceLine(kind: AssistantCardKind, projectName: string | null, subagent: boolean, detected = false): string | null {
  if (detected || !(REPORT_KINDS as readonly string[]).includes(kind)) return null;
  // The digest is PPM's card; only its items are the managers' words.
  if (kind === "digest" && !projectName) return DIGEST_PROVENANCE;
  const project = projectName ?? "project";
  if (subagent) return `From a subagent of the ${project} manager`;
  if (kind === "urgent") return `Marked urgent by the ${project} manager AI`;
  return `Written by the ${project} manager AI`;
}
