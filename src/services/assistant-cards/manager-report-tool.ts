import { createHash } from "node:crypto";
import { neutralizeBlockMarkers } from "../../shared/chat-message-blocks.ts";
import {
  CARD_OPTION_DESCRIPTION_MAX, CARD_OPTION_ID_MAX, CARD_OPTION_ID_RE, CARD_OPTION_LABEL_MAX, CARD_OPTIONS_MAX, CARD_OPTIONS_MIN,
  REPORT_KINDS, type AssistantCard, type AssistantCardKind, type CardDraft, type CardImage, type CardOption, type ReportKind,
} from "../../shared/assistant-cards.ts";
import { REPORT_TO_ASSISTANT_TOOL } from "../../shared/session-collab.ts";
import { URGENT_PER_MANAGER_PER_QUIET_WINDOW } from "../../shared/assistant-limits.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";
import { cleanCardBody, cleanCardTitle, cleanOptionLabel } from "./card-text-cleaning.ts";
import { listsChoicesInText } from "./card-choices-in-text.ts";
import { createLogger } from "../logger.ts";
import type { NewCard } from "./assistant-cards.service.ts";
import { describeOpenCards, describeWithdrawals, withdrawReason, withdrawRefs, type WithdrawItem } from "./card-withdraw.ts";
import { REPORT_WITHDRAW_TOOL, WITHDRAW_CARDS_MAX } from "../../shared/card-withdraw.ts";

/**
 * `report_to_assistant`: how a project's manager chat tells the user something through PPM
 * Assistant. PPM, not the model, turns it into a card: the fields are checked and capped, every
 * PPM block marker is broken, a title cannot pose as PPM's own prompt, and the card carries a
 * server-written line saying which manager wrote it. Only the current manager chat of a project
 * may call it; it is listed for no other chat.
 *
 * A subagent of the manager reaches the same endpoint with the same token, and an MCP call carries
 * nothing that ties it to the tool call the CLI made, so PPM cannot tell the two apart: the manager
 * rules tell the manager not to take a child's word for anything.
 *
 * There is no cap on how many reports a manager files: a decision refused for being one too many
 * was simply lost. What stops a manager stuck in a loop is that a report identical to one still open
 * (kind, title, body and everything attached) is not filed again: the call gets that card back.
 *
 * A chat the manager opened has its waiting approval or question mirrored to the user already
 * (`ordinary-chat-cards.ts`), with buttons they can press. A needs_decision or urgent report about
 * that same card would be a second card asking the same thing, one they cannot answer directly, so
 * it is folded into the mirror: the call gets the mirror's id and nothing is filed. A report says
 * which chat it is about with `chat`; one that leaves it out but names exactly one chat that has
 * such a card waiting is taken to be about it, unless it carries a `draft` (a message the manager
 * means to send is its own decision).
 */

export const REPORT_TITLE_MAX = 120;
export const REPORT_BODY_MAX = 2000;
export const DRAFT_TO_MAX = 200;
export const DRAFT_TEXT_MAX = 4000;
export const DIGEST_ITEMS_MAX = 12;
export const DIGEST_ITEM_MAX = 200;
/** Pictures one card carries at most (one Telegram album holds ten). */
export const REPORT_IMAGES_MAX = 6;
/** The longest `chat` a report names: a session id, with room to spare. */
export const REPORT_CHAT_MAX = 100;
const HOUR_MS = 60 * 60_000;
const log = createLogger("assistant-cards");

/** Told to a manager whose choices could not be buttons (too long together, or a hidden value). */
export const CHOICES_NOT_PRESSABLE_NOTE = "These choices are too long to show whole on the user's phone, or a part of the "
  + "card was hidden as a secret, so they are listed without buttons and the user must reply in words. Shorten the "
  + "body or labels, or take the secret out, to give the user buttons.";

/** Told to a manager whose card lists choices in its text instead of in `options`. */
export const CHOICES_IN_TEXT_NOTE = "This card lists choices in its text, so the user gets no button for them. "
  + "Next time put each choice in `options` (2 to 6): each becomes a button the user can press.";

