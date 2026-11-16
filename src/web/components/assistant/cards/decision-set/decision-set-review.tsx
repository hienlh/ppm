/**
 * The step before "Send all": every answer about to leave, one line per card, in the set's order.
 * An OK on a draft names who it goes to, its first line and its hash, so nothing goes out that the
 * user is not looking at; a reply to a card older than a day says it will be sent anyway (the
 * server would ask); a card with no answer says it keeps waiting.
 */
import { ArrowLeft, Check } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { answerLabel, isStaleForReply, type DecisionAnswer } from "@/lib/decision-set/decision-set-model";
import type { AssistantCard } from "../../../../../shared/assistant-cards";
import { escapeHiddenCharacters } from "../../../../../shared/reveal-hidden-characters";
import { SET_BUTTON } from "./decision-set-buttons";

export function DecisionSetReview({ cards, plan, now, busy, onBack, onSend }: {
  /** Every card that still waits, in the set's order. */
  cards: readonly AssistantCard[];
  plan: ReadonlyArray<{ card: AssistantCard; answer: DecisionAnswer }>;
  now: number;
  busy: boolean;
  onBack: () => void;
  onSend: () => void;
}) {
  const answers = new Map(plan.map((p) => [p.card.id, p.answer]));
  return (
    <div className="space-y-2.5" data-decision-review="">
      <h4 className="text-sm font-semibold text-text-primary">Send {plan.length} answer{plan.length === 1 ? "" : "s"}?</h4>
      <p className="text-xs text-text-secondary">
        Each goes to its own manager chat, one card at a time. A card answered elsewhere meanwhile is skipped and says so.
      </p>
      <ol className="space-y-1.5">
        {cards.map((card, i) => {
          const answer = answers.get(card.id);
          const draft = card.payload.draft;
          return (
            <li
              key={card.id}
              className={cn("flex min-w-0 items-start gap-2.5 rounded border px-2.5 py-2 text-xs", answer ? "border-border bg-background" : "border-dashed border-border opacity-70")}
              data-review-row={card.id}
            >
              <span className={cn(
                "mt-px grid size-4.5 shrink-0 place-items-center rounded-full text-[10px] font-semibold",
                !answer ? "bg-surface-elevated text-text-secondary" : card.kind === "urgent" ? "bg-error/20 text-error" : "bg-warning/20 text-warning",
              )}>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-text-secondary">{card.projectName ? `${card.projectName} · ` : ""}{card.title}</p>
                {answer ? (
                  <>
                    <p className="break-words text-[13px] font-medium text-text-primary">{answerLabel(card, answer)}</p>
                    {answer.kind === "ok" && draft && (
                      <p className="truncate font-mono text-[11px] text-text-secondary">
                        {escapeHiddenCharacters(draft.text.split("\n")[0] ?? "")}… · sha256 {draft.sha256.slice(0, 8)}…
                      </p>
                    )}
                    {answer.kind === "reply" && isStaleForReply(card, now) && (
                      <p className="text-[11px] text-warning">From over a day ago: sending confirms it anyway.</p>
                    )}
                  </>
                ) : (
                  <p className="text-[13px] text-text-secondary">No answer yet — keeps waiting</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-2 border-t border-border-soft pt-2.5">
        <button type="button" className={SET_BUTTON.plain} onClick={onBack} disabled={busy}><ArrowLeft />Back</button>
        <span className="flex-1" />
        <button type="button" className={SET_BUTTON.primary} onClick={onSend} disabled={busy || plan.length === 0} data-decision-send-reviewed="">
          <Check />Send {plan.length} answer{plan.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
