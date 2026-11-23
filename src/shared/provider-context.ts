const START = "<ppm-shared-context>";
const END = "</ppm-shared-context>";

/** Transport metadata is not part of the user's message, even in native transcripts. */
export function withSharedContext(message: string, context?: string): string {
  return context ? `${START}\n${context.replaceAll(END, "[end context]")}\n${END}\n\n${message}` : message;
}

/**
 * `message` with `extra` added inside its shared-context block (or in a new one), so it is
 * stripped from history, titles and search like the rest of the block. Wrapping an already
 * wrapped message instead would leave the second block in the visible text.
 */
export function withAddedSharedContext(message: string, extra: string): string {
  const close = `\n${END}\n\n`;
  const end = message.startsWith(`${START}\n`) ? message.indexOf(close) : -1;
  if (end < 0) return withSharedContext(message, extra);
  return `${message.slice(0, end)}\n\n${extra.replaceAll(END, "[end context]")}${message.slice(end)}`;
}

export function stripSharedContext(message: string): string {
  if (!message.startsWith(`${START}\n`)) return message;
  const end = message.indexOf(`${END}\n\n`);
  return end < 0 ? "" : message.slice(end + END.length + 2);
}

/**
 * A session title with the shared-context block taken off, for titles a provider made from the
 * prompt it was sent: there the block may be cut short or flattened onto one line, which
 * `stripSharedContext` does not recognise. Empty when nothing but the block was there.
 */
export function sessionTitleWithoutContext(title: string): string {
  const text = title.trimStart();
  if (!text.startsWith(START)) return title;
  const end = text.indexOf(END);
  return end < 0 ? "" : text.slice(end + END.length).trim();
}

/**
 * One `<ppm-shared-context>` block from several entries — the project's shared instructions,
 * the PPM Assistant's picture of the screen — so every place that strips the block from
 * history, titles and search strips all of them. Undefined when there is nothing to send.
 */
export function joinSharedContextEntries(...entries: Array<string | undefined>): string | undefined {
  const present = entries.filter((entry): entry is string => !!entry && !!entry.trim());
  return present.length ? present.join("\n\n") : undefined;
}