export interface ReportCaller {
  sessionId: string;
  projectName: string;
  projectPath: string;
}

export interface ReportEnv {
  now(): number;
  /** Cards of `kinds` this manager filed or raised since `since`. */
  countSince(sessionId: string, kinds: readonly AssistantCardKind[], since: number): number;
  /** An open urgent card of this manager with this exact title since `since`, if any. */
  openUrgentTitled(sessionId: string, title: string, since: number): AssistantCard | null;
  /** An open card of this manager that is the same report as `card` ({@link sameReport}), if any. */
  openIdentical(sessionId: string, card: NewCard): AssistantCard | null;
  /**
   * The open approval or question card mirroring what `chatSessionId`, a chat of this project other
   * than the manager, waits on; null when it waits on none. Absent where no mirrors exist.
   */
  waitingChatCard?(projectPath: string, chatSessionId: string): AssistantCard | null;
  /**
   * A design screenshot of this project, by id; null when it is not one (unknown, too old, or of
   * another project). Absent where no screenshots exist.
   */
  shotOf?(id: string, projectPath: string): CardImage | null;
  /** When the current quiet window began; null outside quiet hours. */
  quietWindowStart(): number | null;
  /**
   * A digest answer, handed to the morning digest: taken while that digest's ask to this manager is
   * open (a second answer replaces the first), refused with the reason otherwise.
   */
  digestAnswer(sessionId: string, items: string[]): { ok: true } | { ok: false; message: string };
  create(card: NewCard): AssistantCard;
  /**
   * Card withdrawal (`supersedes`, `task` and the list of open cards): on only when the user turned
   * it on. Absent means off.
   */
  withdrawOn?(): boolean;
  /** A task of the manager's project, by `ppm/76`, `#76` or `76`; a message saying why not otherwise. */
  resolveTask?(projectPath: string, ref: string): { taskId: string; ref: string; title: string } | { error: string };
  /** Withdraws `refs` for this manager, each replaced by `by`. */
  withdraw?(caller: ReportCaller, refs: readonly string[], reason: string, by: { id: string; title: string } | undefined, dryRun?: boolean): WithdrawItem[];
  /** Records on a card (one a report was merged into) which earlier cards it replaces. */
  markSupersedes?(cardId: string, replaced: Array<{ id: string; title: string }>): void;
  /** This manager's other cards it may still withdraw, oldest first. */
  openOwnCards?(caller: ReportCaller, except: string): AssistantCard[];
}

/** A digest answer makes no card of its own: PPM puts every answer on one card later. */
export type ReportResult =
  | { ok: true; cardId?: string; kind: AssistantCardKind; note?: string; withdrawn?: WithdrawItem[] }
  | { ok: false; message: string };

/** Told to a manager that used `supersedes` or `task` while the user has card withdrawal off. */
export const WITHDRAW_OFF_NOTE = "The user has not turned on card withdrawal (Settings → Tools → Cards), so `supersedes` "
  + "and `task` are not available: leave them out.";
/** The longest task reference a report takes. */
export const REPORT_TASK_MAX = 60;

/** Told to a manager whose digest answer was taken: how many lines went in, so a slip is visible. */
export function digestTakenNote(count: number): string {
  const lines = count === 0 ? "Your answer, with no items, is" : count === 1 ? "Your 1 item is" : `Your ${count} items are`;
  return `${lines} in the morning digest PPM is putting together. A second digest answer replaces this one.`;
}
export const DIGEST_ITEMS_REQUIRED = "A digest needs `items`: one short line each, at most "
  + `${DIGEST_ITEMS_MAX}. Pass \`items: []\` if there is nothing to report.`;
export const DIGEST_BODY_REFUSED = "`body` does not go with digest: only `items` reach the digest card. Put each line "
  + `in \`items\` (at most ${DIGEST_ITEMS_MAX}, ${DIGEST_ITEM_MAX} characters each) and call again without \`body\`.`;
