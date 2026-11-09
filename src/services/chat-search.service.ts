/**
 * Full-text content search over chat transcripts, backed by the FTS5 store in
 * `search-index-db.service.ts`.
 *
 * Content lives in per-session JSONL transcripts (hundreds of MB across
 * thousands of sessions), so on-demand grep is too slow for interactive
 * snippet search. This service indexes normalized messages into FTS5 and
 * refreshes lazily (reconcile-on-search) using JSONL mtime as the staleness
 * signal — no hot-path write hook required.
 *
 * Each row carries the turn its message belongs to (`turn_id`, `turn_n`, from the session's turn
 * index) and its text in two columns (`chat-search-text.ts`), so the AI's search can name a turn
 * without ever matching what a tool printed.
 */
import { getSearchIndexDb } from "./search-index-db.service.ts";
import { chatService } from "./chat.service.ts";
import { messageSearchColumns } from "./chat-search-text.ts";
import { stampSessionTurns } from "./session-turns/stamp-message-turns.ts";
import type { ChatMessage } from "../types/chat.ts";

export { messageSearchColumns, messageSearchText } from "./chat-search-text.ts";

export interface ChatSearchHit {
  sessionId: string;
  messageId: string;
  role: string;
  ts: string;
  snippet: string;
}

/** What `session_meta` records about a session besides its freshness. */
export interface IndexedSessionInfo {
  providerId?: string;
  title?: string;
}

/**
 * Turn raw user input into a safe FTS5 MATCH expression.
 *
 * User text can contain FTS5 operators (AND/OR/NEAR, quotes, parens, `*`, `-`,
 * `:`) that would otherwise throw a syntax error. Strategy: split on
 * whitespace and wrap EVERY token as a quoted phrase (internal `"` doubled)
 * with a trailing prefix `*` — quoting neutralizes operator keywords and
 * special chars while `*` keeps partial-word matching. Tokens without any
 * letter/digit are dropped (an empty phrase is invalid). Tokens are ANDed
 * implicitly. Returns "" when nothing usable remains.
 */
export function toFtsQuery(raw: string): string {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const tok of tokens) {
    if (!/[\p{L}\p{N}]/u.test(tok)) continue; // no searchable char
    const escaped = tok.replace(/"/g, '""');
    parts.push(`"${escaped}"*`);
  }
  return parts.join(" ");
}

/**
 * Bump whenever what a row holds changes. Stored per session in
 * `session_meta.indexer_version`; `isStale` compares it, so a session indexed by
 * an older, thinner indexer is re-read rather than left stamped as fresh.
 *
 * 2: `MESSAGE_TEXT_CAP`. Sessions indexed at 1 may hold multi-megabyte rows.
 * 3: Exclude reply snapshots and their transport metadata.
 * 4: `search-index-v3.db`: prose and tool text in separate columns, turn ids, titles.
 * 5: A user record is prose only when it is a prompt; command output and notifications are tool text.
 *
 * A bump makes *every* session stale at once, which is what `RECONCILE_BUDGET`
 * below is for — the whole corpus must not be re-read inside one search.
 */
export const INDEXER_VERSION = 5;

