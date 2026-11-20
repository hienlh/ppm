/**
 * When a chat counts as archived, and the history list's status filter. Shared so the list, its
 * counts and any test read the same rule (`src/services/session-archive.service.ts` stores it).
 */

export type SessionArchiveState = "archived" | "kept";
/** What the history list shows: everything not archived (default), one status, or all. */
export type SessionStatusFilter = "active" | "running" | "unread" | "archived" | "all";
export const SESSION_STATUS_FILTERS: readonly SessionStatusFilter[] = ["active", "running", "unread", "archived", "all"];
export const SESSION_STATUS_LABELS: Record<SessionStatusFilter, string> = {
  active: "Active", running: "Running", unread: "Unread", archived: "Archived", all: "All",
};

interface ArchivableSession {
  createdAt: string;
  updatedAt?: string;
  pinned?: boolean;
  manager?: true;
  archive?: SessionArchiveState | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Archived by hand, or idle at least `autoDays` days (0 = never) — unless it is pinned, the
 * project's manager chat, or was un-archived by hand (`kept`).
 */
export function isSessionArchived(s: ArchivableSession, autoDays: number, now = Date.now()): boolean {
  if (s.archive === "archived") return true;
  if (s.archive === "kept" || s.pinned || s.manager || !(autoDays > 0)) return false;
  const at = Date.parse(s.updatedAt ?? s.createdAt);
  return Number.isFinite(at) && now - at >= autoDays * DAY_MS;
}

/** Whether a session belongs under `filter`, given what the browser knows about it. */
export function matchesStatusFilter(
  filter: SessionStatusFilter,
  s: ArchivableSession & { id: string },
  ctx: { autoDays: number; running: (id: string) => boolean; unread: (id: string) => boolean; now?: number },
): boolean {
  const archived = isSessionArchived(s, ctx.autoDays, ctx.now);
  switch (filter) {
    case "all": return true;
    case "archived": return archived;
    case "running": return ctx.running(s.id);
    case "unread": return ctx.unread(s.id);
    case "active": return !archived || ctx.running(s.id) || ctx.unread(s.id);
  }
}