export const DIGEST_NOT_ASKED = "No morning digest was asked of this chat; use done, failed, needs_decision or urgent.";
/** Told to a manager whose report is word for word one still open on the user's card. */
export const SAME_REPORT_NOTE = "The same report is already on the user's card, still open; it was not filed again.";
export const DIGEST_CLOSED = "The morning digest was already put together. Report this as done or needs_decision instead.";
/** Told to a manager whose report was about a card the user already has from the chat itself. */
export const CHAT_CARD_NOTE = "That chat's own card is already in front of the user (Waiting on you in the PPM Assistant, "
  + "and Telegram when it is connected), where they answer it directly, so this report was not filed. The chat goes on "
  + "by itself once they answer; check on it afterwards rather than reporting the card again.";
/** Added when the chat was only named in the text: how to file a report that is about something else. */
export const CHAT_CARD_INFERRED_NOTE = "It was taken to be about that card because it names that chat's session id. If it is "
  + "about something else, report it again naming the chat by its title instead of its id.";

const SESSION_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type ReportShape = Pick<NewCard, "kind" | "title" | "body" | "payload">;

/**
 * Whether two cards are the same report: kind, title, body and what the manager attached (draft,
 * choices, pictures), compared as stored. PPM's own additions to the payload do not count.
 */
export function sameReport(a: ReportShape, b: ReportShape): boolean {
  const key = (c: ReportShape) => {
    const p = c.payload ?? {};
    return JSON.stringify([c.kind, c.title, c.body ?? "", p.draft ?? null, p.options ?? null, p.images ?? null, p.urgentCapped === true]);
  };
  return key(a) === key(b);
}

/** A refused call, logged with its kind and reason only: the report's words stay out of the log. */
function refuse(caller: ReportCaller, requested: unknown, reason: string, message: string): ReportResult {
  const kind = REPORT_KINDS.includes(requested as ReportKind) ? requested : "unknown";
  log.info(`report ${kind} from ${caller.projectName} (session ${caller.sessionId}) refused: ${reason}`);
  return { ok: false, message };
}

function logMerged(caller: ReportCaller, kind: AssistantCardKind, cardId: string): void {
  log.info(`report ${kind} from ${caller.projectName} (session ${caller.sessionId}) is the same as open card ${cardId}: not filed again`);
}

const draftOnly = (text: string): string => neutralizePpmTags(neutralizeBlockMarkers(text));

/** sha256(to + "\n" + text): what the user's OK names, and what the manager must then send unchanged. */
export function draftSha256(to: string, text: string): string {
  return createHash("sha256").update(`${to}\n${text}`, "utf8").digest("hex");
}

