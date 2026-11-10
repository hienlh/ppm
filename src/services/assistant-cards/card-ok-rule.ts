/**
 * When a needs-decision card may take the user's OK. An OK is an approval: it tells the manager
 * to send exactly the draft the user saw. So it meets the same bar as Allow on an approval card
 * (`assistant-telegram-card-format.ts`): the title, body and draft fit a phone message whole, and
 * nothing in them was hidden as a secret — a hidden span is text the user could not read before
 * agreeing to send it. The same rule holds in PPM and on Telegram, so the two never disagree.
 */
import { REVIEW_FIT_MAX } from "../assistant-telegram/assistant-telegram-card-format.ts";
import { redactSecretsForTelegram } from "../telegram/telegram-html-format.ts";
import { OK_CARD_KINDS, type AssistantCardKind, type CardDraft } from "../../shared/assistant-cards.ts";

interface OkCandidate {
  kind: AssistantCardKind;
  title: string;
  body: string;
  payload: { draft?: CardDraft };
}

/** The parts of a decision card a person must read before an OK means anything. */
function reviewedParts(card: OkCandidate): string[] {
  const draft = card.payload.draft;
  return [card.title, card.body, ...(draft ? [draft.to, draft.text] : [])];
}

/** Whether the card's whole decision fits and shows nothing hidden. */
export function cardOkOffered(card: OkCandidate): boolean {
  if (!OK_CARD_KINDS.includes(card.kind)) return false;
  const parts = reviewedParts(card);
  let hidden = 0;
  const shown = parts.map((p) => { const r = redactSecretsForTelegram(p); hidden += r.hidden; return r.text; });
  const length = (xs: string[]) => xs.reduce((n, s) => n + s.length, 0);
  return hidden === 0 && length(parts) <= REVIEW_FIT_MAX && length(shown) <= REVIEW_FIT_MAX;
}
