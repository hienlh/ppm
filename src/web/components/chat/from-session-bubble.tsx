/**
 * A message another PPM session's AI sent into this chat. The person did not write it, so it is
 * drawn apart from their own bubbles — its own colours, on the left, headed with who sent it — and
 * offers only Copy and Copy turn link: there is nothing of the person's to edit or fork.
 *
 * Drawn from the message's own block: no request, and the same size on every render. The header
 * opens the sending session at the turn the message was sent from.
 */
import { MessageSquare } from "@/lib/icons";
import type { ChatMessage } from "../../../types/chat";
import type { FromSessionReference } from "../../../shared/chat-from-session";
import type { AssistantProvenance } from "../../../shared/assistant-provenance";
import type { TurnReference } from "../../../shared/chat-turn-ref";
import { openLinkedSession, providerLabel } from "@/lib/session-collab-client";
import { MarkdownContent } from "./message-markdown";
import { CollapsibleMessageBody } from "./collapsible-message-body";
import { MessageActionBar } from "./message-action-bar";
import { CopyTurnLinkButton } from "./copy-turn-link-button";
import { ProviderBadge } from "./provider-selector";
import { TurnRefChipRow } from "./turn-ref-chip";

const STARTED_BY_TEXT: Record<AssistantProvenance["startedBy"], string> = {
  user_ppm: "started by you in PPM",
  user_telegram: "started by you on Telegram",
  ppm: "started by PPM on a report",
};

/** One line saying how the Assistant's turn behind this message started, as PPM recorded it. */
export function provenanceLine(p: AssistantProvenance): string {
  return `Asked by PPM Assistant · ${STARTED_BY_TEXT[p.startedBy]}${p.untrusted ? " · other text in that turn" : ""}`;
}

export function FromSessionBubble({ from, provenance, text, plainContent, turnRefs, turn, timestamp, projectName, sessionId, providerId }: {
  from: FromSessionReference;
  /** How the PPM Assistant's turn that sent it started; only on its messages to a manager chat. */
  provenance?: AssistantProvenance | null;
  /** The message body without its blocks. */
  text: string;
  /** What Copy copies: the body as the receiving AI read it, blocks removed. */
  plainContent: string;
  turnRefs: TurnReference[] | null;
  turn?: Pick<ChatMessage, "turnId" | "clientId" | "sdkUuid">;
  timestamp: string;
  projectName?: string;
  sessionId?: string;
  providerId?: string;
}) {
  const provider = providerLabel(from.providerId);
  // The PPM Assistant is named as such; its session opens in the Assistant, never in a project.
  const sender = from.kind === "assistant" ? "PPM Assistant" : from.title;
  const openSender = () => void openLinkedSession({
    projectName: from.projectName,
    providerId: from.providerId,
    sessionId: from.sessionId,
    title: from.title,
    turnId: from.turnId,
  });

  return (
    <div className="flex flex-col items-start gap-1" data-from-session={from.sessionId}>
      <div
        style={{ borderRadius: "var(--rad) var(--rad) var(--rad) 4px" }}
        className="max-w-[85%] min-w-0 border border-info/30 bg-info/10 px-3 pb-2 text-sm text-text shadow-sm"
      >
        <button
          type="button"
          onClick={openSender}
          title={from.kind === "assistant" ? "Open the PPM Assistant" : from.turnId ? `Open "${from.title}" at the turn that sent this` : `Open "${from.title}"`}
          className="-mx-1 flex min-h-11 w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs text-info transition-colors can-hover:hover:bg-info/10 md:min-h-8"
        >
          <MessageSquare className="size-3.5 shrink-0" />
          <span className="shrink-0">From:</span>
          <span className="min-w-0 truncate font-semibold">{sender}</span>
          <span className="shrink-0 opacity-70">·</span>
          <ProviderBadge providerId={from.providerId} />
          <span className="shrink-0 opacity-80">{provider}</span>
        </button>
        {provenance && (
          <p className="-mt-1 mb-1 text-xs text-text-subtle" data-provenance={provenance.startedBy}>
            {provenanceLine(provenance)}
          </p>
        )}
        {turnRefs && turnRefs.length > 0 && <TurnRefChipRow refs={turnRefs} currentProject={projectName} />}
        {/* Folds like the person's own bubble; the header above stays visible. Raw HTML off:
            the text was written by another session's AI. */}
        {text && (
          <CollapsibleMessageBody
            watch={text}
            className="min-w-0 break-words select-text"
            toggleClassName="text-info/80 can-hover:hover:text-info"
          >
            <MarkdownContent content={text} projectName={projectName} rawHtml={false} />
          </CollapsibleMessageBody>
        )}
      </div>
      <MessageActionBar timestamp={timestamp} content={plainContent}>
        {turn && projectName && sessionId && (providerId === "claude" || providerId === "codex") && (
          <CopyTurnLinkButton message={turn} projectName={projectName} sessionId={sessionId} providerId={providerId} />
        )}
      </MessageActionBar>
    </div>
  );
}
