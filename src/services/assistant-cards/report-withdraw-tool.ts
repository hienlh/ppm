/**
 * `report_withdraw`: a project's manager chat taking back cards it sent — a newer card replaced
 * them, or the user handled the matter elsewhere — or, called with no cards, listing which of its
 * cards still wait on the user. Only for the project's current manager chat, and only while the
 * user has card withdrawal on (Settings → Tools → Cards). The rules (whose cards, which kinds, how
 * many per turn) are `card-withdraw.ts`; nothing a model writes widens them.
 */
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { managerChats } from "../assistant-managers/manager-chats.service.ts";
import { projectKey } from "../project-name-for-path.ts";
import { REPORT_WITHDRAW_TOOL, WITHDRAW_CARDS_MAX } from "../../shared/card-withdraw.ts";
import { WITHDRAW_PER_TURN, WITHDRAW_REASON_MAX } from "../../shared/assistant-limits.ts";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import {
  describeOpenCards, describeWithdrawals, withdrawCards, withdrawReason, withdrawRefs,
  type WithdrawActor, type WithdrawEnv, type WithdrawItem,
} from "./card-withdraw.ts";
import { liveWithdrawEnv, openCardsOfManager } from "./card-withdraw-env.ts";
import { NOT_A_MANAGER } from "./manager-report-env.ts";

export interface ReportWithdrawEnv {
  /** The manager the session is now, if it is one. */
  manager(sessionId: string): { sessionId: string; projectKey: string } | null;
  withdraw: WithdrawEnv;
  openCards(actor: Extract<WithdrawActor, { kind: "manager" }>): AssistantCard[];
}

export const liveReportWithdrawEnv: ReportWithdrawEnv = {
  manager: (sessionId) => {
    const row = managerChats.forSession(sessionId);
    return row ? { sessionId: row.sessionId, projectKey: projectKey(row.projectPath) } : null;
  },
  withdraw: liveWithdrawEnv,
  openCards: (actor) => openCardsOfManager(actor),
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What the call answers, as JSON the tool card reads: the cards listed, or each card's outcome. */
export interface ReportWithdrawAnswer {
  listed?: Array<{ id: string; kind: string; title: string; createdAt: number }>;
  withdrawn?: Array<{ card: string; title?: string; outcome: WithdrawItem["outcome"] }>;
  supersededBy?: string;
  note: string;
}

export function reportWithdrawCall(sessionId: string, raw: unknown, env: ReportWithdrawEnv = liveReportWithdrawEnv): Json {
  const manager = env.manager(sessionId);
  if (!manager) return textResult(NOT_A_MANAGER, true);
  const actor: Extract<WithdrawActor, { kind: "manager" }> = { kind: "manager", sessionId: manager.sessionId, projectKey: manager.projectKey };
  const args = isObj(raw) ? raw : {};
  const extra = Object.keys(args).find((k) => k !== "cards" && k !== "reason" && k !== "superseded_by");
  if (extra) return textResult(`Unknown field \`${extra.slice(0, 40)}\`.`, true);

  if (args.cards === undefined) {
    const open = env.openCards(actor);
    const answer: ReportWithdrawAnswer = {
      listed: open.map((c) => ({ id: c.id, kind: c.kind, title: c.title, createdAt: c.createdAt })),
      note: describeOpenCards(open, env.withdraw.now(), 20),
    };
    return textResult(JSON.stringify(answer));
  }
  const refs = withdrawRefs(args.cards);
  if (!refs.ok) return textResult(refs.message, true);
  const reason = withdrawReason(args.reason);
  if (!reason.ok) return textResult(reason.message, true);

  let by: { id: string; title: string } | undefined;
  if (args.superseded_by !== undefined) {
    if (typeof args.superseded_by !== "string" || !args.superseded_by.trim()) return textResult("`superseded_by` is the id of your card that replaces them.", true);
    const row = env.withdraw.row(args.superseded_by.trim());
    if (!row || row.status !== "open" || row.projectKey !== actor.projectKey) {
      return textResult("`superseded_by` must be one of your cards still waiting on the user (the id report_to_assistant returned).", true);
    }
    by = { id: row.id, title: row.title };
  }
  const items = withdrawCards(env.withdraw, actor, refs.refs, reason.reason, by);
  const answer: ReportWithdrawAnswer = {
    withdrawn: items.map((i) => ({ card: i.card?.id ?? i.ref, ...(i.card ? { title: i.card.title } : {}), outcome: i.outcome })),
    ...(by ? { supersededBy: by.id } : {}),
    note: describeWithdrawals(items),
  };
  return textResult(JSON.stringify(answer), items.length > 0 && items.every((i) => i.outcome !== "withdrawn"));
}

export function reportWithdrawToolDefinition() {
  return {
    name: REPORT_WITHDRAW_TOOL,
    title: "Withdraw cards you sent the user",
    description:
      "Only for a project's manager chat. Takes back cards you filed with report_to_assistant that no longer need the "
      + "user: a newer card replaced them, or the user told you they handled it. Each withdrawn card leaves Waiting on "
      + "you and says why (and which card replaced it); the user can bring it back. Called with no `cards`, it lists "
      + "your cards still waiting, with their ids. Only needs_decision, urgent, done and failed reports of your project; "
      + `never a chat's approval or question card. At most ${WITHDRAW_PER_TURN} per turn: past that, ask the user on a `
      + "needs_decision card. Never withdraw a card only because it is old: the user may still mean to answer it.",
    inputSchema: {
      type: "object",
      properties: {
        cards: {
          type: "array", items: { type: "string" }, minItems: 1, maxItems: WITHDRAW_CARDS_MAX,
          description: "Ids of your cards to withdraw (whole ids, or the first 8 characters). Leave out to list your open cards.",
        },
        reason: { type: "string", description: `Why, in a few words the user reads on the card (at most ${WITHDRAW_REASON_MAX} characters). Required with \`cards\`.` },
        superseded_by: { type: "string", description: "The id of your card that replaces them, when one does." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  };
}