function fieldError(args: Record<string, unknown>): string | null {
  const allowed = new Set(["kind", "title", "body", "draft", "items", "images", "options", "chat", "supersedes", "task"]);
  const extra = Object.keys(args).find((k) => !allowed.has(k));
  if (extra) return `Unknown field \`${extra.slice(0, 40)}\`.`;
  if (!REPORT_KINDS.includes(args.kind as ReportKind)) return `\`kind\` must be one of ${REPORT_KINDS.join(", ")}.`;
  if (typeof args.title !== "string" || !args.title.trim()) return "`title` is required.";
  if (args.title.length > REPORT_TITLE_MAX) return `\`title\` is at most ${REPORT_TITLE_MAX} characters.`;
  if (args.body !== undefined && (typeof args.body !== "string" || args.body.length > REPORT_BODY_MAX)) return `\`body\` is text of at most ${REPORT_BODY_MAX} characters.`;
  if (args.draft !== undefined) {
    if (args.kind !== "needs_decision" && args.kind !== "urgent") return "`draft` goes only with needs_decision or urgent.";
    const d = args.draft;
    if (!isObj(d) || typeof d.to !== "string" || typeof d.text !== "string" || !d.to.trim() || !d.text.trim()) return "`draft` needs `to` and `text`.";
    if (Object.keys(d).some((k) => k !== "to" && k !== "text")) return "`draft` has only `to` and `text`.";
    if (d.to.length > DRAFT_TO_MAX) return `\`draft.to\` is at most ${DRAFT_TO_MAX} characters.`;
    if (d.text.length > DRAFT_TEXT_MAX) return `\`draft.text\` is at most ${DRAFT_TEXT_MAX} characters.`;
  }
  if (args.images !== undefined) {
    if (args.kind === "digest") return "`images` do not go with digest.";
    if (!Array.isArray(args.images) || args.images.length === 0 || args.images.length > REPORT_IMAGES_MAX) {
      return `\`images\` is a list of 1 to ${REPORT_IMAGES_MAX} screenshot ids from design_screenshot.`;
    }
    if (!args.images.every((i) => typeof i === "string")) return "Each of `images` is a screenshot id from design_screenshot.";
  }
  if (args.options !== undefined) {
    const invalid = optionsError(args);
    if (invalid) return invalid;
  }
  if (args.chat !== undefined) {
    if (args.kind !== "needs_decision" && args.kind !== "urgent") return "`chat` goes only with needs_decision or urgent.";
    if (typeof args.chat !== "string" || !args.chat.trim() || args.chat.length > REPORT_CHAT_MAX) {
      return `\`chat\` is a chat's session id, at most ${REPORT_CHAT_MAX} characters.`;
    }
  }
  if (args.supersedes !== undefined) {
    if (args.kind === "digest") return "`supersedes` does not go with digest.";
    const refs = withdrawRefs(args.supersedes, "supersedes");
    if (!refs.ok) return refs.message;
  }
  if (args.task !== undefined) {
    if (args.kind === "digest") return "`task` does not go with digest.";
    if (typeof args.task !== "string" || !args.task.trim() || args.task.length > REPORT_TASK_MAX) return "`task` is a task of this project, like `ppm/76` or `#76`.";
  }
  if (args.kind === "digest") {
    // A digest is its `items` and nothing else: a `body` here used to be accepted and dropped, so a
    // manager that wrote its whole status into `body` was told it was in the digest while the card
    // showed none of it.
    if (args.body !== undefined) return DIGEST_BODY_REFUSED;
    if (args.items === undefined) return DIGEST_ITEMS_REQUIRED;
  }
  if (args.items !== undefined) {
    if (args.kind !== "digest") return "`items` go only with digest.";
    if (!Array.isArray(args.items) || args.items.length > DIGEST_ITEMS_MAX) return `\`items\` is a list of at most ${DIGEST_ITEMS_MAX}.`;
    if (!args.items.every((i) => typeof i === "string" && i.length <= DIGEST_ITEM_MAX)) return `Each item is text of at most ${DIGEST_ITEM_MAX} characters.`;
  }
  return null;
}

function optionsError(args: Record<string, unknown>): string | null {
  if (args.kind !== "needs_decision" && args.kind !== "urgent") return "`options` go only with needs_decision or urgent.";
  if (args.draft !== undefined) return "`options` and `draft` do not go together: a choice is the whole answer.";
  const list = args.options;
  if (!Array.isArray(list) || list.length < CARD_OPTIONS_MIN || list.length > CARD_OPTIONS_MAX) {
    return `\`options\` is a list of ${CARD_OPTIONS_MIN} to ${CARD_OPTIONS_MAX} choices.`;
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const o of list) {
    if (!isObj(o)) return "Each of `options` is an object with `id`, `label` and an optional `description`.";
    if (Object.keys(o).some((k) => k !== "id" && k !== "label" && k !== "description")) return "Each of `options` has only `id`, `label` and `description`.";
    if (typeof o.id !== "string" || !CARD_OPTION_ID_RE.test(o.id)) {
      return `Each option's \`id\` is 1 to ${CARD_OPTION_ID_MAX} lower-case letters, digits, \`-\` or \`_\`, starting with a letter or digit.`;
    }
    if (ids.has(o.id)) return `Two options share the id \`${o.id}\`.`;
    ids.add(o.id);
    if (typeof o.label !== "string" || !o.label.trim() || o.label.length > CARD_OPTION_LABEL_MAX) {
      return `Each option's \`label\` is text of 1 to ${CARD_OPTION_LABEL_MAX} characters.`;
    }
    const label = cleanOptionLabel(o.label);
    if (!label) return "Each option's `label` must say something.";
    if (labels.has(label.toLowerCase())) return `Two options share the label "${label.slice(0, 40)}".`;
    labels.add(label.toLowerCase());
    if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > CARD_OPTION_DESCRIPTION_MAX)) {
      return `An option's \`description\` is text of at most ${CARD_OPTION_DESCRIPTION_MAX} characters.`;
    }
  }
  return null;
}

