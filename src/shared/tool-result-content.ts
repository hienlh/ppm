/**
 * Serialization of a tool_result `content` value for transport to the chat UI.
 *
 * Tools that read images return base64 content blocks. Stringifying those verbatim sends
 * ~1.37 bytes of text per image byte over the websocket, into the replay buffer, and on into
 * the DOM, where nothing truncates it. Swap image blocks for a short placeholder instead.
 */

/** Rewrite image blocks to placeholders, then stringify. Non-image input is untouched. */
export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";

  let hasImage = false;
  const rewritten = content.map((block) => {
    if (!isImageBlock(block)) return block;
    hasImage = true;
    return { type: "text", text: imagePlaceholder(block) };
  });

  // Only rebuild when an image was actually present, so consumers that parse the block
  // array (e.g. the Agent/Task result renderer) see a byte-identical string otherwise.
  return JSON.stringify(hasImage ? rewritten : content) ?? "";
}

function isImageBlock(block: unknown): block is { source?: { data?: unknown } } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function imagePlaceholder(block: { source?: { data?: unknown } }): string {
  const data = block.source?.data;
  if (typeof data !== "string" || data.length === 0) return imagePlaceholderText();
  return imagePlaceholderText(base64ByteLength(data));
}

/**
 * The exact text that stands in for an image block.
 *
 * Anything that removes an image from a transcript must use this, so that
 * `resultHasImagePlaceholder` still recognises the result as having carried an image and the
 * chat card keeps hiding the textual output in favour of the rendered file.
 */
export function imagePlaceholderText(bytes?: number): string {
  return bytes == null ? "[image]" : `[image · ${formatBytes(bytes)}]`;
}

export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** A whole text block that is exactly a placeholder this module produced. */
const PLACEHOLDER_BLOCK = /^\[image(?: · [\d.]+(?:B|KB|MB))?\]$/;

/**
 * Whether a serialized tool result actually carried an image.
 *
 * A file extension cannot answer this: SVG comes back as text, and formats the API cannot
 * decode come back as text or as an error. Callers that hide textual output in favour of a
 * rendered image must key off the real result rather than the requested path.
 */
export function resultHasImagePlaceholder(output: string): boolean {
  if (!output.startsWith("[")) return false;
  let blocks: unknown;
  try {
    blocks = JSON.parse(output);
  } catch {
    return false;
  }
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => {
    const b = block as { type?: unknown; text?: unknown } | null;
    return b?.type === "text" && typeof b.text === "string" && PLACEHOLDER_BLOCK.test(b.text);
  });
}
