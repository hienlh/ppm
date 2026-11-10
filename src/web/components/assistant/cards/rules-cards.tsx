/**
 * Manager rules cards: a note (one muted line, the lines it quotes behind a disclosure) and a held
 * change waiting on the user, shown as the lines it adds and removes, with Approve change and
 * Revert naming the change by its hash. The rules route decides; the card follows its event.
 */
import { Check, ScrollText, Undo2 } from "@/lib/icons";
import { decideRulesChange } from "@/lib/assistant-cards-api";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell, cardTime } from "./card-shell";
import { useCardAction } from "./use-card-action";

type Props = { card: AssistantCard; onCard?: (card: AssistantCard) => void };

function Lines({ added, removed }: { added?: string[]; removed?: string[] }) {
  if (!added?.length && !removed?.length) return null;
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-xs" data-card-diff="">
      {(removed ?? []).map((l, i) => <span key={`r${i}`} className="block text-error">- {l}</span>)}
      {(added ?? []).map((l, i) => <span key={`a${i}`} className="block text-success">+ {l}</span>)}
    </pre>
  );
}

export function RulesNoteCard({ card }: Props) {
  const { added, removed } = card.payload;
  const quoted = (added?.length ?? 0) + (removed?.length ?? 0);
  return (
    <div className="w-full px-1 text-xs text-text-subtle" data-assistant-card="rules_note" data-card-status={card.status}>
      <p className="flex items-center gap-1.5">
        <ScrollText className="size-3.5 shrink-0" />
        <span className="font-medium">Rules updated</span>
        {card.projectName && <span>· {card.projectName}</span>}
        <span className="min-w-0 truncate">· {card.title}</span>
        <time className="ml-auto shrink-0">{cardTime(card.createdAt)}</time>
      </p>
      {card.body && <p className="pl-5">{card.body}</p>}
      {quoted > 0 && (
        <details className="pl-5">
          <summary className="cursor-pointer py-1">Show the lines</summary>
          <Lines added={added} removed={removed} />
        </details>
      )}
    </div>
  );
}

export function RulesChangeCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const hash = card.payload.rulesHash;
  const decide = (action: "approve" | "revert") => {
    if (!card.projectName || !hash) return;
    void run(() => decideRulesChange(card.projectName!, action, hash));
  };
  return (
    <CardShell
      card={card}
      look={{ label: "Rules change waiting", Icon: ScrollText, tone: "need" }}
      error={error}
      actions={(
        <>
          <CardButton variant="primary" disabled={busy || !hash} onClick={() => decide("approve")}>
            <Check className="size-3.5" />Approve change
          </CardButton>
          <CardButton variant="danger" disabled={busy || !hash} onClick={() => decide("revert")}>
            <Undo2 className="size-3.5" />Revert
          </CardButton>
        </>
      )}
    >
      <h4 className="text-sm font-semibold">{card.title}</h4>
      {card.body && <p className="text-text-secondary">{card.body}</p>}
      <Lines added={card.payload.added} removed={card.payload.removed} />
      <p className="text-xs text-text-subtle">The rules in force stay as they are until you choose.</p>
    </CardShell>
  );
}
