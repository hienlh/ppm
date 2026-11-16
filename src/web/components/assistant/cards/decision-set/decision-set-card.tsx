/**
 * One card of the set, as its tab shows it: the head (decision or urgent, project and the code of
 * the task the card is about, time, Open chat, Dismiss), the manager's words whole (Markdown, pictures, draft, the tasks it handed off), then
 * the answers as the chat's question form draws them — a numbered tile per choice (or one OK), and
 * "Other" for the user's own words and pictures.
 *
 * A tab whose card no longer waits shows only how it ended, in one line.
 */
import type { KeyboardEvent, RefObject } from "react";
import { BellRing, Check, ExternalLink, Lock, TriangleAlert, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { QuestionOptionTile, type QuestionTone } from "@/components/chat/question-form-parts";
import { decisionTiles, sameAnswer, type DecisionAnswer } from "@/lib/decision-set/decision-set-model";
import type { AssistantCard } from "../../../../../shared/assistant-cards";
import { CardText, cardTime } from "../card-shell";
import { CardImages } from "../card-images";
import { CardDraft } from "../card-draft";
import { CardHandedOffTasks, TaskCodeText } from "../card-task-items";
import { DecisionReplyField, type ReplyValue } from "./decision-reply-field";
import { SET_BUTTON, toneButtons } from "./decision-set-buttons";
import type { SetTab } from "./use-decision-set";

const EMPTY_REPLY: ReplyValue = { text: "", images: [] };

export const toneOf = (card: Pick<AssistantCard, "kind">): Extract<QuestionTone, "decision" | "urgent"> => (card.kind === "urgent" ? "urgent" : "decision");

/**
 * The code of the task the card is about, beside its project, as every other Assistant card shows
 * it (`ppm/12`: the set spans projects). Only a card that names its tasks has one — the handed-off
 * work card does; with several, the first and "+N".
 */
function HeadTaskCodes({ card }: { card: AssistantCard }) {
  const refs = [...new Set((card.payload.tasks ?? []).map((t) => t.ref))];
  if (!refs.length) return null;
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1" data-decision-task-codes="">
      <TaskCodeText code={refs[0]!} className="text-[11.5px]" />
      {refs.length > 1 && <span className="text-[11px] text-text-subtle" title={refs.slice(1).join(", ")}>+{refs.length - 1}</span>}
    </span>
  );
}

function Head({ card, onOpenChat, onDismiss, busy }: { card: AssistantCard; onOpenChat?: () => void; onDismiss?: () => void; busy: boolean }) {
  const urgent = card.kind === "urgent";
  const Icon = urgent ? TriangleAlert : BellRing;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-semibold [&_svg]:size-3.5",
        urgent ? "bg-error/10 text-error-ink" : "bg-warning/10 text-warning-ink",
      )} data-card-kind-label="">
        <Icon />
        {urgent ? "Urgent" : <><span className="@max-[26rem]/set:hidden">Needs your decision</span><span className="@[26rem]/set:hidden">Decision</span></>}
      </span>
      {card.projectName && (
        <span className="flex min-w-0 max-w-[60%] shrink-0 items-baseline gap-1.5" data-task-code-pair="">
          <span data-task-code-title="" className="min-w-0 truncate rounded-full border border-border bg-panel-2 px-2 py-0.5 font-medium text-text-primary">{card.projectName}</span>
          <HeadTaskCodes card={card} />
        </span>
      )}
      {!card.projectName && <HeadTaskCodes card={card} />}
      <span className="flex-1" />
      <time className="shrink-0 text-[11px] tabular-nums text-text-subtle">{cardTime(card.createdAt)}</time>
      {onOpenChat && (
        <button type="button" className={SET_BUTTON.ghost} onClick={onOpenChat} disabled={!card.sessionId} title="Open manager chat">
          <ExternalLink /><span className="@max-[26rem]/set:hidden">Open chat</span>
        </button>
      )}
      {onDismiss && (
        <button type="button" className={SET_BUTTON.ghost} onClick={onDismiss} disabled={busy} title="Dismiss this card">
          <X /><span className="@max-[26rem]/set:hidden">Dismiss</span>
        </button>
      )}
    </div>
  );
}

export function DoneTabBody({ tab }: { tab: Extract<SetTab, { kind: "done" }> }) {
  const sent = tab.done.how === "sent";
  return (
    <div className="space-y-2" data-decision-done={tab.done.how}>
      <Head card={tab.card} busy />
      <h4 className={cn("text-[15px] font-semibold leading-snug", sent ? "text-text-primary" : "text-text-secondary")}>{tab.card.title}</h4>
      <div className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2",
        sent ? "border-success/35 bg-success/5" : "border-border bg-surface",
      )}>
        <span className={cn("mt-px grid size-5 shrink-0 place-items-center rounded-full [&_svg]:size-3", sent ? "bg-success/15 text-success" : "bg-panel-2 text-text-secondary")}>
          {sent ? <Check /> : <X />}
        </span>
        <div className="min-w-0 text-sm">
          <p className="break-words font-medium text-text-primary" data-decision-done-note="">{tab.done.note}</p>
          <p className="text-xs text-text-secondary">
            {sent ? `Sent on its own · ${cardTime(tab.done.at)} · the other cards still wait.` : "Left out of “Send all”."}
          </p>
        </div>
      </div>
    </div>
  );
}

