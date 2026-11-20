/**
 * The chat tabs closed on this device, newest last, for "Reopen Closed Chat" (Alt+Shift+T — the
 * browser keeps Ctrl+Shift+T for its own tabs). Only a chat that has a session can come back;
 * a draft tab has nothing to reopen. In memory: a reload starts with none, as a browser's own does.
 * No imports on purpose: `panel-store` records here, and opening a chat goes back through it.
 * Only `type: "chat"` tabs: a design or Assistant tab holds a session too, and reopening one as a
 * plain chat would take it out of its mode (see `tab-session-id.ts`).
 */

export interface ClosedChat {
  projectName: string;
  sessionId: string;
  providerId: string;
  title?: string;
}

const MAX_CLOSED = 20;
const closed: ClosedChat[] = [];

/** Called with every tab that closes; anything but a chat with a session is ignored. */
export function rememberClosedTab(tab: { type: string; title?: string; metadata?: Record<string, unknown> } | undefined): void {
  if (tab?.type !== "chat") return;
  const m = tab.metadata ?? {};
  const sessionId = typeof m.sessionId === "string" ? m.sessionId : "";
  const projectName = typeof m.projectName === "string" ? m.projectName : "";
  if (!sessionId || !projectName) return;
  const at = closed.findIndex((c) => c.sessionId === sessionId);
  if (at >= 0) closed.splice(at, 1);
  closed.push({
    projectName,
    sessionId,
    providerId: typeof m.providerId === "string" ? m.providerId : "claude",
    ...(tab.title ? { title: tab.title } : {}),
  });
  if (closed.length > MAX_CLOSED) closed.shift();
}

/** The chat closed last, taken off the list; null when none is left. */
export function takeLastClosedChat(): ClosedChat | null {
  return closed.pop() ?? null;
}
