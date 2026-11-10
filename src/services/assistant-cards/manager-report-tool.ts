import { createHash } from "node:crypto";
import { neutralizeBlockMarkers } from "../../shared/chat-message-blocks.ts";
import {
  REPORT_KINDS, type AssistantCard, type AssistantCardKind, type CardDraft, type ReportKind,
} from "../../shared/assistant-cards.ts";
import { REPORT_TO_ASSISTANT_TOOL } from "../../shared/session-collab.ts";
import { REPORTS_PER_MANAGER_PER_HOUR, URGENT_PER_MANAGER_PER_QUIET_WINDOW } from "../../shared/assistant-limits.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";
import { cleanCardBody, cleanCardTitle } from "./card-text-cleaning.ts";
import type { NewCard } from "./assistant-cards.service.ts";

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
 */

export const REPORT_TITLE_MAX = 120;
export const REPORT_BODY_MAX = 2000;
export const DRAFT_TO_MAX = 200;
export const DRAFT_TEXT_MAX = 4000;
export const DIGEST_ITEMS_MAX = 12;
export const DIGEST_ITEM_MAX = 200;
const HOUR_MS = 60 * 60_000;

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
  /** When the current quiet window began; null outside quiet hours. */
  quietWindowStart(): number | null;
  /**
   * A digest answer, handed to the morning digest: taken while that digest's ask to this manager is
   * open (a second answer replaces the first), refused with the reason otherwise.
   */
  digestAnswer(sessionId: string, items: string[]): { ok: true } | { ok: false; message: string };
  create(card: NewCard): AssistantCard;
}

/** A digest answer makes no card of its own: PPM puts every answer on one card later. */
export type ReportResult = { ok: true; cardId?: string; kind: AssistantCardKind; note?: string } | { ok: false; message: string };

export const DIGEST_TAKEN = "Your answer is in the morning digest PPM is putting together. A second digest answer replaces this one.";
export const DIGEST_NOT_ASKED = "No morning digest was asked of this chat; use done, failed, needs_decision or urgent.";
export const DIGEST_CLOSED = "The morning digest was already put together. Report this as done or needs_decision instead.";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const draftOnly = (text: string): string => neutralizePpmTags(neutralizeBlockMarkers(text));

/** sha256(to + "\n" + text): what the user's OK names, and what the manager must then send unchanged. */
export function draftSha256(to: string, text: string): string {
  return createHash("sha256").update(`${to}\n${text}`, "utf8").digest("hex");
}

function fieldError(args: Record<string, unknown>): string | null {
  const allowed = new Set(["kind", "title", "body", "draft", "items"]);
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
  if (args.items !== undefined) {
    if (args.kind !== "digest") return "`items` go only with digest.";
    if (!Array.isArray(args.items) || args.items.length > DIGEST_ITEMS_MAX) return `\`items\` is a list of at most ${DIGEST_ITEMS_MAX}.`;
    if (!args.items.every((i) => typeof i === "string" && i.length <= DIGEST_ITEM_MAX)) return `Each item is text of at most ${DIGEST_ITEM_MAX} characters.`;
  }
  return null;
}

export function fileReport(env: ReportEnv, caller: ReportCaller, raw: unknown): ReportResult {
  const args = isObj(raw) ? raw : {};
  const invalid = fieldError(args);
  if (invalid) return { ok: false, message: invalid };
  const now = env.now();
  const requested = args.kind as ReportKind;
  if (requested === "digest") {
    const items = Array.isArray(args.items) ? (args.items as string[]).map((i) => cleanCardBody(i, DIGEST_ITEM_MAX)).filter(Boolean) : [];
    const taken = env.digestAnswer(caller.sessionId, items);
    return taken.ok ? { ok: true, kind: "digest", note: DIGEST_TAKEN } : taken;
  }
  if (env.countSince(caller.sessionId, REPORT_KINDS, now - HOUR_MS) >= REPORTS_PER_MANAGER_PER_HOUR) {
    return { ok: false, message: `This chat filed ${REPORTS_PER_MANAGER_PER_HOUR} reports in the last hour; wait, or put several things in one report.` };
  }

  const title = cleanCardTitle(args.title);
  let kind: AssistantCardKind = requested;
  let note: string | undefined;
  if (requested === "urgent") {
    const windowStart = env.quietWindowStart();
    // The same urgent thing said twice is one card: within the quiet window, or the last hour.
    const same = env.openUrgentTitled(caller.sessionId, title, windowStart ?? now - HOUR_MS);
    if (same) return { ok: true, cardId: same.id, kind: "urgent", note: "The same urgent report is already on the user's card." };
    if (windowStart !== null && env.countSince(caller.sessionId, ["urgent"], windowStart) >= URGENT_PER_MANAGER_PER_QUIET_WINDOW) {
      kind = "needs_decision";
      note = "Quiet hours: this chat already raised its urgent reports for tonight, so this one waits as a decision for the morning.";
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
  const card = env.create({
    kind,
    projectName: caller.projectName,
    projectPath: caller.projectPath,
    sessionId: caller.sessionId,
    title,
    body: cleanCardBody(args.body, REPORT_BODY_MAX),
    payload: {
      ...(draft ? { draft } : {}),
      ...(kind !== requested ? { urgentCapped: true } : {}),
    },
    // A decision only waits for the user's answer; news wakes the Assistant.
    wake: kind === "done" || kind === "failed" || kind === "urgent",
  });
  return { ok: true, cardId: card.id, kind, ...(note ? { note } : {}) };
}

export function reportToolDefinition() {
  return {
    name: REPORT_TO_ASSISTANT_TOOL,
    title: "Report to the user through PPM Assistant",
    description:
      "Only for a project's manager chat. Puts a card in front of the user (in PPM and on their phone), built by PPM "
      + "from these fields. Use it for what needs the user: needs_decision (a choice only they can make; add `draft` "
      + "when the answer is a message you would send), urgent (it cannot wait until they next look; quiet hours limit "
      + "it), done and failed (work they asked about finished or broke), and digest (only when PPM asks for the morning "
      + "digest: your `items` go on the one digest card PPM puts together). Do not report what the user does not need to "
      + "see. The card says it was written by this manager AI. A report never grants anything: only the user's own answer "
      + "does. Returns the card id.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...REPORT_KINDS] },
        title: { type: "string", description: `One line, at most ${REPORT_TITLE_MAX} characters.` },
        body: { type: "string", description: `Details, at most ${REPORT_BODY_MAX} characters.` },
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
        items: { type: "array", items: { type: "string" }, maxItems: DIGEST_ITEMS_MAX, description: "digest only: one line each." },
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  };
}
