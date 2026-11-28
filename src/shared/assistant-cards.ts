/**
 * The PPM Assistant's cards: what needs the user, built by PPM from a manager chat's report or from
 * what PPM saw in that chat, and stored so every surface (the Assistant window, Telegram, the
 * morning digest) shows the same thing. Shared by the server and the browser.
 */
import type { DigestProject, DigestResurfacedTask, DigestVoiceLearned } from "./assistant-digest.ts";
import type { CardFile } from "./card-files.ts";

export type { CardFile } from "./card-files.ts";

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

/**
 * The kinds a manager chat (or the PPM Assistant) may withdraw or replace: its own reports. A chat's
 * approval or question mirror ends with its request, and a rules change or a budget pause is the
 * user's own decision, so those never are.
 */
export const WITHDRAWABLE_CARD_KINDS: readonly AssistantCardKind[] = ["needs_decision", "urgent", "done", "failed"];

/** How a card its author took back was taken back: stored with the card's answer. */
export interface CardWithdrawal {
  /** The chat that withdrew it (a manager chat, or the PPM Assistant). */
  sessionId: string;
  reason: string;
  /** The card that replaces it, when one does. */
  supersededBy?: { id: string; title: string };
  /** The turn of that chat it was withdrawn in, when PPM knew it (what the per-turn limit counts). */
  turnId?: string;
}

/** Who answered a card, where, and when. */
export interface AssistantCardAnswer {
  /**
   * `manager` and `assistant`: the card's author took it back (`withdrawn`); nobody answered it, so
   * the card is `dismissed` and any surface may tell the user so.
   */
  by: "user" | "ppm" | "manager" | "assistant";
  channel: "ppm" | "telegram" | "chat";
  at: number;
  /** For an approval: whether it was allowed. */
  approved?: boolean;
  /** What happened, in a few words ("No longer waiting", "Sent with your OK on Telegram"). */
  note?: string;
  /** The user's OK on a needs-decision card, forwarded to its manager. */
  ok?: boolean;
  /** The option the user picked on a card that offered choices, as the card showed it. */
  choice?: { id: string; label: string };
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
  /** Set when the card's author withdrew it (or replaced it with another card). */
  withdrawn?: CardWithdrawal;
}

/** The manager's answer to a reply on a card, shown under the card. */
export interface CardFollowUp {
  /** The turn's answer; empty when the manager answered with a new card (`newCards`). */
  text: string;
  truncated: boolean;
  at: number;
  /**
   * The cards the manager opened to answer: then they are the answer, and only they are named here
   * — the turn's text repeats what they say.
   */
  newCards?: Array<{ id: string; title: string }>;
  /**
   * The start of the user's reply this answers, as plain text (`markdownPreview`, at most
   * `CARD_REPLY_PREVIEW_CHARS`) after the vault scrubber: a folded card shows it beside the answer.
   * Absent on answers kept before it was stored, and on a reply of images only.
   */
  reply?: string;
}

/** A design screenshot on a card: the kept shot's id and what it shows. */
export interface CardImage {
  id: string;
  /** The design's title and the variant's file and label, as the card names the picture. */
  designTitle: string;
  file: string;
  label: string;
}

/**
 * One of the choices a manager offers on a decision card: a button of its own, in PPM and on
 * Telegram. `id` is the manager's short name for it, `label` what the button says.
 */
export interface CardOption {
  id: string;
  label: string;
  description?: string;
}

