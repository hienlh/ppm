/**
 * Messages sent while the AI was working, shown above the composer until the AI reads them
 * (Claude Code's queue). The list is the server's (`queue_state`), so every device shows the same
 * stack. Send now has the AI read the queue at once; Edit puts a message back into the composer;
 * Remove drops it. A message the AI has already started on cannot be taken back, and the server
 * says so. After a Stop the messages stay, held: they go only on Send now or through Edit. Attached images show as the same thumbnails the sent bubble draws, from the paths in
 * the message's attachment markers, never as the markers' text.
 */
import { memo } from "react";
import { Clock, FileText, Image, Pencil, Send, X } from "@/lib/icons";
import { GALLERY_ROOT_ATTR } from "@/lib/image-gallery";
import { basename } from "@/lib/utils";
import { parseUserMessage, typedText } from "../../../shared/user-message-parse";
import type { QueuedMessage } from "../../../shared/chat-queue";
import { AuthImageThumbnail, isImagePath } from "./message-media";

interface QueuedMessagesStackProps {
  messages: QueuedMessage[];
  /** The chat's project, which an attached image's preview is read through. */
  projectName?: string;
  onSendNow: () => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}

const ROW_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-md text-text-3 transition-colors " +
  "can-hover:hover:bg-surface-hover can-hover:hover:text-text size-11 md:size-7 [&_svg]:size-3.5";

const imagesLabel = (n: number) => (n === 1 ? "1 image" : `${n} images`);

/** What the header says: a Stop leaves messages that wait for the person, not for the AI. */
function queueSummary(messages: QueuedMessage[]): string {
  const held = messages.filter((m) => m.paused).length;
  if (held === 0) return `${messages.length} queued · sent when the AI is ready`;
  if (held === messages.length) return `${held} held after Stop · sent only when you send them`;
  return `${messages.length} queued · ${held} held after Stop`;
}

export const QueuedMessagesStack = memo(function QueuedMessagesStack({ messages, projectName, onSendNow, onEdit, onRemove }: QueuedMessagesStackProps) {
  if (messages.length === 0) return null;
  return (
    <div className="mx-2 mb-1.5 overflow-hidden rounded-xl border border-border-soft bg-panel-2" data-testid="queued-messages">
      <div className="flex items-center gap-2 px-3 py-1 text-[11.5px] text-text-3">
        <Clock className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{queueSummary(messages)}</span>
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
          const parsed = parseUserMessage(message.content);
          const text = typedText(parsed).trim();
          // Images sent with no path in the message have nothing to draw a thumbnail from.
          const unshown = Math.max(0, message.imageCount - parsed.files.filter(isImagePath).length);
          return (
            <li key={message.id} className="flex items-center gap-1 py-0.5 pl-3 pr-1 text-[13px] text-text-2 [&+&]:border-t [&+&]:border-border-soft">
              <div className="min-w-0 flex-1 py-1">
                {parsed.files.length > 0 && (
                  <div className="mb-0.5 flex flex-wrap gap-1.5" {...{ [GALLERY_ROOT_ATTR]: "" }}>
                    {parsed.files.map((filePath, i) =>
                      isImagePath(filePath) ? (
                        <AuthImageThumbnail key={i} filePath={filePath} projectName={projectName} />
                      ) : (
                        <span key={i} className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[11px] text-text-secondary">
                          <FileText className="size-3 shrink-0" />
                          <span className="max-w-32 truncate">{basename(filePath)}</span>
                        </span>
                      ),
                    )}
                  </div>
                )}
                {text ? (
                  <span className="line-clamp-2 whitespace-pre-wrap break-words">{text}</span>
                ) : parsed.terminalBlocks.length > 0 ? (
                  <span className="text-text-3">(terminal output)</span>
                ) : parsed.files.length === 0 ? (
                  <span className="text-text-3">(no text)</span>
                ) : null}
              </div>
              {unshown > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-text-3" title={imagesLabel(unshown)}>
                  <Image className="size-3.5" />
                  {unshown}
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
