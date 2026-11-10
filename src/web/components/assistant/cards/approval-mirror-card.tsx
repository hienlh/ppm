/**
 * A manager chat's own approval or question, mirrored. Allow is offered only when the card shows
 * everything that would run (the same bar Telegram keeps); otherwise the user opens the chat. A
 * single-choice question is answered with its options; any other question in the chat itself.
 */
import { Check, CircleHelp, ExternalLink, ShieldAlert, X } from "@/lib/icons";
import { answerAssistantCard } from "@/lib/assistant-cards-api";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell } from "./card-shell";
import { openManagerChat, useCardAction } from "./use-card-action";

type Props = { card: AssistantCard; onCard?: (card: AssistantCard) => void };

const OpenChat = ({ card }: { card: AssistantCard }) => (
  <CardButton variant="ghost" onClick={() => openManagerChat(card)} disabled={!card.sessionId}>
    <ExternalLink className="size-3.5" />Open manager chat
  </CardButton>
);

export function ApprovalMirrorCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const d = card.payload.deciding;
  const complete = d?.complete === true;
  return (
    <CardShell
      card={card}
      look={{ label: "Needs your approval", Icon: ShieldAlert, tone: "need" }}
      error={error}
      actions={(
        <>
          {complete && (
            <CardButton variant="primary" disabled={busy} onClick={() => void run(() => answerAssistantCard(card.id, { decision: "allow" }))}>
              <Check className="size-3.5" />Allow
            </CardButton>
          )}
          <CardButton variant="danger" disabled={busy} onClick={() => void run(() => answerAssistantCard(card.id, { decision: "deny" }))}>
            <X className="size-3.5" />Deny
          </CardButton>
          <OpenChat card={card} />
        </>
      )}
    >
      <p className="text-xs text-text-subtle">The {card.projectName ?? "project"} manager chat wants to use {d?.title ?? card.title}:</p>
      {d?.facts.map((f) => (
        <p key={`${f.label}:${f.value}`} className="text-xs"><span className="text-text-subtle">{f.label}: </span>{f.value}</p>
      ))}
      {d?.text && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-xs" data-card-command="">
          {d.text}
        </pre>
      )}
      {!complete && <p className="text-xs text-warning">{d?.incompleteReason ?? "Open the manager chat to see all of it before allowing."}</p>}
    </CardShell>
  );
}

export function QuestionMirrorCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const questions = card.payload.questions ?? [];
  const single = questions.length === 1 && !questions[0]!.multiSelect && questions[0]!.options.length > 0 ? questions[0]! : null;
  return (
    <CardShell
      card={card}
      look={{ label: "Needs your answer", Icon: CircleHelp, tone: "need" }}
      error={error}
      actions={(
        <>
          {single?.options.map((o) => (
            <CardButton key={o.label} disabled={busy} onClick={() => void run(() => answerAssistantCard(card.id, { answersById: { [single.id]: [o.label] } }))}>
              {escapeHiddenCharacters(o.label)}
            </CardButton>
          ))}
          <OpenChat card={card} />
        </>
      )}
    >
      {questions.map((q) => (
        <div key={q.id}>
          <p className="font-medium">{escapeHiddenCharacters(q.question)}</p>
          {!single && q.options.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-text-secondary">
              {q.options.map((o) => <li key={o.label}>{escapeHiddenCharacters(o.label)}</li>)}
            </ul>
          )}
        </div>
      ))}
      {!single && <p className="text-xs text-text-subtle">Answer it in the manager chat.</p>}
    </CardShell>
  );
}