/** The manager's choices, cleaned like the rest of its words; already checked by {@link optionsError}. */
function cleanOptions(raw: unknown[]): CardOption[] {
  return raw.map((o) => {
    const r = o as { id: string; label: string; description?: string };
    const description = r.description !== undefined ? cleanCardBody(r.description, CARD_OPTION_DESCRIPTION_MAX) : "";
    return { id: r.id, label: cleanOptionLabel(r.label), ...(description ? { description } : {}) };
  });
}

/**
 * The mirrored card of a chat this report is about, when the user already has it (see the header):
 * the chat `chat` names, else the one chat with a waiting card the title and body name, if the
 * report carries no draft. Never the manager's own chat: its cards are its own to explain.
 */
function chatCardFor(env: ReportEnv, caller: ReportCaller, args: Record<string, unknown>): { card: AssistantCard; inferred: boolean } | null {
  const find = env.waitingChatCard;
  if (!find || (args.kind !== "needs_decision" && args.kind !== "urgent")) return null;
  const lookup = (id: string): AssistantCard | null => (id === caller.sessionId ? null : find(caller.projectPath, id));
  if (typeof args.chat === "string") {
    const card = lookup(args.chat.trim());
    return card ? { card, inferred: false } : null;
  }
  if (args.draft !== undefined) return null;
  const text = `${typeof args.title === "string" ? args.title : ""}\n${typeof args.body === "string" ? args.body : ""}`;
  const named = new Set((text.match(SESSION_ID_RE) ?? []).map((id) => id.toLowerCase()));
  const found = new Map<string, AssistantCard>();
  for (const id of named) {
    const card = lookup(id);
    if (card) found.set(card.sessionId ?? card.id, card);
  }
  return found.size === 1 ? { card: [...found.values()][0]!, inferred: true } : null;
}

