/**
 * One message of the transcript: a user bubble, a system notice, or an assistant reply with its
 * events and, on the last message of a turn, the action bar. Memoised: a streamed flush replaces
 * only the newest message, so only its bubble may draw again.
 */
import { memo } from "react";
import type { ReplyReference } from "../../../shared/chat-reply";
import type { ChatMessage } from "../../../types/chat";
import type { VersionGroup } from "../../../types/api";
import type { BashPartialEntry } from "../../hooks/use-chat";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import type { SessionTurn } from "@/lib/session-turns";
import { AlertCircle, XCircle } from "@/lib/icons";
import { createReplyReference } from "./message-reply-reference";
import { TurnChangeRollup } from "./turn-change-rollup";
import { TurnCostWarning } from "./turn-cost-warning";
import { MarkdownContent } from "./message-markdown";
import { UserBubble } from "./message-user-bubble";
import { InterleavedEvents } from "./message-events";

/** Visible assistant text of a single message — text events only (skips tool cards),
 *  falling back to raw content when there are no events. */
export function assistantMessageText(msg: ChatMessage): string {
  return msg.events?.length
    ? msg.events.filter((e) => e.type === "text").map((e) => e.content).join("")
    : msg.content;
}

export const MessageBubble = memo(function MessageBubble({ message, isStreaming, isLastAssistantInTurn, turnCopyText, turnChanges, turn, onJumpToEdit, projectName, onFork, onEdit, isEditing, onDismiss, prevMsgId, sessionId, providerId, versionGroup, onNavigateVersion, versionNavDisabled, bashPartialOutput, onReply, replyTarget, onJumpToReply, replyAvailable }: {
  onReply?: (message: ChatMessage) => void;
  /** Assistant only: the message of this turn that Reply quotes, which may be an earlier one. */
  replyTarget?: ChatMessage;
  onJumpToReply?: (reply: ReplyReference) => void;
  /** Whether the message this one quotes is in the list; undefined when it quotes none. */
  replyAvailable?: boolean;
  message: ChatMessage; isStreaming: boolean; isLastAssistantInTurn?: boolean; turnCopyText?: string; projectName?: string;
  /** Files this turn changed — drives the action-bar change pill. */
  turnChanges?: TurnFileChange[];
  /** The turn this message closes: what the change tray's "Revert turn" puts back. */
  turn?: SessionTurn;
  onJumpToEdit?: (editRef: string) => void;
  onFork?: (content: string, messageId: string | undefined) => void;
  onEdit?: (content: string, messageId: string | undefined, ownMsgId?: string) => void;
  isEditing?: boolean;
  onDismiss?: (messageId: string) => void;
  prevMsgId?: string;
  sessionId?: string;
  providerId?: string;
  versionGroup?: VersionGroup;
  onNavigateVersion?: (sessionId: string) => void;
  versionNavDisabled?: boolean;
  bashPartialOutput?: React.RefObject<Map<string, BashPartialEntry>>;
}) {
  if (message.role === "user") {
    const handleFork = onFork ? () => onFork(message.content, prevMsgId) : undefined;
    const handleEdit = onEdit ? () => onEdit(message.content, prevMsgId, message.id) : undefined;
    return (
      <UserBubble
        content={message.content}
        messageId={message.id}
        // A copy a compaction wrote back is in no turn; there is nothing to link to.
        turn={message.synthetic ? undefined : message}
        timestamp={message.timestamp}
        projectName={projectName}
        onReply={onReply && createReplyReference(message, sessionId ?? "", providerId ?? "") ? () => onReply(message) : undefined}
        onJumpToReply={onJumpToReply}
        replyAvailable={replyAvailable}
        onFork={handleFork}
        onEdit={handleEdit}
        isEditing={isEditing}
        sessionId={sessionId}
        providerId={providerId}
        versionGroup={versionGroup}
        onNavigateVersion={onNavigateVersion}
        versionNavDisabled={versionNavDisabled}
      />
    );
  }

  // Where a turn read straight from the transcript was compacted: a marker, not an error.
  if (message.role === "system" && message.synthetic) {
    return (
      <div className="flex items-center gap-2 text-xs text-text-subtle" role="separator">
        <span className="h-px flex-1 bg-border" />
        Context compacted here
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="group flex items-center gap-2 rounded-lg bg-error/10 border border-error/20 px-3 py-2 text-sm text-error">
        <AlertCircle className="size-4 shrink-0" />
        <p className="flex-1">{message.content}</p>
        {onDismiss && (
          <button
            type="button"
            onClick={() => onDismiss(message.id)}
            aria-label="Dismiss"
            title="Dismiss"
            className="shrink-0 rounded p-1 text-error/70 hover:text-error hover:bg-error/15 md:opacity-0 md:group-hover:opacity-100"
          >
            <XCircle className="size-4" />
          </button>
        )}
      </div>
    );
  }

  // Assistant message — render events in order (text interleaved with tool calls)
  return (
    <div className="flex flex-col gap-2">
      {message.events && message.events.length > 0
        ? <InterleavedEvents events={message.events} isStreaming={isStreaming} projectName={projectName} bashPartialOutput={bashPartialOutput} />
        : message.content && (
            <div className="text-sm text-text-primary select-text">
              <MarkdownContent content={message.content} projectName={projectName} />
            </div>
          )}
      {/* Cost notice sits above the action bar so it reads as part of the finished turn */}
      {!isStreaming && isLastAssistantInTurn && message.usage && (
        <TurnCostWarning usage={message.usage} />
      )}
      {/* Action bar: only on the last assistant message of the turn, after streaming ends */}
      {!isStreaming && isLastAssistantInTurn && (
        <TurnChangeRollup
          onReply={onReply && replyTarget ? () => onReply(replyTarget) : undefined}
          timestamp={message.timestamp}
          content={turnCopyText ?? assistantMessageText(message)}
          changes={turnChanges}
          turn={turn}
          onJumpToEdit={onJumpToEdit}
        />
      )}
    </div>
  );
});
