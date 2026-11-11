/**
 * Manager rules cards: a note (one muted line, the lines it quotes behind a disclosure) and a held
 * change waiting on the user, shown as every line it adds and removes in file order. Approve change
 * is offered only when the card holds the whole change, uncut (`rulesComplete`, decided by the
 * server); otherwise the change is approved in Settings, which shows the full text. Revert is
 * always offered: it keeps the rules in force. The rules route decides; the card follows its event.
 */
import { Check, ScrollText, Settings, Undo2 } from "@/lib/icons";
import { decideRulesChange } from "@/lib/assistant-cards-api";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell, cardTime } from "./card-shell";
import { useCardAction } from "./use-card-action";

type Props = { card: AssistantCard; onCard?: (card: AssistantCard) => void };
type Change = { op: "add" | "remove"; line: string };

/**
 * Settings → PPM Assistant, where the whole change is shown. Loaded on use: the settings module
 * pulls in the app's stores, which a card list has no other reason to load.
 */
const openRulesSettings = () => {
  void import("@/components/settings/open-settings").then(({ openSettings }) => openSettings("assistant")).catch(() => {});
};

const DIFF_CLASS = "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-xs";

function ChangeLine({ change }: { change: Change }) {
  return change.op === "remove"
    ? <span className="block text-error" data-diff-op="remove">- {change.line}</span>
    : <span className="block text-success" data-diff-op="add">+ {change.line}</span>;
}

function Lines({ changes }: { changes: Change[] }) {
  if (!changes.length) return null;
  return (
    <pre className={DIFF_CLASS} data-card-diff="">
      {changes.map((c, i) => <ChangeLine key={i} change={c} />)}
    </pre>
  );
}

/** A note's lines: removed first, then added (a note quotes, it never asks for a decision). */
const noteChanges = (p: AssistantCard["payload"]): Change[] => [
  ...(p.removed ?? []).map((line) => ({ op: "remove" as const, line })),
  ...(p.added ?? []).map((line) => ({ op: "add" as const, line })),
];

export function RulesNoteCard({ card }: Props) {
  const changes = noteChanges(card.payload);
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
      {changes.length > 0 && (
        <details className="pl-5">
          <summary className="cursor-pointer py-1">Show the lines</summary>
          <Lines changes={changes} />
        </details>
      )}
    </div>
  );
}

export function RulesChangeCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const hash = card.payload.rulesHash;
  const whole = card.payload.rulesComplete === true;
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
          {whole ? (
            <CardButton variant="primary" disabled={busy || !hash} onClick={() => decide("approve")}>
              <Check className="size-3.5" />Approve change
            </CardButton>
          ) : (
            <CardButton variant="primary" onClick={openRulesSettings}>
              <Settings className="size-3.5" />Review in Settings
            </CardButton>
          )}
          <CardButton variant="danger" disabled={busy || !hash} onClick={() => decide("revert")}>
            <Undo2 className="size-3.5" />Revert
          </CardButton>
        </>
      )}
    >
      <h4 className="text-sm font-semibold">{card.title}</h4>
      {card.body && <p className="text-text-secondary">{card.body}</p>}
      <Lines changes={card.payload.changes ?? []} />
      {!whole && (
        <p className="text-xs text-text-secondary" data-rules-incomplete="">
          This card does not show the whole change; review and approve it in Settings.
        </p>
      )}
      <p className="text-xs text-text-subtle">The rules in force stay as they are until you choose.</p>
    </CardShell>
  );
}