export function fileReport(env: ReportEnv, caller: ReportCaller, raw: unknown): ReportResult {
  const args = isObj(raw) ? raw : {};
  const invalid = fieldError(args);
  if (invalid) return refuse(caller, args.kind, "invalid fields", invalid);
  const now = env.now();
  const requested = args.kind as ReportKind;
  if (requested === "digest") {
    const items = Array.isArray(args.items) ? (args.items as string[]).map((i) => cleanCardBody(i, DIGEST_ITEM_MAX)).filter(Boolean) : [];
    const taken = env.digestAnswer(caller.sessionId, items);
    return taken.ok ? { ok: true, kind: "digest", note: digestTakenNote(items.length) } : refuse(caller, "digest", "digest not taken", taken.message);
  }
  const withdrawing = args.supersedes !== undefined || args.task !== undefined;
  const withdrawOn = env.withdrawOn?.() === true;
  if (withdrawing && !withdrawOn) return refuse(caller, requested, "card withdrawal off", WITHDRAW_OFF_NOTE);
  let aboutTask: { taskId: string; ref: string; title: string } | undefined;
  if (typeof args.task === "string") {
    const found = env.resolveTask?.(caller.projectPath, args.task.trim()) ?? { error: "Tasks are not available here." };
    if ("error" in found) return refuse(caller, requested, "task not found", found.error);
    aboutTask = found;
  }
  // What the new card replaces is known before it is made, so every surface shows it from the start
  // (Telegram sends it under the replaced card's message); a dry run changes nothing.
  let replaces: Array<{ id: string; title: string }> = [];
  if (withdrawOn && Array.isArray(args.supersedes) && env.withdraw) {
    const refs = withdrawRefs(args.supersedes, "supersedes");
    if (refs.ok) {
      replaces = env.withdraw(caller, refs.refs, "preview", undefined, true)
        .flatMap((i) => (i.outcome === "withdrawn" && i.card ? [{ id: i.card.id, title: i.card.title }] : []));
    }
  }
  const finish = (result: Extract<ReportResult, { ok: true }>, title: string, created = false): ReportResult =>
    afterFiling(env, caller, args, result, title, withdrawOn, created);

  const about = chatCardFor(env, caller, args);
  if (about) {
    const { card: chatCard, inferred } = about;
    log.info(`report ${requested} from ${caller.projectName} (session ${caller.sessionId}) is about chat ${chatCard.sessionId}'s open card ${chatCard.id}${inferred ? " (named in its text)" : ""}: not filed`);
    return finish({ ok: true, cardId: chatCard.id, kind: chatCard.kind, note: inferred ? `${CHAT_CARD_NOTE} ${CHAT_CARD_INFERRED_NOTE}` : CHAT_CARD_NOTE }, chatCard.title);
  }

  const title = cleanCardTitle(args.title);
  let kind: AssistantCardKind = requested;
  let note: string | undefined;
  if (requested === "urgent") {
    const windowStart = env.quietWindowStart();
    // The same urgent thing said twice is one card: within the quiet window, or the last hour.
    const same = env.openUrgentTitled(caller.sessionId, title, windowStart ?? now - HOUR_MS);
    if (same) {
      logMerged(caller, "urgent", same.id);
      return finish({ ok: true, cardId: same.id, kind: "urgent", note: "The same urgent report is already on the user's card." }, same.title);
    }
    if (windowStart !== null && env.countSince(caller.sessionId, ["urgent"], windowStart) >= URGENT_PER_MANAGER_PER_QUIET_WINDOW) {
      kind = "needs_decision";
      note = "Quiet hours: this chat already raised its urgent reports for tonight, so this one waits as a decision for the morning.";
    }
  }

  let images: CardImage[] | undefined;
  if (Array.isArray(args.images)) {
    images = [];
    for (const id of new Set(args.images as string[])) {
      const shot = env.shotOf?.(id, caller.projectPath) ?? null;
      if (!shot) {
        return refuse(caller, requested, "not a screenshot of this project",
          `"${id.slice(0, 40)}" is not a screenshot of this project's designs (they last seven days); take one with design_screenshot.`);
      }
      images.push(shot);
    }
  }

  const rawDraft = isObj(args.draft) ? args.draft as { to: string; text: string } : null;
  let draft: CardDraft | undefined;
  if (rawDraft) {
    // Markers broken, nothing else changed: the text the user approves is the text that is sent.
    const to = draftOnly(rawDraft.to.trim());
    const text = draftOnly(rawDraft.text);
    draft = { to, text, sha256: draftSha256(to, text) };
  }
  const options = Array.isArray(args.options) ? cleanOptions(args.options) : undefined;
  // Choices written as text get no button; PPM never builds one from them, since a wrong guess
  // would let a press approve something the manager did not offer.
  const choicesInText = !options && (kind === "needs_decision" || kind === "urgent")
    && listsChoicesInText(`${typeof args.title === "string" ? args.title : ""}
${typeof args.body === "string" ? args.body : ""}`);
  const newCard: NewCard = {
    kind,
    projectName: caller.projectName,
    projectPath: caller.projectPath,
    sessionId: caller.sessionId,
    title,
    body: cleanCardBody(args.body, REPORT_BODY_MAX),
    payload: {
      ...(draft ? { draft } : {}),
      ...(options ? { options } : {}),
      ...(images?.length ? { images } : {}),
      ...(kind !== requested ? { urgentCapped: true } : {}),
      ...(aboutTask ? { aboutTask } : {}),
      ...(replaces.length ? { supersedes: replaces } : {}),
    },
    // A decision only waits for the user's answer; news wakes the Assistant.
    wake: kind === "done" || kind === "failed" || kind === "urgent",
  };
  // A loop files the same report again and again: it gets the open card back, and nothing is sent twice.
  const identical = env.openIdentical(caller.sessionId, newCard);
  if (identical) {
    logMerged(caller, kind, identical.id);
    return finish({ ok: true, cardId: identical.id, kind, note: SAME_REPORT_NOTE }, identical.title);
  }
  const card = env.create(newCard);
  if (options && card.okOffered !== true) {
    note = note ? `${note} ${CHOICES_NOT_PRESSABLE_NOTE}` : CHOICES_NOT_PRESSABLE_NOTE;
  }
  if (choicesInText) {
    log.warn(`card ${card.id} from ${caller.projectName} (session ${caller.sessionId}) lists choices in its text without \`options\`: no buttons for them`);
    note = note ? `${note} ${CHOICES_IN_TEXT_NOTE}` : CHOICES_IN_TEXT_NOTE;
  }
  return finish({ ok: true, cardId: card.id, kind, ...(note ? { note } : {}) }, card.title, true);
}

