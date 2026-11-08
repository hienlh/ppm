/**
 * Search over a project's chats, in the two forms PPM needs it.
 *
 * - The chat's search box (`searchProjectChats`, behind `GET /chat/search`): lists the project's
 *   sessions once, matches titles against them, then content in both FTS columns, with `<mark>`
 *   snippets, and keeps the index fresh by starting a lazy backfill.
 * - The AI's `search_sessions` (`searchSessionTurnText`, `searchSessionTitles`): reads only what
 *   the index already holds — no listing of sessions, no backfill — matches and quotes the `text`
 *   column alone, so nothing a tool printed can come back, and names the turn of each hit.
 */
import { chatService } from "../chat.service.ts";
import {
  getIndexStatus, getIndexedCount, getKnownSessionCount, search as searchContent, startBackfill, toFtsQuery,
} from "../chat-search.service.ts";
import { getSearchIndexDb } from "../search-index-db.service.ts";
import { getPinnedSessionIds, getSessionDesignSlugs } from "../db.service.ts";
import { getSessionTags } from "../tag.service.ts";
import type { ChatSearchResponse, ChatSearchResult } from "../../types/chat.ts";

/** Title + full-text content search for the chat's search box; the response shape is the UI's. */
export async function searchProjectChats(projectPath: string, rawQuery: string, limit: number): Promise<ChatSearchResponse> {
  // An empty query has nothing to match, so it must not pay to enumerate: a dir-scoped
  // `listSessions` pages the SDK until exhausted, and all this answer carries is the indexing
  // chip's two numbers, which the index knows by itself.
  if (!rawQuery) {
    return { results: [], indexing: { total: getKnownSessionCount(projectPath), ...getIndexStatus(projectPath) } };
  }

  // Enumerate sessions once (also drives title matches + metadata for content hits).
  const sessions = await chatService.listSessions(undefined, projectPath);
  const indexing = { total: sessions.length, ...getIndexStatus(projectPath) };

  // Lazy self-refresh; the UI shows an indexing indicator while this runs. The sessions are
  // handed over rather than enumerated again: a dir-scoped list with no limit pages the SDK until
  // exhausted, and this was paying for that twice on every search.
  startBackfill(projectPath, sessions).catch(() => { /* reconcile skips what it cannot read */ });

  const pinnedIds = getPinnedSessionIds();
  const tagMap = getSessionTags(sessions.map((s) => s.id));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const results: ChatSearchResult[] = [];
  const seen = new Set<string>();

  // Title matches first — a title hit is a stronger relevance signal than a body hit, so collect
  // these ahead of content to guarantee they survive the limit.
  const q = rawQuery.toLowerCase();
  for (const s of sessions) {
    if (results.length >= limit) break;
    if (!(s.title || "").toLowerCase().includes(q)) continue;
    seen.add(s.id);
    results.push({
      sessionId: s.id, providerId: s.providerId, title: s.title ?? null, snippet: s.title ?? "", messageId: "",
      matchedIn: "title", ts: s.updatedAt || s.createdAt || "", pinned: pinnedIds.has(s.id), tag: tagMap[s.id] ?? null,
    });
  }

  // Content matches (best bm25 rank) for sessions not already surfaced by title.
  for (const hit of searchContent(projectPath, rawQuery, limit * 3)) {
    if (results.length >= limit) break;
    if (seen.has(hit.sessionId)) continue;
    seen.add(hit.sessionId);
    const s = byId.get(hit.sessionId);
    results.push({
      sessionId: hit.sessionId, providerId: s?.providerId, title: s?.title ?? null, snippet: hit.snippet,
      messageId: hit.messageId, matchedIn: "content", ts: s?.updatedAt || s?.createdAt || hit.ts || "",
      pinned: pinnedIds.has(hit.sessionId), tag: tagMap[hit.sessionId] ?? null,
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

/** A content hit for the AI: plain text, from what a person typed or an assistant answered. */
export interface SessionTurnTextHit {
  sessionId: string;
  providerId: string;
  title: string;
  /** Null when the message was indexed before its turn could be named. */
  turnId: string | null;
  turnN: number | null;
  role: string;
  ts: string;
  snippet: string;
}

export interface SessionTitleHit {
  sessionId: string;
  providerId: string;
  title: string;
}

/** Most hits of either kind one AI search returns. */
export const MAX_AI_SEARCH_HITS = 20;
/** Rows read per hit asked for, so several matches in one turn still leave enough turns. */
const ROWS_PER_HIT = 5;

/** The best content hit of each turn, matched in the `text` column only, quoted as plain text. */
export function searchSessionTurnText(projectPath: string, rawQuery: string, limit: number): SessionTurnTextHit[] {
  const match = toFtsQuery(rawQuery);
  const max = Math.max(1, Math.min(limit, MAX_AI_SEARCH_HITS));
  if (!match) return [];
  const rows = getSearchIndexDb().query(`
    SELECT
      messages_fts.session_id AS sessionId,
      COALESCE(meta.provider_id, '') AS providerId,
      COALESCE(meta.title, '') AS title,
      messages_fts.turn_id AS turnId,
      messages_fts.turn_n AS turnN,
      messages_fts.role AS role,
      messages_fts.ts AS ts,
      snippet(messages_fts, 0, '', '', '…', 16) AS snippet
    FROM messages_fts
    LEFT JOIN session_meta AS meta ON meta.session_id = messages_fts.session_id
    WHERE messages_fts MATCH ? AND messages_fts.project_path = ?
    ORDER BY bm25(messages_fts)
    LIMIT ?
  `).all(`{text} : (${match})`, projectPath, max * ROWS_PER_HIT) as SessionTurnTextHit[];
  const out: SessionTurnTextHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.sessionId}\0${row.turnId ?? `?${row.ts}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, turnN: row.turnN === null ? null : Number(row.turnN) });
    if (out.length >= max) break;
  }
  return out;
}

/** Sessions of the project whose indexed title holds the whole query, newest indexed first. */
export function searchSessionTitles(projectPath: string, rawQuery: string, limit: number): SessionTitleHit[] {
  const q = rawQuery.trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return getSearchIndexDb().query(`
    SELECT session_id AS sessionId, provider_id AS providerId, title
    FROM session_meta
    WHERE project_path = ? AND title != '' AND title LIKE ? ESCAPE '\\'
    ORDER BY indexed_at DESC
    LIMIT ?
  `).all(projectPath, pattern, Math.max(1, Math.min(limit, MAX_AI_SEARCH_HITS))) as SessionTitleHit[];
}

/** How far the index has got for a project, from its own counters — nothing is listed. */
export function searchIndexProgress(projectPath: string): { indexed: number; total: number } {
  return { indexed: getIndexedCount(projectPath), total: getKnownSessionCount(projectPath) };
}
