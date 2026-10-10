import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { chatService } from "./chat.service.ts";
import { getSessionProjectPath, resolveMigratedSession } from "./db.service.ts";
import { resolveSessionDir } from "./subagent-transcript-merger.ts";
import { getRootId, resolveVersionMap } from "./session-branch.service.ts";
import { pageHistory, type HistoryPageQuery } from "../server/routes/chat-history-page.ts";
import type { ChatMessage } from "../types/chat.ts";

/**
 * Reading a session's history one page at a time, as `GET /chat/sessions/:id/messages` answers
 * it, shared with the PPM Assistant's tools so both read the same thing.
 */

/**
 * The parsed history of recently read sessions, reused for as long as the transcript on disk
 * is the one it was parsed from.
 *
 * Re-reading a transcript is not only slow, it LEAKS on Windows: Bun keeps the memory of a
 * large read committed after the strings are collected (measured on a 30 MB transcript:
 * `Bun.file().text()` alone +12 MB a call, a full history read +40 MB, never returned —
 * mimalloc's purge options change nothing). Every tab open, older page and post-turn refetch
 * re-parsed, so a day of long chats took the server to 14 GB RSS / 59 GB committed and Bun
 * aborted. Keyed by what the parse reads — the transcript's size and mtime, its subagent
 * transcripts, and the fork root's, whose timestamps are overlaid — a session is now parsed
 * once per change instead of once per ask.
 *
 * An older page (`before`) does not need the newest parse: between turns the list only grows
 * at its end (the paging indexes rely on that), so it reuses the first page's parse for a short
 * while whatever the stamp says — otherwise every page scrolled up mid-turn, while the file
 * changes every few seconds, would be a whole parse. Only Claude transcripts are stamped;
 * anything else is otherwise parsed per request as before.
 */
const HISTORY_CACHE_MAX = 6;
const OLDER_PAGE_TTL_MS = 5 * 60_000;
const historyCache = new Map<string, { stamp: string | null; messages: ChatMessage[]; at: number }>();

function rememberHistory(key: string, stamp: string | null, messages: ChatMessage[]): void {
  historyCache.delete(key);
  historyCache.set(key, { stamp, messages, at: Date.now() });
  while (historyCache.size > HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value!);
}

function cachedHistory(key: string, stamp: string | null, olderPage: boolean): ChatMessage[] | null {
  const hit = historyCache.get(key);
  if (!hit) return null;
  if (stamp !== null && hit.stamp === stamp) {
    // Most recently used last, so the cap drops the session read longest ago.
    historyCache.delete(key);
    historyCache.set(key, hit);
    return hit.messages;
  }
  if (olderPage && Date.now() - hit.at <= OLDER_PAGE_TTL_MS) return hit.messages;
  return null;
}

/**
 * What a Claude session's parse reads on disk: its transcript, and the subagent transcripts
 * under `<id>/subagents/` that fill its Agent cards — those keep growing while the main file
 * sits waiting on an agent (one wrote 545 records through 57 minutes of main-file silence),
 * so stamping the main file alone froze a card on reload. Null when there is no transcript.
 */
function claudeTranscriptStamp(sessionId: string): string | null {
  const dir = resolveSessionDir(sessionId, getSessionProjectPath(sessionId));
  if (!dir) return null;
  try {
    const s = statSync(`${dir}.jsonl`);
    let n = 0, bytes = 0, newest = 0;
    try {
      for (const f of readdirSync(join(dir, "subagents"))) {
        const a = statSync(join(dir, "subagents", f));
        n++; bytes += a.size; newest = Math.max(newest, a.mtimeMs);
      }
    } catch { /* no subagents/ yet */ }
    return `${s.size}:${s.mtimeMs}:${n}:${bytes}:${newest}`;
  } catch {
    return null;
  }
}

/** What the parsed history depends on on disk; null when that cannot be told. */
function historyStamp(providerId: string, id: string): string | null {
  if (providerId !== "claude") return null;
  const own = claudeTranscriptStamp(id);
  if (!own) return null;
  const rootId = getRootId(id);
  if (!rootId || rootId === id) return own;
  const root = claudeTranscriptStamp(rootId);
  return root ? `${own}|${root}` : null;
}

/**
 * Parses of a session's history that are running now, so a request arriving mid-parse waits
 * for that one instead of starting another. A client cannot cancel a parse — aborting the
 * fetch leaves it running here — and a tab that re-asked every few seconds while a 30 MB
 * transcript took 30 s to parse had a dozen of them going at once (368 requests in half an
 * hour, measured), which is what took the server to 23 GB committed. Shared only while in
 * flight: a request after it settles parses afresh, so a finished turn is never served stale.
 */
const historyInFlight = new Map<string, Promise<ChatMessage[]>>();

function loadFullHistory(providerId: string, id: string): Promise<ChatMessage[]> {
  const key = `${providerId}\0${id}`;
  const running = historyInFlight.get(key);
  if (running) return running;
  const parse = parseFullHistory(providerId, id).finally(() => historyInFlight.delete(key));
  historyInFlight.set(key, parse);
  return parse;
}

async function parseFullHistory(providerId: string, id: string): Promise<ChatMessage[]> {
  const messages = await chatService.getMessages(providerId, id);
  // Forking re-timestamps the copied prefix (both the Claude SDK and codex
  // stamp the fork moment), so a version's inherited history would render as
  // "just now" and shift when switching versions. Overlay the branch root's
  // real timestamps across the identical prefix, stopping at the divergent
  // (edited) message beyond which the messages are genuinely new to this fork.
  const rootId = getRootId(id);
  if (rootId && rootId !== id) {
    const rootMsgs = await chatService.getMessages(providerId, rootId).catch(() => [] as typeof messages);
    for (let i = 0; i < messages.length && i < rootMsgs.length; i++) {
      const r = rootMsgs[i], m = messages[i];
      if (!r || !m || r.role !== m.role || r.content !== m.content) break;
      m.timestamp = r.timestamp;
    }
  }
  return messages;
}

/**
 * One page of a session's history. A provider that mints its own session id leaves the id PPM
 * created behind, owning no transcript: the recorded move is followed so a caller that still
 * holds the old id reads the conversation instead of an empty list, and the answer names the
 * id that owns it (`canonicalSessionId`) so the caller can adopt it.
 */
export async function readSessionHistory(providerId: string, requestedId: string, query: HistoryPageQuery) {
  const id = resolveMigratedSession(requestedId);
  const cacheKey = `${providerId}\0${id}`;
  const stamp = historyStamp(providerId, id);
  let all = cachedHistory(cacheKey, stamp, query.before !== undefined);
  if (!all) {
    // A parse joined in flight may have read the file before the change this request's
    // stamp saw, so only the request that started it stores it — otherwise the end of a
    // turn could be cached away under a stamp that says it is there, for good.
    const joined = historyInFlight.has(cacheKey);
    all = await loadFullHistory(providerId, id);
    if (!joined && (stamp !== null || query.limit !== undefined || query.from !== undefined)) rememberHistory(cacheKey, stamp, all);
  }
  const page = pageHistory(all, query);
  // versionMap ships with the history so the `‹ n/m ›` switcher needs no
  // per-message request. Ordinals absent from the map have no edited versions.
  return {
    messages: page.messages,
    start: page.start,
    total: page.total,
    userOrdinalOffset: page.userOrdinalOffset,
    predecessorId: page.predecessorId,
    versionMap: resolveVersionMap(id),
    ...(id !== requestedId ? { canonicalSessionId: id } : {}),
  };
}
