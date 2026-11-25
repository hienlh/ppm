/**
 * The live surroundings of card withdrawal: the card store, the chats' current turns and the
 * database. Kept apart from `card-withdraw.ts` so the rules are tested without a server.
 */
import { assistantCards } from "./assistant-cards.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { configService } from "../config.service.ts";
import { ppmToolOn } from "../../shared/ppm-tools.ts";
import { REPORT_WITHDRAW_TOOL } from "../../shared/card-withdraw.ts";
import { WITHDRAWABLE_CARD_KINDS, type AssistantCard } from "../../shared/assistant-cards.ts";
import { countWithdrawnBy, getCardRow, listOpenCardsWithIdPrefix, listOpenProjectCards } from "./assistant-cards-db.ts";
import type { WithdrawActor, WithdrawEnv } from "./card-withdraw.ts";
import { ownsCard } from "./card-withdraw.ts";

export const liveWithdrawEnv: WithdrawEnv = {
  cards: assistantCards,
  now: () => assistantClock.now(),
  row: getCardRow,
  openWithPrefix: listOpenCardsWithIdPrefix,
  turnOf: (sessionId) => chatControl()?.liveState(sessionId)?.turnId ?? null,
  withdrawnCount: countWithdrawnBy,
};

/** Whether the user turned card withdrawal on (Settings → Tools, or the feature's question). */
export function cardWithdrawOn(): boolean {
  try {
    return ppmToolOn(configService.get("ai") ?? {}, REPORT_WITHDRAW_TOOL);
  } catch {
    return false;
  }
}

/** A manager's cards it may still withdraw, oldest first, leaving out `except`. */
export function openCardsOfManager(actor: Extract<WithdrawActor, { kind: "manager" }>, except?: string): AssistantCard[] {
  return listOpenProjectCards(actor.projectKey, WITHDRAWABLE_CARD_KINDS)
    .filter((row) => row.id !== except && !row.answer && ownsCard(actor, row))
    .map((row) => assistantCards.toCard(row));
}
