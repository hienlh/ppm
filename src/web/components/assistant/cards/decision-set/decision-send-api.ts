/** The set's sends, over the cards' own routes (`lib/assistant-cards-api.ts`). */
import {
  cardRefusal, chooseAssistantCardOption, okAssistantCard, replyToAssistantCard,
} from "@/lib/assistant-cards-api";
import type { DecisionSendApi } from "@/lib/decision-set/decision-set-send";
import { routeVoice } from "@/lib/card-voice-reply";
import { learnFromSentTranscript } from "@/lib/voice-learn-after-send";

export const decisionSendApi: DecisionSendApi = {
  ok: (id, sha) => okAssistantCard(id, sha),
  choose: (id, optionId) => chooseAssistantCardOption(id, optionId),
  reply: async (id, text, confirmAge, images, voice) => {
    const sent = await replyToAssistantCard(id, text, false, images, { confirmAge, ...(voice ? { voice: routeVoice(voice) } : {}) });
    // A transcript the user corrected in the field teaches PPM the words, as the composer's does.
    if (voice) learnFromSentTranscript(sent.card.projectName, voice.shown, text, voice.raw);
    return sent;
  },
  refusal: cardRefusal,
};