export function DecisionSetCard({
  card, answer, onAnswer, focusedRow, setFocusedRow, replyRef, onReplyKeyDown, onOpenChat, onDismiss, busy, notice, confirm, onConfirm,
}: {
  card: AssistantCard;
  answer: DecisionAnswer | undefined;
  onAnswer: (answer: DecisionAnswer | null) => void;
  focusedRow: number;
  setFocusedRow: (row: number) => void;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  onReplyKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onOpenChat: () => void;
  onDismiss: () => void;
  busy: boolean;
  notice?: string;
  confirm?: string;
  onConfirm: () => void;
}) {
  const tone = toneOf(card);
  const tiles = decisionTiles(card);
  const draft = card.payload.draft;
  const reply = answer?.kind === "reply" ? answer : EMPTY_REPLY;
  return (
    <div className="space-y-2.5" data-decision-card={card.id} data-assistant-card={card.kind} data-card-status={card.status}>
      <Head card={card} onOpenChat={onOpenChat} onDismiss={onDismiss} busy={busy} />
      {card.provenance && <p className="-mt-1 text-[11px] italic text-text-subtle" data-card-provenance="">{card.provenance}</p>}
      <h4 className="break-words text-[15px] font-semibold leading-snug text-text-primary" data-card-title="">{card.title}</h4>
      {card.body && <CardText text={card.body} fold={false} projectName={card.projectName} />}
      <CardImages images={card.payload.images} />
      {card.payload.tasks && <CardHandedOffTasks projectName={card.projectName} tasks={card.payload.tasks} />}
      {draft && <CardDraft draft={draft} />}
      {card.payload.urgentCapped && (
        <p className="text-xs text-text-subtle">Held for the morning: this manager already raised its urgent reports tonight.</p>
      )}
      {/* Why a card that was answered waits again (the answer never reached the manager chat). */}
      {card.answer?.note && <p className="rounded-md bg-error/10 px-2.5 py-1.5 text-xs text-error-ink" data-card-notice="">{card.answer.note}</p>}

      <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
        {tiles.length > 1 ? "Choose one" : "Your answer"}
      </p>
      <div className="flex flex-col gap-1.5" role="group" aria-label="Answers">
        {tiles.map((tile, i) => (
          <QuestionOptionTile
            key={tile.key}
            index={i}
            tone={tone}
            label={tile.label}
            description={tile.description || undefined}
            selected={sameAnswer(answer, tile.answer)}
            focused={focusedRow === i}
            disabled={busy}
            onSelect={() => { setFocusedRow(i); onAnswer(sameAnswer(answer, tile.answer) ? null : tile.answer); }}
          >
            {tile.draftSha256 && (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-text-subtle [&_svg]:size-3">
                <Lock />Bound to this draft (sha256 {tile.draftSha256.slice(0, 8)}…)
              </span>
            )}
          </QuestionOptionTile>
        ))}
        <DecisionReplyField
          tone={tone}
          value={reply}
          disabled={busy || !card.sessionId}
          focused={focusedRow === tiles.length}
          onFocus={() => setFocusedRow(tiles.length)}
          inputRef={replyRef}
          onKeyDown={onReplyKeyDown}
          placeholder={tiles.length ? "Other — your own words go to the manager chat as written…" : "Your answer, to the manager chat word for word…"}
          // Kept as typed (a first space included); whether it is enough to send is `answerIsReady`'s.
          onChange={(next) => onAnswer(next.text.length || next.images.length ? { kind: "reply", text: next.text, images: next.images } : null)}
        />
      </div>
      {tiles.length === 0 && (
        <p className="text-xs text-text-subtle">
          {draft
            ? "This draft is too long or holds a hidden value, so it cannot be approved here. Answer in words, or open the manager chat."
            : card.payload.options?.length
              ? "These choices are too long or hold a hidden value, so they cannot be pressed here. Answer in words, or open the manager chat."
              : "This card is not shown whole here. Answer in words, or open the manager chat."}
        </p>
      )}
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs" role="alert" data-decision-confirm="">
          <span className="min-w-0 flex-1">{confirm}</span>
          <button type="button" className={toneButtons(tone).primary} onClick={onConfirm} disabled={busy}>Send anyway</button>
        </div>
      )}
      {notice && <p className="text-xs text-error-ink" role="alert" data-decision-notice="">{notice}</p>}
    </div>
  );
}
