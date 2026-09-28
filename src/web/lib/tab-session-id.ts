/**
 * The chat session a tab is showing, for every tab type that hosts one.
 *
 * A design tab embeds a chat session exactly as a chat tab does, so anything that asks
 * "which tab is this session in?" — focusing an already-open session, unread badges, the
 * streaming dots, notification clearing — has to ask this instead of testing
 * `type === "chat"`. A check written against `chat` alone makes a design session look
 * unopened, and re-opening it then starts a plain chat tab outside design mode.
 */
const SESSION_TAB_TYPES: ReadonlySet<string> = new Set(["chat", "design"]);

export function tabSessionId(tab: { type: string; metadata?: Record<string, unknown> } | null | undefined): string | undefined {
  if (!tab || !SESSION_TAB_TYPES.has(tab.type)) return undefined;
  const id = tab.metadata?.sessionId;
  return typeof id === "string" && id ? id : undefined;
}