/**
 * What a filed report does next, when card withdrawal is on: withdraws the cards it `supersedes`
 * (each replaced by the card the call returns), and tells the manager which of its other cards
 * still wait, so it can withdraw what the new card made stale. The card the call returns is never
 * withdrawn by it.
 */
function afterFiling(
  env: ReportEnv, caller: ReportCaller, args: Record<string, unknown>, result: Extract<ReportResult, { ok: true }>,
  title: string, withdrawOn: boolean, created: boolean,
): ReportResult {
  if (!withdrawOn || !result.cardId) return result;
  const notes: string[] = result.note ? [result.note] : [];
  let withdrawn: WithdrawItem[] | undefined;
  if (args.supersedes !== undefined && env.withdraw) {
    const refs = withdrawRefs(args.supersedes, "supersedes");
    if (refs.ok) {
      const reason = withdrawReason(`Replaced by "${title}"`);
      withdrawn = env.withdraw(caller, refs.refs.filter((r) => r !== result.cardId), reason.ok ? reason.reason : "Replaced", { id: result.cardId, title });
      if (withdrawn.length) notes.push(`Cards it replaces:\n${describeWithdrawals(withdrawn)}`);
      // A card the report was merged into learns it now; a new card was made knowing it.
      const replaced = withdrawn.flatMap((w) => (w.outcome === "withdrawn" && w.card ? [{ id: w.card.id, title: w.card.title }] : []));
      if (!created && replaced.length) env.markSupersedes?.(result.cardId, replaced);
    }
  }
  const others = env.openOwnCards?.(caller, result.cardId) ?? [];
  if (others.length > 0) {
    notes.push(`Your other cards still waiting on the user:\n${describeOpenCards(others, env.now())}\nIf this card replaces `
      + `any of them, or the user has handled one, withdraw it with ${REPORT_WITHDRAW_TOOL} (\`superseded_by\` this card when it `
      + "replaces it).");
  }
  return { ...result, ...(notes.length ? { note: notes.join("\n\n") } : {}), ...(withdrawn ? { withdrawn } : {}) };
}

