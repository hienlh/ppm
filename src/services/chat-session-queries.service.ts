import { chatService } from "./chat.service.ts";
import { providerRegistry } from "../providers/registry.ts";
import { getPinnedSessionIds, getSessionDesignSlugs } from "./db.service.ts";
import { getSessionTags } from "./tag.service.ts";
import { collapseTreesToHeads } from "./session-branch.service.ts";
import {
  search as chatSearchQuery,
  startBackfill as chatSearchStartBackfill,
  getIndexStatus as chatSearchGetIndexStatus,
  getKnownSessionCount as chatSearchKnownCount,
} from "./chat-search.service.ts";
import { compareSessionsByActivity, type ChatSearchResult, type ChatSearchResponse } from "../types/chat.ts";

/**
 * A project's chat list and chat search, as `GET /chat/sessions` and `GET /chat/search` answer
 * them, shared with the PPM Assistant's tools so both read the same thing.
 */

export interface ListProjectSessionsOptions {
  providerId?: string;
  /** Lowercased title filter; empty for none. */
  query?: string;
  tagId?: number | null;
  limit: number;
  offset: number;
}

/** One page of a project's sessions: pinned first, branch trees collapsed, enriched with pin/tag/design. */
export async function listProjectSessions(projectPath: string, opts: ListProjectSessionsOptions) {
  const { providerId, limit, offset } = opts;
  const searchQuery = opts.query ?? "";
  const filterTagId = opts.tagId ?? null;
  const sessions = await chatService.listSessions(providerId, projectPath, { limit, offset });
  const pinnedIds = getPinnedSessionIds();

  // On first page, fetch pinned sessions that may be outside the current page
  let pinnedSessions: typeof sessions = [];
  if (offset === 0 && pinnedIds.size > 0) {
    const pageIds = new Set(sessions.map((s) => s.id));
    const missingPinnedIds = [...pinnedIds].filter((id) => !pageIds.has(id));
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
  const enriched = deduped.map((s) => ({
    ...s, pinned: pinnedIds.has(s.id), tag: tagMap[s.id] ?? null, designSlug: designSlugs[s.id] ?? null,
  }));

  // Collapse edit-message branch trees: each tree shows a single row (its
  // most recently active node). Pinned sessions are never collapsed.
  const collapsed = collapseTreesToHeads(enriched);

  // Pinned first, then most recently active (not merely most recently created).
  collapsed.sort(compareSessionsByActivity);

  // Server-side search + tag filter
  let filtered = collapsed;
  if (searchQuery) filtered = filtered.filter((s) => (s.title || "").toLowerCase().includes(searchQuery));
  if (filterTagId !== null) filtered = filtered.filter((s) => s.tag?.id === filterTagId);
  const hasMore = sessions.length >= limit;
  return { sessions: filtered, hasMore };
}

/** Unified title + full-text content search over a project's chats. */
export async function searchProjectChats(projectPath: string, rawQuery: string, limit: number): Promise<ChatSearchResponse> {
  // An empty query has nothing to match, so it must not pay to enumerate: a
  // dir-scoped `listSessions` pages the SDK until exhausted, and all this
  // answer carries is the indexing chip's two numbers, which the index knows
  // by itself.
  if (!rawQuery) {
    const indexing = { total: chatSearchKnownCount(projectPath), ...chatSearchGetIndexStatus(projectPath) };
    return { results: [], indexing };
  }

  // Enumerate sessions once (also drives title matches + metadata for content hits).
  const sessions = await chatService.listSessions(undefined, projectPath);
  const indexing = { total: sessions.length, ...chatSearchGetIndexStatus(projectPath) };

  // Lazy self-refresh; UI shows an indexing indicator while this runs. The
  // sessions are handed over rather than enumerated again: a dir-scoped list
  // with no limit pages the SDK until exhausted, and this route was paying
  // for that twice on every search.
  chatSearchStartBackfill(projectPath, sessions);

  const pinnedIds = getPinnedSessionIds();
  const tagMap = getSessionTags(sessions.map((s) => s.id));
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const results: ChatSearchResult[] = [];
  const seen = new Set<string>();

  // Title matches first — a title hit is a stronger relevance signal than a
  // body hit, so collect these ahead of content to guarantee they survive the
  // limit (a flood of content hits must never starve out a title match).
  const q = rawQuery.toLowerCase();
  for (const s of sessions) {
    if (results.length >= limit) break;
    if (!(s.title || "").toLowerCase().includes(q)) continue;
    seen.add(s.id);
    results.push({
      sessionId: s.id,
      providerId: s.providerId,
      title: s.title ?? null,
      snippet: s.title ?? "",
      messageId: "",
      matchedIn: "title",
      ts: s.updatedAt || s.createdAt || "",
      pinned: pinnedIds.has(s.id),
      tag: tagMap[s.id] ?? null,
    });
  }

  // Content matches (best bm25 rank) for sessions not already surfaced by title.
  for (const hit of chatSearchQuery(projectPath, rawQuery, limit * 3)) {
    if (results.length >= limit) break;
    if (seen.has(hit.sessionId)) continue;
    seen.add(hit.sessionId);
    const s = byId.get(hit.sessionId);
    results.push({
      sessionId: hit.sessionId,
      providerId: s?.providerId,
      title: s?.title ?? null,
      snippet: hit.snippet,
      messageId: hit.messageId,
      matchedIn: "content",
      ts: s?.updatedAt || s?.createdAt || hit.ts || "",
      pinned: pinnedIds.has(hit.sessionId),
      tag: tagMap[hit.sessionId] ?? null,
    });
  }

  const designSlugs = getSessionDesignSlugs(results.map((r) => r.sessionId));
  for (const r of results) r.designSlug = designSlugs[r.sessionId] ?? null;

  // Pinned first, then title matches above content, then most-recent within group.
  results.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.matchedIn !== b.matchedIn) return a.matchedIn === "title" ? -1 : 1;
    return new Date(b.ts).getTime() - new Date(a.ts).getTime();
  });

  return { results, indexing };
}
