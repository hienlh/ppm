import { splitAttachmentMarkers } from "@/lib/attachment-marker-split";
import type { ChatAttachment } from "./message-input";

/**
 * Build message content with file references and inline text snippets prepended.
 * Pure (no React state) so callers besides the chat tab — e.g. the extension composer
 * dialog — can produce byte-identical output for the same (content, attachments) pair
 * without re-implementing the send-time formatting rules.
 */
export function buildMessageWithAttachments(
  content: string,
  attachments: ChatAttachment[],
  inlineImages: Array<{ data: string; mediaType: string }> = [],
): string {
  if (attachments.length === 0) return content;

  const parts: string[] = [];

  // Inline text snippets (e.g. terminal output)
  for (const att of attachments) {
    if (att.textContent) parts.push(att.textContent);
  }

  // Server-uploaded file references. An image keeps its path even when the payload rides
  // along with the message, because the transcript is what the chat re-renders from and
  // the path is the only thing in it a thumbnail can be drawn from.
  //
  // An image sent inline says so in the marker. A bare path in a user message reads as an
  // invitation to open it, and a model that takes it pays for the same picture twice —
  // once inline, once as a tool result, both replayed on every later turn.
  //
  // Which marker an image gets follows the payloads that are actually going out, not
  // `imageData` alone: the per-message caps can leave one behind, and announcing that its
  // contents are included would hand the model neither the picture nor a reason to open
  // the file. `inlineImages` defaults to none, so a caller that sends no payloads at all
  // (the edit-fork path takes only text) gets the plain markers throughout.
  const { inlineImagePaths, pathOnlyPaths } = splitAttachmentMarkers(attachments, inlineImages);
  for (const path of inlineImagePaths) {
    parts.push(`[Attached image (contents included in this message): ${path}]`);
  }
  if (pathOnlyPaths.length > 0) {
    const fileRefs = pathOnlyPaths.join("\n");
    parts.push(
      pathOnlyPaths.length === 1
        ? `[Attached file: ${fileRefs}]`
        : `[Attached files:\n${fileRefs}\n]`,
    );
  }

  if (parts.length === 0) return content;
  return parts.join("\n\n") + "\n\n" + content;
}