export function reportToolDefinition() {
  return {
    name: REPORT_TO_ASSISTANT_TOOL,
    title: "Report to the user through PPM Assistant",
    description:
      "Only for a project's manager chat. Puts a card in front of the user (in PPM and on their phone), built by PPM "
      + "from these fields. Use it for what needs the user: needs_decision (a choice only they can make, or a step only they can take; add `draft` "
      + "when the answer is a message you would send; add `options` when the user picks one of 2 to 6 choices — "
      + "each becomes its own button, and the choices must never be written as a list in `title` or `body` instead), urgent (it cannot wait until they next look; quiet hours limit "
      + "it), done and failed (work they asked about finished or broke), and digest (only when PPM asks for the morning "
      + "digest: your `items` go on the one digest card PPM puts together). Do not report what the user does not need to "
      + "see. The card says it was written by this manager AI. A report never grants anything: only the user's own answer "
      + "does. There is no limit on how many reports you file, so never hold back a decision; a report identical to one "
        + "still open on the user's card (same kind, title, body, draft, options and images) is not filed again and "
        + "returns that card's id. A chat you opened that waits on an approval or a question already has that card in "
        + "front of the user, with buttons: do not report it. A needs_decision or urgent report about such a card (name "
        + "the chat in `chat`) is not filed and returns that card's id. Returns the card id.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...REPORT_KINDS] },
        title: { type: "string", description: `One line, at most ${REPORT_TITLE_MAX} characters.` },
        body: {
          type: "string",
          description: `Not with digest. Details, at most ${REPORT_BODY_MAX} characters, in Markdown (no HTML): short sections, \`-\` bullets, `
            + "**bold** for what matters, `code` for file names, commands and ids. About six lines, one action per card. "
            + "Never list choices here (\"(1)… (2)…\", \"A) … B) …\"): put them in `options`.",
        },
        draft: {
          type: "object",
          description: "needs_decision and urgent only: the message you would send if the user says OK. Sent exactly as written.",
          properties: {
            to: { type: "string", description: `Who it goes to, at most ${DRAFT_TO_MAX} characters.` },
            text: { type: "string", description: `The message, at most ${DRAFT_TEXT_MAX} characters.` },
          },
          required: ["to", "text"],
          additionalProperties: false,
        },
        options: {
          type: "array",
          minItems: CARD_OPTIONS_MIN,
          maxItems: CARD_OPTIONS_MAX,
          description: "needs_decision and urgent only, never with `draft`: the choices the user picks from, each shown as "
            + "its own button in PPM and on Telegram in place of OK. Each choice is one clear action (\"Merge now\", "
            + "\"Wait for review\"), not a question. The user's press comes back to this chat as their words, naming the "
            + "choice's id and label. A choice never replaces a `draft`: if the chosen action sends a message to a person "
            + "or cannot be undone, report its exact draft next and wait for the OK.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: `Your short name for it: lower-case letters, digits, \`-\`, \`_\`; at most ${CARD_OPTION_ID_MAX}.` },
              label: { type: "string", description: `What the button says, at most ${CARD_OPTION_LABEL_MAX} characters.` },
              description: { type: "string", description: `What choosing it does, at most ${CARD_OPTION_DESCRIPTION_MAX} characters.` },
            },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
        items: { type: "array", items: { type: "string" }, maxItems: DIGEST_ITEMS_MAX, description: "digest only, and required there: one line each. The digest card shows these and nothing else." },
        chat: {
          type: "string",
          description: "needs_decision and urgent only: the session id of the chat this decision is about, when it is one "
            + "of this project's chats. If that chat is waiting on an approval or a question, the user already has its "
            + "card and this report is not filed.",
        },
        supersedes: {
          type: "array", items: { type: "string" }, minItems: 1, maxItems: WITHDRAW_CARDS_MAX,
          description: "Not with digest; only when the user turned on card withdrawal. Ids of your earlier cards this card "
            + "replaces (the user asked again, or the question changed): they are withdrawn, and each says it was replaced "
            + "by this one. Only your own open reports; at most 5 withdrawn per turn.",
        },
        task: {
          type: "string",
          description: "Not with digest; only when the user turned on card withdrawal. The PPM task of this project the card "
            + "is about (`ppm/76`, `#76`). When the task is closed, a done or failed card about it is cleared, and a "
            + "decision card says the task was closed.",
        },
        images: {
          type: "array", items: { type: "string" }, maxItems: REPORT_IMAGES_MAX,
          description: "Screenshot ids from design_screenshot (this project's designs): shown on the card and sent to the "
            + "user's phone as pictures with it, e.g. the variants to choose between. Number them in the body in the order "
            + "they are listed here. Not with digest.",
        },
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  };
}
