/**
 * `sessions:list_changed {projectName, renamed?}` on `/ws/global`: a project's chat list changed.
 *
 * `renamed` rides along when the change was a rename, carrying the chat and its new title, so every
 * open PPM can retitle that chat's open tabs at once. The list alone is not enough: a tab's title
 * lives in the tab, and a chat tab otherwise only learns its title when its own socket connects,
 * i.e. when someone clicks into it.
 */
export const SESSIONS_LIST_CHANGED_EVENT = "sessions:list_changed";

export interface RenamedChat {
  sessionId: string;
  title: string;
}

/** The `renamed` field of an event as it came off the wire, or null when it is absent or malformed. */
export function parseRenamedChat(raw: unknown): RenamedChat | null {
  if (!raw || typeof raw !== "object") return null;
  const { sessionId, title } = raw as Record<string, unknown>;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (typeof title !== "string" || !title.trim()) return null;
  return { sessionId, title };
}
