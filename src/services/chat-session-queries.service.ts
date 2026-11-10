import { chatService } from "./chat.service.ts";
import { providerRegistry } from "../providers/registry.ts";
import { getPinnedSessionIds, getSessionDesignSlugs } from "./db.service.ts";
import { getSessionTags } from "./tag.service.ts";
import { collapseTreesToHeads } from "./session-branch.service.ts";
import { sessionSpawnLinks } from "./session-collab/session-list-links.ts";
import { compareSessionsByActivity } from "../types/chat.ts";
import { managerChats } from "./assistant-managers/manager-chats.service.ts";
import { MANAGER_PROVIDER_ID } from "../shared/assistant-managers.ts";

/**
 * A project's chat list and chat search, as `GET /chat/sessions` and `GET /chat/search` answer
 * them, shared with the PPM Assistant's tools so both read the same thing. The search itself
 * lives with the rest of the session search (`session-turns/session-search.ts`).
 */
export { searchProjectChats } from "./session-turns/session-search.ts";

export interface ListProjectSessionsOptions {
  providerId?: string;
  /** Lowercased title filter; empty for none. */
  query?: string;
  tagId?: number | null;
  limit: number;
  offset: number;
}

/**
 * One page of a project's sessions: pinned first, branch trees collapsed, enriched with
 * pin/tag/design and, for a session another session created, which one (`spawnedBy`, `parentTitle`).
 */
export async function listProjectSessions(projectPath: string, opts: ListProjectSessionsOptions) {
  const { providerId, limit, offset } = opts;
  const searchQuery = opts.query ?? "";
  const filterTagId = opts.tagId ?? null;
  const sessions = await chatService.listSessions(providerId, projectPath, { limit, offset });
  const pinnedIds = getPinnedSessionIds();
  // The project's manager chat is listed first on page 1 like a pinned one, wherever its activity
  // would put it. It runs on Claude, so a list of another provider's sessions leaves it out.
  const managerId = !providerId || providerId === MANAGER_PROVIDER_ID ? managerChats.managerFor(projectPath)?.sessionId ?? null : null;
  const lookupIds = managerId ? new Set([managerId, ...pinnedIds]) : pinnedIds;

  // On first page, fetch pinned sessions that may be outside the current page
  let pinnedSessions: typeof sessions = [];
  if (offset === 0 && lookupIds.size > 0) {
    const pageIds = new Set(sessions.map((s) => s.id));
    const missingPinnedIds = [...lookupIds].filter((id) => !pageIds.has(id));
    if (missingPinnedIds.length > 0) {
      // Fetch individual pinned sessions by ID via SDK
      const claudeProvider = providerRegistry.get("claude") as any;
      if (claudeProvider?.getSessionInfoById) {
        const results = await Promise.all(
          missingPinnedIds.map((id) => claudeProvider.getSessionInfoById(id, projectPath)),
        );
        pinnedSessions = results.filter((s: any): s is NonNullable<typeof s> => s != null);
      }
    }
  }

  // Merge and enrich with pin status
  const merged = [...pinnedSessions, ...sessions];
  const seen = new Set<string>();
  const deduped = merged.filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
  const tagMap = getSessionTags(deduped.map((s) => s.id));
  const designSlugs = getSessionDesignSlugs(deduped.map((s) => s.id));
  const spawnLinks = sessionSpawnLinks(deduped.map((s) => s.id));
  // A creator with no title of PPM's own is still named when it is on this page.
  const pageTitles = new Map(deduped.map((s) => [s.id, s.title]));
  const enriched = deduped.map((s) => ({
    ...s, pinned: pinnedIds.has(s.id), ...(s.id === managerId ? { manager: true as const } : {}),
    tag: tagMap[s.id] ?? null, designSlug: designSlugs[s.id] ?? null,
    spawnedBy: spawnLinks[s.id]?.spawnedBy ?? null,
    parentTitle: spawnLinks[s.id] ? spawnLinks[s.id]!.parentTitle ?? pageTitles.get(spawnLinks[s.id]!.spawnedBy) ?? null : null,
  }));

  // Collapse edit-message branch trees: each tree shows a single row (its
  // most recently active node). Pinned sessions and the manager chat are never collapsed.
  const collapsed = collapseTreesToHeads(enriched);

  // Manager, then pinned, then most recently active (not merely most recently created).
  collapsed.sort(compareSessionsByActivity);

  // Server-side search + tag filter
  let filtered = collapsed;
  if (searchQuery) filtered = filtered.filter((s) => (s.title || "").toLowerCase().includes(searchQuery));
  if (filterTagId !== null) filtered = filtered.filter((s) => s.tag?.id === filterTagId);
  const hasMore = sessions.length >= limit;
  return { sessions: filtered, hasMore };
}
