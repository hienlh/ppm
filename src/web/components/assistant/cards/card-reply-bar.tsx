/**
 * The reply-to bar: while the user answers a card in their own words, it stands where the
 * Assistant's composer is and, the way Telegram quotes the message being answered, says over the
 * field which card the words answer ("↩ Replying to card" over "api · Slack draft"); they go to
 * that card's manager chat word for word, not to the Assistant. Sending posts them to the card's manager chat, not to the Assistant;
 * a card that stopped waiting or is a day old asks "send anyway?" first. Closed by its X, Esc, a
 * sent reply, a project switch, or the Assistant view going away; never stored, so a reload ends it.
 *
 * The mic beside the field answers by voice, through the chat composer's own voice flow: the words
 * reach the manager chat as a voice message (player, transcript), the server checking the
 * recording's upload receipt before it calls them spoken.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Undo2, X } from "@/lib/icons";
import { cardRefusal, replyToAssistantCard } from "@/lib/assistant-cards-api";
import { useCardReplyStore, type CardReplyTarget } from "@/stores/assistant-card-reply-store";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useCardVoiceReply } from "@/hooks/use-card-voice-reply";
import { CardVoiceDraftArea, CardVoiceMicButton } from "./card-voice-reply-parts";

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
  const textRef = useRef(text);
  textRef.current = text;
  const sendRef = useRef<(force: boolean) => Promise<void>>(async () => {});
  const voiceTarget = useMemo(
    () => (target ? { projectName: target.projectName, sessionId: target.sessionId ?? null, providerId: target.providerId } : null),
    [target?.cardId, target?.projectName, target?.sessionId, target?.providerId],
  );
  const voice = useCardVoiceReply({ card: voiceTarget, getTyped: () => textRef.current, send: () => void sendRef.current(false), blocked: busy });

  // A new target starts fresh; the field takes the focus so the user can type at once.
  useEffect(() => {
    setText(""); setError(null); setQuestion(null);
    // A recording made for another card never answers this one.
    voice.remove();
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
    if (!target || busy) return;
    // A recording is the whole reply: its transcript, sent as a voice message.
    const spoken = voice.draft ? voice.reply() : null;
    if (voice.draft ? !spoken : !text.trim()) return;
    setBusy(true); setError(null);
    try {
      await replyToAssistantCard(target.cardId, spoken?.text ?? text, force, [], spoken ? { voice: spoken.voice } : {});
      if (spoken) voice.sent();
      close();
    } catch (e) {
      const refusal = cardRefusal(e);
      if (refusal.error === "confirm" && refusal.question) setQuestion(refusal.question);
      else setError(refusal.error);
    } finally {
      setBusy(false);
    }
  }
  sendRef.current = send;
  /** Send or Enter: with a voice waiting, the composer's rules decide (now, when ready, or not). */
  const submit = () => (voice.draft ? voice.requestSend() : void send(false));

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
        <div className="min-w-0 flex-1">
        <CardVoiceDraftArea voice={voice} onSubmit={submit} disabled={busy} />
        {!voice.recording && !voice.draft && (
        <textarea
          ref={input}
          value={text}
          rows={2}
          onChange={(e) => { setText(e.target.value); setQuestion(null); }}
          onKeyDown={(e) => {
            // Escape ends the reply only, not a sheet the bar sits in.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
          placeholder={REPLY_PLACEHOLDER}
          aria-label="Your reply to the card"
          className="block max-h-40 min-h-11 w-full resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-text-subtle"
        />
        )}
        </div>
        <CardVoiceMicButton voice={voice} typed={text} disabled={busy} className="mb-2.5 max-md:mb-1.5" />
        <button
          type="button" onClick={submit} disabled={busy || (!text.trim() && !voice.draft)} aria-label="Send to the manager chat"
          className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-50 md:size-9")}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
      {error && <p className="pt-1.5 text-xs text-error" role="alert">{error}</p>}
    </div>
  );
}
