/**
 * A manager chat's own approval or question, mirrored. Allow is offered only when the card shows
 * everything that would run (the same bar Telegram keeps); otherwise the user opens the chat.
 *
 * A question is answered on the card whatever its shape: each option is a tile (A, B, C…) with its
 * label, its whole description and a "Recommended" tag where the manager marked one; the user picks
 * one per question (several where the question allows it) and sends them together, so a stray tap
 * on a long tile never answers by itself. A question with no options, or one asking for a secret,
 * is answered in the chat itself.
 */
import { useState } from "react";
import { Check, CircleHelp, ExternalLink, ShieldAlert, X } from "@/lib/icons";
import { answerAssistantCard } from "@/lib/assistant-cards-api";
import { cn } from "@/lib/utils";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell } from "./card-shell";
import { QuestionOptions } from "./question-options";
import { openCardManagerChat, useCardAction } from "./use-card-action";

type Props = { card: AssistantCard; onCard?: (card: AssistantCard) => void };
type Question = NonNullable<AssistantCard["payload"]["questions"]>[number];

const OpenChat = ({ card }: { card: AssistantCard }) => (
  <CardButton variant="ghost" secondary title="Open manager chat" onClick={() => openCardManagerChat(card)} disabled={!card.sessionId}>
    <ExternalLink className="size-3.5" />Open chat
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
        </>
      )}
      secondary={<OpenChat card={card} />}
    >
      <p className="text-[13px] text-text-secondary">The {card.projectName ?? "project"} manager chat wants to use <b className="font-semibold text-text-primary">{d?.title ?? card.title}</b>:</p>
      {d && d.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {d.facts.map((f) => (
            <div key={`${f.label}:${f.value}`} className="contents">
              <dt className="text-text-subtle">{f.label}</dt>
              <dd className="min-w-0 break-words">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {d?.text && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-xs" data-card-command="">
          {d.text}
        </pre>
      )}
      {!complete && <p className="text-xs text-warning">{d?.incompleteReason ?? "Open the manager chat to see all of it before allowing."}</p>}
    </CardShell>
  );
}

/** Whether every question can be answered on the card: each has options, and none asks for a secret. */
export function answerableOnCard(questions: readonly Question[]): boolean {
  return questions.length > 0 && questions.every((q) => q.options.length > 0 && !(q as { secret?: boolean }).secret);
}

export function QuestionMirrorCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const questions = card.payload.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const open = card.status === "open";
  const onCardAnswerable = answerableOnCard(questions);
  const answered = questions.filter((q) => (picked[q.id]?.length ?? 0) > 0).length;
  const many = questions.length > 1;

  const toggle = (q: Question, label: string) => setPicked((p) => {
    const now = p[q.id] ?? [];
    if (q.multiSelect !== true) return { ...p, [q.id]: [label] };
    return { ...p, [q.id]: now.includes(label) ? now.filter((l) => l !== label) : [...now, label] };
  });

  return (
    <CardShell
      card={card}
      look={{ label: many ? `${questions.length} questions` : "Needs your answer", Icon: CircleHelp, tone: "need" }}
      error={error}
      actions={onCardAnswerable ? (
        <CardButton
          variant="primary"
          disabled={busy || answered < questions.length}
          onClick={() => void run(() => answerAssistantCard(card.id, { answersById: picked }))}
        >
          <Check className="size-3.5" />
          {many ? `Send answers (${answered}/${questions.length})` : "Send answer"}
        </CardButton>
      ) : undefined}
      secondary={<OpenChat card={card} />}
    >
      {questions.map((q, i) => (
        <section key={q.id} className={cn(many && i > 0 && "border-t border-border pt-3")} data-card-question={q.id}>
          {(q.header || many) && (
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
              {many && <span className="tabular-nums">{i + 1}/{questions.length}</span>}
              {q.header && <span className="min-w-0 truncate">{escapeHiddenCharacters(q.header)}</span>}
            </p>
          )}
          <p className="font-medium leading-relaxed text-text-primary">{escapeHiddenCharacters(q.question)}</p>
          {q.options.length > 0 && (
            <QuestionOptions
              label={q.header || q.question}
              options={q.options}
              multi={q.multiSelect === true}
              chosen={picked[q.id] ?? []}
              disabled={!open || !onCardAnswerable || busy}
              onPick={(label) => toggle(q, label)}
            />
          )}
        </section>
      ))}
      {open && !onCardAnswerable && <p className="text-xs text-text-subtle">Answer it in the manager chat.</p>}
    </CardShell>
  );
}
