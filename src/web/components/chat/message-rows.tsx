/**
 * The rows of a transcript: one per rendered message, each a bubble with its action bar.
 *
 * Shared by the live list and the history window (a block of older turns shown on their own
 * after a jump), so both draw a message the same way. Everything a row needs that depends on its
 * neighbours — whether it closes an assistant turn, what Copy gathers, whether the message a
 * reply quotes is loaded — is worked out here from the list it is given.
 */
import type { ReplyReference } from "../../../shared/chat-reply";
import { decodeMessageBlocks } from "../../../shared/chat-message-blocks";
import type { ChatMessage } from "../../../types/chat";
import type { VersionGroup } from "../../../types/api";
import type { BashPartialEntry } from "../../hooks/use-chat";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import type { SessionTurn } from "@/lib/session-turns";
import { RenderErrorBoundary } from "@/components/shared/markdown-error-boundary";
import { resolveReplyMessage } from "./message-reply-reference";
import { MessageBubble, assistantMessageText } from "./message-bubble";
import { CompactionDivider } from "./compaction-divider";

export interface MessageRowsProps {
  /** The messages to draw, already filtered to the ones that render. */
  rows: ChatMessage[];
  /** 1-based user-message ordinal per row (0 for other roles); see `userMessageOrdinals`. */
  userOrdinals: number[];
  userOrdinalOffset: number;
  versionMap?: Record<number, VersionGroup>;
  editingMsgId?: string;
  /** File changes per turn, keyed by the row index of the turn's last assistant message. */
  turnChanges?: Map<number, TurnFileChange[]>;
  /** The turn each change pill closes, keyed the same way. */
  rollupTurns?: Map<number, SessionTurn>;
  isStreaming: boolean;
  projectName?: string;
  sessionId?: string;
  providerId?: string;
  historyPredecessorId: string | null;
  /** Reply is offered only where this is given. */
  onReply?: (message: ChatMessage) => void;
  onJumpToReply?: (reply: ReplyReference) => void;
  onJumpToEdit?: (editRef: string) => void;
  onFork?: (content: string, messageId: string | undefined) => void;
  onEdit?: (content: string, messageId: string | undefined, ownMsgId?: string) => void;
  onDismiss?: (messageId: string) => void;
  onNavigateVersion?: (sessionId: string) => void;
  bashPartialOutput?: React.RefObject<Map<string, BashPartialEntry>>;
}

/**
 * Which rows open a turn: the first row of each turn id. A message in no turn (a compaction
 * marker inside a turn) does not end the turn around it, so the row after it is not a second start.
 */
function turnStarts(rows: ChatMessage[]): (string | undefined)[] {
  let current: string | undefined;
  return rows.map((msg) => {
    if (!msg.turnId || msg.turnId === current) return undefined;
    current = msg.turnId;
    return msg.turnId;
  });
}

export function MessageRows({
  rows, userOrdinals, userOrdinalOffset, versionMap, editingMsgId, turnChanges, rollupTurns, isStreaming,
  projectName, sessionId, providerId, historyPredecessorId, onReply, onJumpToReply, onJumpToEdit,
  onFork, onEdit, onDismiss, onNavigateVersion, bashPartialOutput,
}: MessageRowsProps) {
  const starts = turnStarts(rows);
  return (
    <>
      {rows.map((msg, globalIdx) => {
        const prevMsg = globalIdx > 0 ? rows[globalIdx - 1] : undefined;
        // User-message ordinal (1-based) — stable version-group anchor across forks.
        const localOrdinal = userOrdinals[globalIdx] ?? 0;
        const versionOrdinal = localOrdinal ? localOrdinal + userOrdinalOffset : 0;
        // Resolved here rather than deeper down so the ordinal→group lookup
        // happens once per message instead of being threaded through bubbles.
        const versionGroup = versionOrdinal ? versionMap?.[versionOrdinal] : undefined;
        // Highlight the user message armed for edit (matched by its own id).
        const isEditing = msg.role === "user" && editingMsgId != null && msg.id === editingMsgId;
        // An assistant turn spans multiple consecutive assistant messages (text +
        // tool segments). Show the action bar only on the last one of the run.
        const nextMsg = rows[globalIdx + 1];
        const isLastAssistantInTurn = msg.role === "assistant" && nextMsg?.role !== "assistant";
        // Copy gathers the whole turn: walk back over consecutive assistant
        // messages and join their visible text (tool-only segments contribute nothing).
        let turnCopyText: string | undefined;
        let turnReplyMessage: ChatMessage | undefined;
        if (isLastAssistantInTurn) {
          const parts: string[] = [];
          for (let j = globalIdx; j >= 0 && rows[j]!.role === "assistant"; j--) {
            const t = assistantMessageText(rows[j]!);
            if (t) {
              parts.unshift(t);
              turnReplyMessage ??= rows[j]!;
            }
          }
          turnCopyText = parts.join("\n\n");
        }
        // A boolean rather than a lookup the bubble calls while rendering: it has to change
        // when older history brings the quoted message in, and not on every streamed flush.
        const replyTo = msg.role === "user" ? decodeMessageBlocks(msg.content).replyTo : null;
        const replyAvailable = replyTo ? !!resolveReplyMessage(rows, replyTo, sessionId, providerId) : undefined;
        return (
          <div
            key={msg.id}
            data-msg-index={globalIdx}
            data-msg-id={msg.id}
            data-turn-start={starts[globalIdx]}
            className="px-4 pt-4 select-none"
          >
            {/* Above the summary rather than beside it: the rule is what marks
                where the conversation was cut, and the summary is the first
                message on the new side of it. */}
            {msg.compaction && <CompactionDivider compaction={msg.compaction} />}
            <RenderErrorBoundary fallbackContent={msg.content}>
              <MessageBubble
                message={msg}
                onReply={onReply && sessionId && providerId && (msg.role !== "assistant" || turnReplyMessage)
                  ? onReply
                  : undefined}
                replyTarget={turnReplyMessage}
                onJumpToReply={onJumpToReply}
                replyAvailable={replyAvailable}
                isStreaming={isStreaming && msg.id.startsWith("streaming-")}
                isLastAssistantInTurn={isLastAssistantInTurn}
                turnCopyText={turnCopyText}
                turnChanges={isLastAssistantInTurn ? turnChanges?.get(globalIdx) : undefined}
                turn={isLastAssistantInTurn ? rollupTurns?.get(globalIdx) : undefined}
                onJumpToEdit={onJumpToEdit}
                projectName={projectName}
                onFork={msg.role === "user" ? onFork : undefined}
                onEdit={msg.role === "user" ? onEdit : undefined}
                isEditing={isEditing}
                onDismiss={msg.role === "system" ? onDismiss : undefined}
                prevMsgId={prevMsg ? prevMsg.sdkUuid ?? prevMsg.id : historyPredecessorId ?? undefined}
                sessionId={sessionId}
                providerId={providerId}
                versionGroup={versionGroup}
                onNavigateVersion={onNavigateVersion}
                versionNavDisabled={isStreaming}
                bashPartialOutput={bashPartialOutput}
              />
            </RenderErrorBoundary>
          </div>
        );
      })}
    </>
  );
}
