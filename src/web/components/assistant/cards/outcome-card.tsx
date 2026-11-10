/**
 * Cards that only tell the user something: a manager's done or failed report (or a failure PPM
 * saw itself, which carries no manager's provenance line), the morning digest folded to one line,
 * and the Assistant pausing its own messages.
 */
import { useState } from "react";
import { ChevronDown, CircleCheckIcon, Coffee, ExternalLink, Pause, X, XCircle } from "@/lib/icons";
import { dismissAssistantCard } from "@/lib/assistant-cards-api";
import { cn } from "@/lib/utils";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell } from "./card-shell";
import { openManagerChat, useCardAction } from "./use-card-action";

type Props = { card: AssistantCard; onCard?: (card: AssistantCard) => void };

export function OutcomeCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const failed = card.kind === "failed";
  return (
    <CardShell
      card={card}
      look={failed ? { label: "Failed", Icon: XCircle, tone: "fail" } : { label: "Done", Icon: CircleCheckIcon, tone: "ok" }}
      error={error}
      actions={(
        <>
          <CardButton onClick={() => openManagerChat(card)} disabled={!card.sessionId}>
            <ExternalLink className="size-3.5" />Open manager chat
          </CardButton>
          <CardButton variant="ghost" disabled={busy} onClick={() => void run(() => dismissAssistantCard(card.id))}>
            <X className="size-3.5" />Dismiss
          </CardButton>
        </>
      )}
    >
      <h4 className="text-sm font-semibold">{card.title}</h4>
      {card.body && <p className="whitespace-pre-wrap break-words text-text-secondary">{card.body}</p>}
      {card.payload.detected && <p className="text-xs text-text-subtle">Seen by PPM: the manager chat has not reported on it.</p>}
    </CardShell>
  );
}

export function BudgetCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  return (
    <CardShell
      card={card}
      look={{ label: "Assistant paused messaging", Icon: Pause, tone: "need" }}
      error={error}
      actions={(
        <CardButton variant="ghost" disabled={busy} onClick={() => void run(() => dismissAssistantCard(card.id))}>
          <X className="size-3.5" />Dismiss
        </CardButton>
      )}
    >
      <p className="text-text-secondary">{card.body || card.title}</p>
    </CardShell>
  );
}

export function DigestFold({ card }: Props) {
  const [open, setOpen] = useState(false);
  const items = card.payload.items ?? [];
  return (
    <div className="w-full rounded-xl border border-border bg-surface" data-assistant-card="digest" data-card-status={card.status}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm md:min-h-9"
      >
        <Coffee className="size-4 shrink-0 text-primary" />
        <span className="font-semibold">Morning digest</span>
        <span className="min-w-0 truncate text-text-secondary">· {card.projectName ?? "project"}, {items.length} item{items.length === 1 ? "" : "s"}</span>
        <ChevronDown className={cn("ml-auto size-4 shrink-0 text-text-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-1 border-t border-border px-3 py-2 text-sm">
          {card.provenance && <p className="text-[11px] italic text-text-subtle">{card.provenance}</p>}
          <p className="font-medium">{card.title}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-text-secondary">
            {items.map((item, i) => <li key={`${i}:${item}`} className="break-words">{item}</li>)}
          </ul>
          <CardButton variant="ghost" onClick={() => openManagerChat(card)} disabled={!card.sessionId}>
            <ExternalLink className="size-3.5" />Open manager chat
          </CardButton>
        </div>
      )}
    </div>
  );
}
