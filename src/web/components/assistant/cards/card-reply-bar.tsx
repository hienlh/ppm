/**
 * The reply-to bar: while the user answers a card in their own words, it stands where the
 * Assistant's composer is and, the way Telegram quotes the message being answered, says over the
 * field which card the words answer ("↩ Replying to card" over "api · Slack draft"); they go to
 * that card's manager chat word for word, not to the Assistant. Sending posts them to the card's manager chat, not to the Assistant;
 * a card that stopped waiting or is a day old asks "send anyway?" first. Closed by its X, Esc, a
 * sent reply, a project switch, or the Assistant view going away; never stored, so a reload ends it.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Undo2, X } from "@/lib/icons";
import { cardRefusal, replyToAssistantCard } from "@/lib/assistant-cards-api";
import { useCardReplyStore, type CardReplyTarget } from "@/stores/assistant-card-reply-store";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";

export const REPLY_PLACEHOLDER = "Your words go to the manager chat word for word…";
export const REPLYING_TO_CARD = "Replying to card";

/**
 * With no props it answers the card the Assistant's composer was pointed at; a manager chat passes
 * the card it is answering in place, and how to close the bar.
 */
export function CardReplyBar(props: { target?: CardReplyTarget; onClose?: () => void } = {}) {
  const storeTarget = useCardReplyStore((s) => s.target);
  const storeClose = useCardReplyStore((s) => s.close);
  const target = props.target ?? storeTarget;
  const close = props.onClose ?? storeClose;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // A new target starts fresh; the field takes the focus so the user can type at once.
  useEffect(() => {
    setText(""); setError(null); setQuestion(null);
    if (target) input.current?.focus();
  }, [target?.cardId]);
  // Leaving the Assistant view ends reply-to mode, and so does switching project.
  useEffect(() => () => close(), [close]);
  const project = useProjectStore((s) => s.activeProject?.name ?? null);
  const projectAtMount = useRef(project);
  useEffect(() => {
    if (project !== projectAtMount.current) { projectAtMount.current = project; close(); }
  }, [project, close]);

  if (!target) return null;

  async function send(force: boolean) {
    if (!target || !text.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await replyToAssistantCard(target.cardId, text, force);
      close();
    } catch (e) {
      const refusal = cardRefusal(e);
      if (refusal.error === "confirm" && refusal.question) setQuestion(refusal.question);
      else setError(refusal.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-1 pt-0.5" data-card-reply-bar="">
      <div
        className="mb-2 flex items-center gap-2 rounded-md border border-border border-l-2 border-l-primary bg-surface/60 py-1 pl-2 pr-0.5 text-xs"
        data-card-reply-quote=""
      >
        <Undo2 className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-primary">{REPLYING_TO_CARD}</span>
          <span className="block truncate text-text-secondary" data-card-reply-title="">
            {target.projectName ? `${target.projectName} · ` : ""}{target.title}
          </span>
        </span>
        <button
          type="button" onClick={close} aria-label="Stop replying to this card" title="Stop replying to this card"
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-elevated md:size-7"
        >
          <X className="size-4" />
        </button>
      </div>
      {question && (
        <div className="mb-2 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs md:flex-row md:items-center" role="alert">
          <span className="flex-1">{question}</span>
          <button
            type="button" disabled={busy} onClick={() => void send(true)}
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground md:h-7 md:text-xs"
          >
            Send anyway
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-panel-2 py-1.5 pl-3 pr-1.5">
        <textarea
          ref={input}
          value={text}
          rows={2}
          onChange={(e) => { setText(e.target.value); setQuestion(null); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); close(); return; }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(false); }
          }}
          placeholder={REPLY_PLACEHOLDER}
          aria-label="Your reply to the card"
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-text-subtle"
        />
        <button
          type="button" onClick={() => void send(false)} disabled={busy || !text.trim()} aria-label="Send to the manager chat"
          className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-50 md:size-9")}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
      {error && <p className="pt-1.5 text-xs text-error" role="alert">{error}</p>}
    </div>
  );
}
