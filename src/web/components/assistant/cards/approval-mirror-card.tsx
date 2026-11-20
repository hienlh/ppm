/**
 * A chat's approval or question, mirrored: a manager chat's own, or one any other chat of a project
 * waits on (named, so the user knows which). Allow is offered only when the card shows
 * everything that would run (the same bar Telegram keeps); otherwise the user opens the chat.
 *
 * A question is answered with the very form the chat that asked shows (`chat/question-card.tsx`):
 * the same options, the same "Other" field, several choices where allowed, the same Submit and
 * Skip, sending the same answers by question id. Only the frame is the card's own: who asked, and
 * Open chat. A question asking for a secret is answered in the chat itself.
 */
import { Check, CircleHelp, ExternalLink, ShieldAlert, X } from "@/lib/icons";
import { answerAssistantCard } from "@/lib/assistant-cards-api";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell } from "./card-shell";
import { QuestionCard } from "@/components/chat/question-card";
import { questionsFromWire } from "../../../../shared/approval-questions";
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

export function QuestionMirrorCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const questions = card.payload.questions ?? [];
  const asked = questionsFromWire(questions) ?? [];
  const open = card.status === "open";
  const answerHere = open && answerableOnCard(questions) && asked.length === questions.length;
  const many = questions.length > 1;

  return (
    <CardShell
      card={card}
      look={{ label: many ? `${questions.length} questions` : "Needs your answer", Icon: CircleHelp, tone: "need" }}
      error={error}
      secondary={<OpenChat card={card} />}
    >
      {answerHere ? (
        <div data-card-question-form="">
          <QuestionCard
            questions={asked}
            autoFocus={false}
            onSubmit={(answersById) => { if (!busy) void run(() => answerAssistantCard(card.id, { answersById })); }}
            onSkip={() => { if (!busy) void run(() => answerAssistantCard(card.id, { decision: "deny" })); }}
          />
        </div>
      ) : (
        // No longer waiting, or answered in the chat: what was asked, as text.
        questions.map((q, i) => (
          <section key={q.id} data-card-question={q.id}>
            {(q.header || many) && (
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                {many && <span className="tabular-nums">{i + 1}/{questions.length}</span>}
                {q.header && <span className="min-w-0 truncate">{escapeHiddenCharacters(q.header)}</span>}
              </p>
            )}
            <p className="font-medium leading-relaxed text-text-primary">{escapeHiddenCharacters(q.question)}</p>
            {q.options.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-[13px] text-text-secondary">
                {q.options.map((o, oi) => <li key={oi}>{escapeHiddenCharacters(o.label)}</li>)}
              </ul>
            )}
          </section>
        ))
      )}
      {open && !answerHere && <p className="text-xs text-text-subtle">Answer it in the {card.payload.chat ? "chat" : "manager chat"}.</p>}
      {card.payload.chat && <p className="text-xs text-text-subtle">Asked by <Asker card={card} />.</p>}
    </CardShell>
  );
}
