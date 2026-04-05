const MAX_MESSAGE_LENGTH = 4096;

/** Escape HTML special chars for Telegram HTML parse mode */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Handles: **bold**, *italic*, `code`, ```pre```, [links](url), ~~strikethrough~~
 * Does NOT handle nested formatting (Telegram limitation).
 */
export function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Code blocks first (prevent inner processing)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`;
  });

  // Inline code: `code` → <code>code</code>
  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Bold: **text** → <b>text</b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* → <i>text</i>
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~ → <s>text</s>
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) → <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return html;
}

/**
 * Split text into chunks that fit Telegram's 4096 char limit.
 * Tries to break at newlines, falling back to word boundaries.
 */
export function chunkMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakAt = -1;
    const searchWindow = remaining.slice(0, maxLen);

    // Try double newline
    breakAt = searchWindow.lastIndexOf("\n\n");
    if (breakAt === -1 || breakAt < maxLen * 0.3) {
      breakAt = searchWindow.lastIndexOf("\n");
    }
    if (breakAt === -1 || breakAt < maxLen * 0.3) {
      breakAt = searchWindow.lastIndexOf(" ");
    }
    if (breakAt === -1 || breakAt < maxLen * 0.3) {
      breakAt = maxLen;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}

/** Truncate text for preview (e.g. session titles), adding ellipsis */
export function truncateForPreview(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}
