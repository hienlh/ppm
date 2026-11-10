/**
 * Messages sent while the AI was working, shown above the composer until the AI reads them
 * (Claude Code's queue). The list is the server's (`queue_state`), so every device shows the same
 * stack. Send now has the AI read the queue at once; Edit puts a message back into the composer;
 * Remove drops it. A message the AI has already started on cannot be taken back, and the server
 * says so.
 */
import { memo } from "react";
import { Clock, Image, Pencil, Send, X } from "@/lib/icons";
import { decodeMessageBlocks } from "../../../shared/chat-message-blocks";
import type { QueuedMessage } from "../../../shared/chat-queue";

interface QueuedMessagesStackProps {
  messages: QueuedMessage[];
  onSendNow: () => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}

const ROW_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-md text-text-3 transition-colors " +
  "can-hover:hover:bg-surface-hover can-hover:hover:text-text size-11 md:size-7 [&_svg]:size-3.5";

export const QueuedMessagesStack = memo(function QueuedMessagesStack({ messages, onSendNow, onEdit, onRemove }: QueuedMessagesStackProps) {
  if (messages.length === 0) return null;
  return (
    <div className="mx-2 mb-1.5 overflow-hidden rounded-xl border border-border-soft bg-panel-2" data-testid="queued-messages">
      <div className="flex items-center gap-2 px-3 py-1 text-[11.5px] text-text-3">
        <Clock className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{messages.length} queued · sent when the AI is ready</span>
        <button
          type="button"
          onClick={onSendNow}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-medium text-text-2 transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-text md:min-h-7 [&_svg]:size-3.5"
          title="Have the AI read the queue now (Ctrl+Enter)"
        >
          <Send />
          Send now
        </button>
      </div>
      <ul className="max-h-40 overflow-y-auto border-t border-border-soft">
        {messages.map((message) => {
          const text = decodeMessageBlocks(message.content).content.trim();
          return (
            <li key={message.id} className="flex items-center gap-1 py-0.5 pl-3 pr-1 text-[13px] text-text-2 [&+&]:border-t [&+&]:border-border-soft">
              <span className="min-w-0 flex-1 line-clamp-2 whitespace-pre-wrap break-words">
                {text || <span className="text-text-3">(no text)</span>}
              </span>
              {message.imageCount > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-text-3" title={`${message.imageCount} image${message.imageCount === 1 ? "" : "s"}`}>
                  <Image className="size-3.5" />
                  {message.imageCount}
                </span>
              )}
              <button type="button" onClick={() => onEdit(message.id)} className={ROW_BUTTON} title="Edit — move back to the input" aria-label="Edit queued message">
                <Pencil />
              </button>
              <button type="button" onClick={() => onRemove(message.id)} className={ROW_BUTTON} title="Remove from queue" aria-label="Remove queued message">
                <X />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
