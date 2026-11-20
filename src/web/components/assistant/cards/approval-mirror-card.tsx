/**
 * A chat's approval or question, mirrored: a manager chat's own, or one any other chat of a project
 * waits on (named, so the user knows which). Allow is offered only when the card shows
 * everything that would run (the same bar Telegram keeps); otherwise the user opens the chat.
 *
 * A question is answered on the card whatever its shape: each option is a tile (A, B, C…) with its
 * label, its whole description and a "Recommended" tag where the manager marked one; the user picks
 * one per question (several where the question allows it) and sends them together, so a stray tap
 * on a long tile never answers by itself. A question that takes typed text (every Claude question,
 * a Codex one marked "other") also has an "Other" field, and one with no options is answered by
 * that field alone; the typed words go out in place of the tiles, as the chat's own form sends
 * them. Only a question asking for a secret is answered in the chat itself.
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

const OpenChat = ({ card, primary }: { card: AssistantCard; primary?: boolean }) => (
  <CardButton
    variant={primary ? "primary" : "ghost"}
    secondary={!primary}
    title={card.payload.chat ? "Open the chat" : "Open manager chat"}
    onClick={() => openCardManagerChat(card)}
    disabled={!card.sessionId}
  >
    <ExternalLink className="size-3.5" />{primary ? "Open in PPM" : "Open chat"}
  </CardButton>
);

/** "21:09": a deadline as the person reads a clock. */
const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Who is asking: a manager chat, or another chat of the project, named as PPM shows it. */
function Asker({ card }: { card: AssistantCard }) {
  const project = card.projectName ?? "project";
  const chat = card.payload.chat;
  if (!chat) return <>The {project} manager chat</>;
  return <>Chat <b className="font-semibold text-text-primary">“{escapeHiddenCharacters(chat.title)}”</b> in {project}</>;
}

/** A card that gives up by itself says when, while it still waits. */
function Deadline({ card }: { card: AssistantCard }) {
  const at = card.payload.expiresAt;
  if (!at || card.status !== "open") return null;
  return <p className="text-xs text-warning">Expires at {clockTime(at)}: if nobody answers by then, nothing is done.</p>;
}

export function ApprovalMirrorCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const d = card.payload.deciding;
  const complete = d?.complete === true;
  // A database change or a vault unlock takes a password typed into PPM: there is nothing to press here.
  if (card.payload.answerInPpm) {
    return (
      <CardShell card={card} look={{ label: "Needs you in PPM", Icon: ShieldAlert, tone: "need" }} error={error} actions={<OpenChat card={card} primary />}>
        <p className="text-[13px] text-text-secondary"><Asker card={card} /> waits: <b className="font-semibold text-text-primary">{card.title}</b>.</p>
        {d?.incompleteReason && <p className="text-xs text-text-subtle">{d.incompleteReason}</p>}
      </CardShell>
    );
  }
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
      <p className="text-[13px] text-text-secondary"><Asker card={card} /> wants to use <b className="font-semibold text-text-primary">{d?.title ?? card.title}</b>:</p>
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
      {!complete && <p className="text-xs text-warning">{d?.incompleteReason ?? `Open the ${card.payload.chat ? "chat" : "manager chat"} to see all of it before allowing.`}</p>}
      <Deadline card={card} />
    </CardShell>
  );
}

/**
 * Whether every question can be answered on the card: each has options or takes typed text, and
 * none asks for a secret (a secret is typed in the chat, never on a card other screens show).
 */
export function answerableOnCard(questions: readonly Question[]): boolean {
  return questions.length > 0
    && questions.every((q) => (q.options.length > 0 || q.allowsFreeText === true) && !(q as { secret?: boolean }).secret);
}

/**
 * The answers the card sends: per question the typed words when there are any (alone, in place of
 * the tiles — what the chat's form sends), else the tiles picked. Unanswered questions are left out.
 */
export function cardAnswers(
  questions: readonly Question[], picked: Readonly<Record<string, string[]>>, typed: Readonly<Record<string, string>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const q of questions) {
    const words = q.allowsFreeText === true ? typed[q.id]?.trim() : undefined;
    if (words) out[q.id] = [words];
    else if (picked[q.id]?.length) out[q.id] = picked[q.id]!;
  }
  return out;
}

export function QuestionMirrorCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const questions = card.payload.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const open = card.status === "open";
  const onCardAnswerable = answerableOnCard(questions);
  const answers = cardAnswers(questions, picked, typed);
  const answered = questions.filter((q) => answers[q.id]).length;
  const many = questions.length > 1;

  // A tile picked clears the typed words, and words typed clear the tiles: one answer, never both.
  const toggle = (q: Question, label: string) => {
    setTyped((t) => ({ ...t, [q.id]: "" }));
    setPicked((p) => {
      const now = p[q.id] ?? [];
      if (q.multiSelect !== true) return { ...p, [q.id]: [label] };
      return { ...p, [q.id]: now.includes(label) ? now.filter((l) => l !== label) : [...now, label] };
    });
  };
  const type = (q: Question, value: string) => {
    setTyped((t) => ({ ...t, [q.id]: value }));
    if (value.trim()) setPicked((p) => ({ ...p, [q.id]: [] }));
  };

  return (
    <CardShell
      card={card}
      look={{ label: many ? `${questions.length} questions` : "Needs your answer", Icon: CircleHelp, tone: "need" }}
      error={error}
      actions={onCardAnswerable ? (
        <CardButton
          variant="primary"
          disabled={busy || answered < questions.length}
          onClick={() => void run(() => answerAssistantCard(card.id, { answersById: answers }))}
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
          {(q.options.length > 0 || (open && onCardAnswerable && q.allowsFreeText === true)) && (
            <QuestionOptions
              label={q.header || q.question}
              options={q.options}
              multi={q.multiSelect === true}
              chosen={picked[q.id] ?? []}
              disabled={!open || !onCardAnswerable || busy}
              onPick={(label) => toggle(q, label)}
              {...(onCardAnswerable && open && q.allowsFreeText === true
                ? { other: { value: typed[q.id] ?? "", onChange: (v: string) => type(q, v) } }
                : {})}
            />
          )}
        </section>
      ))}
      {open && !onCardAnswerable && <p className="text-xs text-text-subtle">Answer it in the {card.payload.chat ? "chat" : "manager chat"}.</p>}
      {card.payload.chat && <p className="text-xs text-text-subtle">Asked by <Asker card={card} />.</p>}
    </CardShell>
  );
}