/** Fewest and most choices one card offers, and how long their parts may be. */
export const CARD_OPTIONS_MIN = 2;
export const CARD_OPTIONS_MAX = 6;
export const CARD_OPTION_ID_MAX = 32;
export const CARD_OPTION_LABEL_MAX = 80;
export const CARD_OPTION_DESCRIPTION_MAX = 300;
/** A choice's id: short, lower-case, safe to show and to put in a message as it is. */
export const CARD_OPTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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
  /**
   * Decision cards: the choices the manager offers, each a button in place of OK. Never with a
   * draft: the button the user presses is the whole answer.
   */
  options?: CardOption[];
  /** Digest cards before the digest was put together by PPM: one manager's items. */
  items?: string[];
  /** Digest cards: the user's local date the digest belongs to ("YYYY-MM-DD"). */
  date?: string;
  /** Digest cards: one section per project that was asked, in the order they were asked. */
  projects?: DigestProject[];
  /** Digest cards: tasks back from a snooze that day (PPM's own section, not a manager's words). */
  resurfaced?: DigestResurfacedTask[];
  /** Digest cards, Mondays: the words voice self-learning added this past week (informs only). */
  voiceLearned?: DigestVoiceLearned[];
  /**
   * Report cards: design screenshots the manager attached (`design_screenshot` ids), shown on the
   * card and sent to Telegram with it as pictures.
   */
  images?: CardImage[];
  /**
   * Report cards: files from the manager's disk (`report_to_assistant { files }`), copied into PPM's
   * card-file store when the report was filed; shown on the card and sent to Telegram after it.
   */
  files?: CardFile[];
  /** Report cards: filed by a subagent of the manager rather than the manager itself. */
  subagent?: boolean;
  /** Report cards: the manager asked for urgent, and the per-window cap turned it into a decision. */
  urgentCapped?: boolean;
  /** Approval and question cards: the request in the manager chat this mirrors. */
  requestId?: string;
  /**
   * Approval and question cards of a chat that is not a manager (`sessionId` is that chat): its
   * name and provider as PPM recorded them when the card was made. Absent on a manager's card.
   */
  chat?: { title: string; providerId: string };
  /** Approval cards: when the request gives up by itself if nobody answers (ms since the epoch). */
  expiresAt?: number;
  /**
   * Approval cards answered in the chat in PPM only: a `db_execute` change or a vault unlock, both
   * of which take a password typed into PPM. Such a card has no Allow or Deny anywhere else.
   */
  answerInPpm?: "db_execute" | "vault" | "design" | "mcp_sign_in";
  /**
   * Approval and question cards: the card waits behind another card of the same chat, so it cannot
   * be answered yet anywhere (no buttons). Cleared when it reaches the front.
   */
  queued?: boolean;
  /**
   * Approval and question cards left unanswered past `APPROVAL_OVERDUE_MS`: when the chat started
   * waiting on it (ms since the epoch). The chat has done nothing since.
   */
  waitingSince?: number;
  /** An overdue card of a turn a schedule started: nobody is at that chat, and its schedule is stuck too. */
  scheduledTurn?: boolean;
  /** A Design chat's card (`answerInPpm: "design"`): the design that opens it. */
  design?: { slug: string };
  /** An MCP sign-in card (`answerInPpm: "mcp_sign_in"`): the server that needs signing in to. */
  mcpServer?: string;
  /**
   * Approval cards: what "approve this kind next time" would remember, and whether the card
   * suggests it (the user approved the same kind by hand often enough). Worked out by PPM.
   */
  remember?: { label: string; suggest: boolean };
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
  /**
   * Cards the handed-off work checker raised: the tasks it found, each with the chat working on it,
   * so every surface can offer "Open chat" per task (and open the task by id).
   */
  tasks?: Array<{
    taskId: string; sessionId: string; ref: string;
    /** The task's title when the card was made; absent on cards made before it was carried. */
    title?: string;
  }>;
  /**
   * The "made N task changes while you were away" card: each change with the history row that
   * undoes it (null for a settings change, which cannot be undone), so a surface can offer Undo
   * per change.
   */
  taskChanges?: Array<{
    historyId: number | null; taskId: string | null; ref: string | null; summary: string;
    /** The change's project, so a surface can keep a title-only project's details off a phone. */
    projectKey?: string;
  }>;
  /** Changes past the ones listed in `taskChanges` (each task's History in PPM has them). */
  taskChangesMore?: number;
  /**
   * A report card the PPM Assistant wrote (the "while you were away" task changes card), not a
   * manager: its provenance line names the Assistant.
   */
  byAssistant?: boolean;
  /** Report cards: the earlier cards of the same manager this card replaces (they were withdrawn). */
  supersedes?: Array<{ id: string; title: string }>;
  /** Report cards: the PPM task the manager said the card is about (`report_to_assistant` `task`). */
  aboutTask?: { taskId: string; ref: string; title?: string };
  /**
   * A waiting card whose `aboutTask` was closed since: the card still waits (only its author or the
   * user closes it), and says so. Cleared when the task is opened again.
   */
  taskClosed?: { closedAs: "done" | "dropped" | null; at: number };
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
  /**
   * The manager's answer to the user's reply on this card: the text of the turn the reply opened,
   * cut to `CARD_FOLLOWUP_MAX_CHARS` (`truncated` then; the rest is in the manager chat). Kept apart
   * from `answer`, because a card replied to after it closed (a done report) has no answer, and
   * none may be made up for it.
   */
  followUp?: CardFollowUp;
  /** Server-written line separating a manager's own words from PPM's ("Written by the X manager AI"). */
  provenance: string | null;
  /**
   * A needs-decision card may take "OK, send" (or "OK"), or on a card with `payload.options` a
   * press on one of its choices: the title, body, draft and choices are shown whole and nothing in
   * them was hidden as a secret. Worked out by the server, on every surface alike.
   */
  okOffered?: boolean;
  /**
   * Whether the card went to Telegram: `sent`, `held` for the end of quiet hours, `skipped` (no
   * Telegram chat could be reached when it was made), `pending` before it was decided.
   */
  outbound?: "pending" | "held" | "sent" | "skipped";
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

/** The withdrawal on a card its author took back; null for any other card. */
export function cardWithdrawal(card: { status: AssistantCardStatus; answer: AssistantCardAnswer | null }): CardWithdrawal | null {
  return card.status === "dismissed" && card.answer?.withdrawn ? card.answer.withdrawn : null;
}

/** The server-written line on a report card the PPM Assistant wrote itself. */
export const ASSISTANT_PROVENANCE = "Written by the PPM Assistant";

/** The server-written line on the morning digest PPM put together. */
export const DIGEST_PROVENANCE = "Put together by PPM; each item was written by that project's manager AI";

/**
 * The server-written line on a card filed by a manager chat; null for PPM's own cards, a failure
 * PPM saw itself (`detected`) included.
 */
export function reportProvenanceLine(kind: AssistantCardKind, projectName: string | null, subagent: boolean, detected = false, byAssistant = false): string | null {
  if (detected || !(REPORT_KINDS as readonly string[]).includes(kind)) return null;
  if (byAssistant) return ASSISTANT_PROVENANCE;
  // The digest is PPM's card; only its items are the managers' words.
  if (kind === "digest" && !projectName) return DIGEST_PROVENANCE;
  const project = projectName ?? "project";
  if (subagent) return `From a subagent of the ${project} manager`;
  if (kind === "urgent") return `Marked urgent by the ${project} manager AI`;
  return `Written by the ${project} manager AI`;
}
