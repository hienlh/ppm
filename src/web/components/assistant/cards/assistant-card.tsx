/** One PPM Assistant card, drawn by its kind. */
import type { AssistantCard as Card } from "../../../../shared/assistant-cards";
import { ApprovalMirrorCard, QuestionMirrorCard } from "./approval-mirror-card";
import { DecisionCard } from "./decision-card";
import { DigestCard } from "./digest-card";
import { BudgetCard, OutcomeCard } from "./outcome-card";
import { RulesChangeCard, RulesNoteCard } from "./rules-cards";

export function AssistantCard({ card, onCard }: { card: Card; onCard?: (card: Card) => void }) {
  switch (card.kind) {
    case "needs_decision":
    case "urgent":
      return <DecisionCard card={card} onCard={onCard} />;
    case "approval":
      return <ApprovalMirrorCard card={card} onCard={onCard} />;
    case "question":
      return <QuestionMirrorCard card={card} onCard={onCard} />;
    case "done":
    case "failed":
      return <OutcomeCard card={card} onCard={onCard} />;
    case "budget":
      return <BudgetCard card={card} onCard={onCard} />;
    case "digest":
      return <DigestCard card={card} />;
    case "rules_note":
      return <RulesNoteCard card={card} />;
    case "rules_change":
      return <RulesChangeCard card={card} onCard={onCard} />;
    default:
      return null;
  }
}