/** Index a concrete set of normalized messages (core, provider-agnostic). */
export function indexMessages(
  sessionId: string,
  projectPath: string,
  messages: ChatMessage[],
  jsonlMtime = 0,
  info: IndexedSessionInfo = {},
): void {
  const db = getSearchIndexDb();
  const del = db.query("DELETE FROM messages_fts WHERE session_id = ?");
  const ins = db.query(
    `INSERT INTO messages_fts (text, tool_text, session_id, project_path, message_id, turn_id, turn_n, role, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertMeta = db.query(`
    INSERT INTO session_meta (session_id, project_path, provider_id, title, jsonl_mtime, indexed_at, msg_count, indexer_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_path    = excluded.project_path,
      provider_id     = excluded.provider_id,
      title           = excluded.title,
      jsonl_mtime     = excluded.jsonl_mtime,
      indexed_at      = excluded.indexed_at,
      msg_count       = excluded.msg_count,
      indexer_version = excluded.indexer_version
  `);

  const tx = db.transaction(() => {
    del.run(sessionId);
    let count = 0;
    for (const msg of messages) {
      const { text, toolText } = messageSearchColumns(msg);
      if (!text && !toolText) continue;
      ins.run(text, toolText, sessionId, projectPath, msg.id, msg.turnId ?? null, msg.turnN ?? null, msg.role, msg.timestamp ?? "");
      count++;
    }
    upsertMeta.run(sessionId, projectPath, info.providerId ?? "", info.title ?? "", jsonlMtime, Date.now(), count, INDEXER_VERSION);
  });
  tx();
}

/** Read a session's normalized messages via its provider, stamp their turns, then index them. */
export async function indexSession(
  providerId: string,
  sessionId: string,
  projectPath: string,
  jsonlMtime = 0,
  title?: string,
): Promise<void> {
  const messages = await chatService.getFullMessages(providerId, sessionId);
  // Never fails: a session with no turn index (another provider, a transcript this project does
  // not own) is indexed without turn ids.
  await stampSessionTurns({ providerId, sessionId, projectPath }, messages);
  indexMessages(sessionId, projectPath, messages, jsonlMtime, { providerId, title });
}

/**
 * Keeps a session's indexed title current: a rename does not touch the transcript, so it never
 * makes the session stale.
 */
export function refreshIndexedTitle(sessionId: string, title: string | undefined): void {
  if (title === undefined) return;
  getSearchIndexDb()
    .query("UPDATE session_meta SET title = ? WHERE session_id = ? AND title IS NOT ?")
    .run(title, sessionId, title);
}

/**
 * True when the stored index for a session is missing, older than the JSONL, or
 * was written by an earlier indexer. Without the version check, widening what
 * gets indexed would never reach the sessions already on disk: their
 * `jsonl_mtime` still matches, so they stay stamped as fresh forever.
 */
export function isStale(sessionId: string, jsonlMtime: number): boolean {
  const row = getSearchIndexDb()
    .query("SELECT jsonl_mtime, indexer_version FROM session_meta WHERE session_id = ?")
    .get(sessionId) as { jsonl_mtime: number; indexer_version: number } | null;
  if (!row) return true;
  if (row.indexer_version !== INDEXER_VERSION) return true;
  return row.jsonl_mtime !== jsonlMtime;
}

/** Remove all indexed rows + meta for a session. */
export function deleteSession(sessionId: string): void {
  const db = getSearchIndexDb();
  const tx = db.transaction(() => {
    db.query("DELETE FROM messages_fts WHERE session_id = ?").run(sessionId);
    db.query("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
  });
  tx();
}

/**
 * Ranked full-text search scoped to a project, for the chat's search box: matches prose and tool
 * text alike, and the snippet (with `<mark>`) comes from whichever column matched best.
 */
export function search(projectPath: string, rawQuery: string, limit = 50): ChatSearchHit[] {
  const match = toFtsQuery(rawQuery);
  if (!match) return [];
  const rows = getSearchIndexDb().query(`
    SELECT
      session_id AS sessionId,
      message_id AS messageId,
      role,
      ts,
      snippet(messages_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet
    FROM messages_fts
    WHERE messages_fts MATCH ? AND project_path = ?
    ORDER BY bm25(messages_fts)
    LIMIT ?
  `).all(match, projectPath, limit) as ChatSearchHit[];
  return rows;
}


/**
 * Sessions indexed for a project *by this version of the indexer*.
 *
 * The version matters because it is exactly when the number is read: an
 * `INDEXER_VERSION` bump makes every row stale at once, and counting them all
 * reported "1684/1684" while the corpus was being re-read from scratch — a
 * progress indicator sitting at 100% for the whole of the work it exists to
 * show. `isStale` already compares the same column.
 */
export function getIndexedCount(projectPath: string): number {
  const row = getSearchIndexDb()
    .query("SELECT COUNT(*) AS n FROM session_meta WHERE project_path = ? AND indexer_version = ?")
    .get(projectPath, INDEXER_VERSION) as { n: number };
  return row.n;
}

/**
 * How many sessions the last enumeration saw, per project.
 *
 * Keyed by the index it describes rather than held for the process: a wiped search
 * database — or a test's fresh one — must not inherit a total counted against rows
 * that no longer exist.
 */
const enumerated = new WeakMap<object, Map<string, number>>();
function enumeratedTotals(): Map<string, number> {
  const db = getSearchIndexDb();
  let totals = enumerated.get(db);
  if (!totals) enumerated.set(db, (totals = new Map()));
  return totals;
}

/**
 * The indexing chip's denominator when nobody has enumerated.
 *
 * `GET /chat/search` knows the real total only because it lists the sessions to
 * match titles against. An empty query has no titles to match, so it should not
 * pay for a list that pages the SDK to exhaustion.
 *
 * Rows alone are not that number, though, and they are wrong in the direction
 * that matters. On a fresh index a pass reads `RECONCILE_BUDGET` sessions and
 * leaves the rest with no row at all, so the rows say 200 of 200 — finished —
 * while the other 1484 were never read. So this is the larger of what the index
 * holds and what the last enumeration saw. The error that remains runs the safe
 * way: a session deleted since that enumeration still counts until the next
 * query lists them again, which reads as "not quite done" rather than "done". And
 * a restart forgets the enumeration, so between one and the next real query the
 * rows are all there is.
 */
export function getKnownSessionCount(projectPath: string): number {
  const row = getSearchIndexDb()
    .query("SELECT COUNT(*) AS n FROM session_meta WHERE project_path = ?")
    .get(projectPath) as { n: number };
  return Math.max(row.n, enumeratedTotals().get(projectPath) ?? 0);
}

// --- Reconcile & backfill --------------------------------------------------
// Content is kept fresh lazily (reconcile-on-search) rather than via a write
// hook in the hot chat path. `updatedAt` (the JSONL file mtime, per provider)
// is the staleness signal, so no transcript-directory path resolution is
// needed here — fully provider-agnostic.

function staleKey(updatedAt?: string, createdAt?: string): number {
  const src = updatedAt || createdAt;
  const t = src ? Date.parse(src) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Sessions one pass will re-read, at most.
 *
 * Steady state is a handful — whatever was touched since the last search. The
 * case this exists for is an `INDEXER_VERSION` bump, which makes every session
 * stale at once: the first search after an upgrade would otherwise re-read and
 * re-parse the entire corpus (hundreds of MB over thousands of transcripts)
 * before the indexing indicator could ever finish. Bounding the pass turns that
 * into progress the user watches advance, because `startBackfill` runs again on
 * the next search and the ones left stale are still stale.
 */
const RECONCILE_BUDGET = 200;

/** A session as `reconcile` needs it: who owns it, when it changed, and what it is called. */
export interface ReconcileSession {
  id: string;
  providerId: string;
  updatedAt?: string;
  createdAt?: string;
  title?: string;
}

/**
 * Re-index any session whose transcript changed since last index. Enumerates
 * all providers for the project via `chatService.listSessions`. Sequential to
 * avoid an FS/parse storm over large transcript corpora.
 *
 * `sessions` may be supplied by a caller that has already enumerated them.
 * `GET /chat/search` has: without this it listed every session in the project
 * twice per keystroke, once for title matching and once in here, and a
 * dir-scoped list with no limit pages the SDK until it is exhausted.
 */
export async function reconcile(
  projectPath: string,
  onProgress?: (done: number, total: number) => void,
  sessions?: ReconcileSession[],
): Promise<{ total: number; indexed: number; remaining: number }> {
  const list = sessions ?? (await chatService.listSessions(undefined, projectPath));
  enumeratedTotals().set(projectPath, list.length);
  let reindexed = 0;
  let remaining = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    const mtime = staleKey(s.updatedAt, s.createdAt);
    if (!isStale(s.id, mtime)) {
      refreshIndexedTitle(s.id, s.title);
    } else {
      if (reindexed >= RECONCILE_BUDGET) {
        remaining++;
      } else {
        try {
          await indexSession(s.providerId, s.id, projectPath, mtime, s.title);
          reindexed++;
        } catch { /* skip unreadable/broken transcript */ }
      }
    }
    onProgress?.(i + 1, list.length);
  }
  return { total: list.length, indexed: reindexed, remaining };
}

// Module-level dedup guard — one backfill per project at a time (no lifecycle
// wrapper class needed).
const backfillRuns = new Map<string, Promise<unknown>>();

/** Trigger a lazy backfill/reconcile for a project (idempotent, fire-and-forget safe). */
export function startBackfill(
  projectPath: string,
  sessions?: ReconcileSession[],
): Promise<unknown> {
  const existing = backfillRuns.get(projectPath);
  if (existing) return existing;
  const run = reconcile(projectPath, undefined, sessions)
    .finally(() => backfillRuns.delete(projectPath));
  backfillRuns.set(projectPath, run);
  return run;
}

export function isBackfillRunning(projectPath: string): boolean {
  return backfillRuns.has(projectPath);
}

export interface IndexStatus {
  indexed: number;
  running: boolean;
}

/** Cheap synchronous status for the UI (total filled by the route). */
export function getIndexStatus(projectPath: string): IndexStatus {
  return { indexed: getIndexedCount(projectPath), running: isBackfillRunning(projectPath) };
}
