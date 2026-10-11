const START = "<ppm-shared-context>";
const END = "</ppm-shared-context>";

/** Transport metadata is not part of the user's message, even in native transcripts. */
export function withSharedContext(message: string, context?: string): string {
  return context ? `${START}\n${context.replaceAll(END, "[end context]")}\n${END}\n\n${message}` : message;
}

export function stripSharedContext(message: string): string {
  if (!message.startsWith(`${START}\n`)) return message;
  const end = message.indexOf(`${END}\n\n`);
  return end < 0 ? "" : message.slice(end + END.length + 2);
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
