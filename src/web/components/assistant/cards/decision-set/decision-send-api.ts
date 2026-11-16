/** The set's sends, over the cards' own routes (`lib/assistant-cards-api.ts`). */
import {
  cardRefusal, chooseAssistantCardOption, okAssistantCard, replyToAssistantCard,
} from "@/lib/assistant-cards-api";
import type { DecisionSendApi } from "@/lib/decision-set/decision-set-send";

export const decisionSendApi: DecisionSendApi = {
  ok: (id, sha) => okAssistantCard(id, sha),
  choose: (id, optionId) => chooseAssistantCardOption(id, optionId),
  reply: (id, text, force, images) => replyToAssistantCard(id, text, force, images),
  refusal: cardRefusal,
};
