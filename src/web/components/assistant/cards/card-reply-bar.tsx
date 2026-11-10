/**
 * The reply-to bar: while the user answers a card in their own words, it stands where the
 * Assistant's composer is and says where the words go ("Replying to: nxsys · Slack draft") and
 * that they go word for word. Sending posts them to the card's manager chat, not to the Assistant;
 * a card that stopped waiting or is a day old asks "send anyway?" first. Closed by its X, by a
 * sent reply, or when the Assistant view goes away — it never sticks.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUp, X } from "@/lib/icons";
import { cardRefusal, replyToAssistantCard } from "@/lib/assistant-cards-api";
import { useCardReplyStore } from "@/stores/assistant-card-reply-store";
import { cn } from "@/lib/utils";

export function CardReplyBar() {
  const target = useCardReplyStore((s) => s.target);
  const close = useCardReplyStore((s) => s.close);
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
  // Leaving the Assistant view ends reply-to mode.
  useEffect(() => () => close(), [close]);

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
    <div className="border-t border-border bg-panel px-3 pb-3 pt-2 md:px-4" data-card-reply-bar="">
      <div className="flex items-center gap-2 pb-2 text-xs text-text-secondary">
        <ArrowRight className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          Replying to: <b className="font-medium text-text-primary">{target.projectName ?? "Assistant"} · {target.title}</b>
          <span className="hidden text-text-subtle sm:inline"> — Your words go to the manager chat word for word</span>
        </span>
        <button
          type="button" onClick={close} aria-label="Stop replying to this card"
          className="ml-auto flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-surface-elevated md:size-6"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <p className="pb-2 text-[11px] text-text-subtle sm:hidden">Your words go to the manager chat word for word</p>
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
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(false); } }}
          placeholder="Your answer, in your own words…"
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
