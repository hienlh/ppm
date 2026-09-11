/**
 * Full-text content search over chat transcripts, backed by the FTS5 store in
 * `search-index-db.service.ts`.
 *
 * Content lives in per-session JSONL transcripts (hundreds of MB across
 * thousands of sessions), so on-demand grep is too slow for interactive
 * snippet search. This service indexes normalized messages into FTS5 and
 * refreshes lazily (reconcile-on-search) using JSONL mtime as the staleness
 * signal — no hot-path write hook required.
 */
import { getSearchIndexDb } from "./search-index-db.service.ts";
import { chatService } from "./chat.service.ts";
import type { ChatEvent, ChatMessage } from "../types/chat.ts";

export interface ChatSearchHit {
  sessionId: string;
  messageId: string;
  role: string;
  ts: string;
  snippet: string;
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
 * Bump whenever `messageSearchText` changes what it emits. Stored per session in
 * `session_meta.indexer_version`; `isStale` compares it, so a session indexed by
 * an older, thinner indexer is re-read rather than left stamped as fresh.
 */
export const INDEXER_VERSION = 1;

/** Per-event cap on indexed tool output. A single `Read`/`grep` result can be
 *  hundreds of KB; indexing all of it bloats the FTS store far more than it
 *  helps, since matches that deep are rarely what someone is looking for. */
const EVENT_TEXT_CAP = 4000;

function stringifyToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, EVENT_TEXT_CAP);
  try {
    return JSON.stringify(input).slice(0, EVENT_TEXT_CAP);
  } catch {
    return "";
  }
}

function collectEventText(events: ChatEvent[] | undefined, out: string[]): void {
  if (!events) return;
  for (const ev of events) {
    switch (ev.type) {
      case "text":
        out.push(ev.content);
        break;
      case "tool_use":
        // The tool name and its arguments are what a search for "the commit
        // where I opened PR 10232" actually has to match.
        out.push(ev.tool, stringifyToolInput(ev.input));
        collectEventText(ev.children, out);
        break;
      case "tool_result":
        out.push(ev.output.slice(0, EVENT_TEXT_CAP));
        break;
      case "error":
        out.push(ev.message);
        break;
      // `thinking` is deliberately skipped: it is the model's scratch work, it
      // is bulky, and a snippet drawn from it reads as noise in the results.
      default:
        break;
    }
  }
}

/**
 * All searchable text for one normalized message.
 *
 * `content` alone misses most of a transcript: `getMessages` merges tool calls
 * and their results into `events` and leaves `content` empty for any turn that
 * only used tools — the commit-and-open-a-PR turns are exactly those, so they
 * were the least searchable part of the history rather than the most.
 */
export function messageSearchText(msg: ChatMessage): string {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  collectEventText(msg.events, parts);
  return parts.filter((p) => p && p.trim()).join("\n").trim();
}

/** Index a concrete set of normalized messages (core, provider-agnostic). */
export function indexMessages(
  sessionId: string,
  projectPath: string,
  messages: ChatMessage[],
  jsonlMtime = 0,
): void {
  const db = getSearchIndexDb();
  const del = db.query("DELETE FROM messages_fts WHERE session_id = ?");
  const ins = db.query(
    "INSERT INTO messages_fts (text, session_id, project_path, message_id, role, ts) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const upsertMeta = db.query(`
    INSERT INTO session_meta (session_id, project_path, jsonl_mtime, indexed_at, msg_count, indexer_version)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_path    = excluded.project_path,
      jsonl_mtime     = excluded.jsonl_mtime,
      indexed_at      = excluded.indexed_at,
      msg_count       = excluded.msg_count,
      indexer_version = excluded.indexer_version
  `);

  const tx = db.transaction(() => {
    del.run(sessionId);
    let count = 0;
    for (const msg of messages) {
      const text = messageSearchText(msg);
      if (!text) continue;
      ins.run(text, sessionId, projectPath, msg.id, msg.role, msg.timestamp ?? "");
      count++;
    }
    upsertMeta.run(sessionId, projectPath, jsonlMtime, Date.now(), count, INDEXER_VERSION);
  });
  tx();
}

/** Read a session's normalized messages via its provider, then index them. */
export async function indexSession(
  providerId: string,
  sessionId: string,
  projectPath: string,
  jsonlMtime = 0,
): Promise<void> {
  const messages = await chatService.getMessages(providerId, sessionId);
  indexMessages(sessionId, projectPath, messages, jsonlMtime);
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

/** Ranked full-text search scoped to a project. Returns best hit per row. */
export function search(projectPath: string, rawQuery: string, limit = 50): ChatSearchHit[] {
  const match = toFtsQuery(rawQuery);
  if (!match) return [];
  const rows = getSearchIndexDb().query(`
    SELECT
      session_id AS sessionId,
      message_id AS messageId,
      role,
      ts,
      snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet
    FROM messages_fts
    WHERE messages_fts MATCH ? AND project_path = ?
    ORDER BY bm25(messages_fts)
    LIMIT ?
  `).all(match, projectPath, limit) as ChatSearchHit[];
  return rows;
}

/** Count of sessions indexed for a project. */
export function getIndexedCount(projectPath: string): number {
  const row = getSearchIndexDb()
    .query("SELECT COUNT(*) AS n FROM session_meta WHERE project_path = ?")
    .get(projectPath) as { n: number };
  return row.n;
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
 * Re-index any session whose transcript changed since last index. Enumerates
 * all providers for the project via `chatService.listSessions`. Sequential to
 * avoid an FS/parse storm over large transcript corpora.
 */
export async function reconcile(
  projectPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ total: number; indexed: number }> {
  const sessions = await chatService.listSessions(undefined, projectPath);
  let reindexed = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const mtime = staleKey(s.updatedAt, s.createdAt);
    if (isStale(s.id, mtime)) {
      try {
        await indexSession(s.providerId, s.id, projectPath, mtime);
        reindexed++;
      } catch { /* skip unreadable/broken transcript */ }
    }
    onProgress?.(i + 1, sessions.length);
  }
  return { total: sessions.length, indexed: reindexed };
}

// Module-level dedup guard — one backfill per project at a time (no lifecycle
// wrapper class needed).
const backfillRuns = new Map<string, Promise<unknown>>();

/** Trigger a lazy backfill/reconcile for a project (idempotent, fire-and-forget safe). */
export function startBackfill(projectPath: string): Promise<unknown> {
  const existing = backfillRuns.get(projectPath);
  if (existing) return existing;
  const run = reconcile(projectPath).finally(() => backfillRuns.delete(projectPath));
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
