/**
 * Given an already-owned session (see session-ownership.ts) and a requested
 * card or teammate, return the exact transcript file(s) the server may read —
 * never a client-supplied path.
 *
 * Claude card: `groupSubagentsByCard` keyed by the card's `toolUseId`, root
 * agent first then its nested descendants (already depth-ordered).
 * Codex card: the named thread's own rollout, accepted only when its
 * `session_meta.parent_thread_id` chain reaches the owning session — a
 * grandchild discovered later via the tail parser's own `links` is re-checked
 * through the exact same chain walk (`resolveCodexDescendantFile`) before the
 * hub ever starts tailing it.
 * Member: a teammate's newest transcript, `teamName` pinned to the project the
 * same way a Claude session id is (a team IS a session, see
 * `resolveTeamSubagentsDir`).
 *
 * Every returned path is realpath-contained under the Claude root or a Codex
 * sessions dir. Results — hits and misses alike — are cached for 2s per
 * (session, card/member) so a polling subscriber costs one dir scan per tick
 * at most, not one per subscriber.
 */

import { join } from "node:path";
import { getCachedSubagentGroups } from "./agent-transcript-index-cache.ts";
import { resolveMemberTranscript } from "../team-member-activity/member-activity.service.ts";
import { findRolloutByThreadId, isCodexRolloutPath, readSessionMeta } from "../../providers/codex-app-server/codex-history.ts";
import { claudeProjectsRoot } from "./claude-projects-root.ts";
import { SESSION_ID_RE, pinClaudeSessionDir, realpathContained, type OwnedSession } from "./session-ownership.ts";

export type AgentTranscriptSource =
  | { kind: "card"; cardId: string }
  | { kind: "member"; teamName: string; memberName: string };

export interface TranscriptFileRef {
  key: string;
  path: string;
  provider: "claude" | "codex";
}

export type SourceErrorCode =
  | "invalid_card_id"
  | "card_not_found"
  | "invalid_team_name"
  | "invalid_member_name"
  | "member_not_found"
  | "not_descendant";

export interface SourceError {
  ok: false;
  code: SourceErrorCode;
}

const CLAUDE_CARD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CODEX_CARD_ID_RE = /^subagent-([0-9a-f-]{36})$/;
const MEMBER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** How far up a chain of spawned Codex threads a card id is chased before giving up. */
const MAX_CHAIN_DEPTH = 8;

const CACHE_TTL_MS = 2000;
/** Bounds a client cycling through novel card ids (subscribe, unsubscribe, repeat)
 *  from growing this map forever — expired entries are swept first, and only a
 *  still-live entry is evicted (oldest insertion) if that alone isn't enough. */
const MAX_CACHE_ENTRIES = 500;
interface CacheEntry {
  expiresAt: number;
  result: TranscriptFileRef[] | SourceError;
}
const cache = new Map<string, CacheEntry>();

function evictForCapacity(now: number): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function err(code: SourceErrorCode): SourceError {
  return { ok: false, code };
}

function sourceCacheKey(sessionId: string, source: AgentTranscriptSource): string {
  return source.kind === "card"
    ? `${sessionId}\0card\0${source.cardId}`
    : `${sessionId}\0member\0${source.teamName}\0${source.memberName}`;
}

function resolveClaudeCard(owned: OwnedSession, cardId: string): TranscriptFileRef[] | SourceError {
  if (!CLAUDE_CARD_ID_RE.test(cardId)) return err("invalid_card_id");
  const subagentsDir = join(owned.claude!.sessionDir, "subagents");
  const group = getCachedSubagentGroups(subagentsDir).get(cardId);
  if (!group) return err("card_not_found");
  const root = claudeProjectsRoot();
  const files: TranscriptFileRef[] = [];
  for (const entry of group) {
    const real = realpathContained(entry.transcriptPath, root);
    if (real) files.push({ key: entry.agentId, path: real, provider: "claude" });
  }
  return files;
}

/** First rollout matching `threadId`, searched filename-first across every dir the owning session was found in. */
function findCodexFile(dirs: string[], threadId: string, projectPath: string): string | null {
  for (const dir of dirs) {
    const file = findRolloutByThreadId(dir, threadId, projectPath);
    if (file && isCodexRolloutPath(file)) return file;
  }
  return null;
}

/** Walk `session_meta.parent_thread_id` from `threadId` up to `sessionId`. One header read per hop. */
export function isCodexDescendant(dirs: string[], threadId: string, sessionId: string, projectPath: string): boolean {
  let cur = threadId;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    if (seen.has(cur)) return false; // cyclic session_meta — corrupt, refuse
    seen.add(cur);
    const file = findCodexFile(dirs, cur, projectPath);
    if (!file) return false;
    const parent = readSessionMeta(file)?.parentThreadId;
    if (!parent) return false;
    if (parent === sessionId) return true;
    cur = parent;
  }
  return false;
}

function resolveCodexCard(owned: OwnedSession, cardId: string): TranscriptFileRef[] | SourceError {
  const m = CODEX_CARD_ID_RE.exec(cardId);
  if (!m) return err("invalid_card_id");
  const threadId = m[1]!;
  const ref = resolveCodexDescendantFile(owned, threadId);
  if (!ref) {
    // Distinguish "no such rollout" from "found but not a descendant" the same
    // way the pre-refactor inline checks did, so the wire error code is unchanged.
    const file = findCodexFile(owned.codex!.dirs, threadId, owned.projectPath);
    return file ? err("not_descendant") : err("card_not_found");
  }
  return [ref];
}

/**
 * A Codex thread id → its transcript file, but only once the same fail-closed
 * chain walk used for a directly-requested card also accepts it. The hub's
 * live-discovery path (a tail parser's own `links`, surfacing a grandchild
 * spawned after a subscription started) reuses this rather than re-deriving
 * the check, so a nested thread can never bypass the descendant guard just
 * because it arrived through a different door.
 */
export function resolveCodexDescendantFile(owned: OwnedSession, threadId: string): TranscriptFileRef | null {
  const { dirs } = owned.codex!;
  const file = findCodexFile(dirs, threadId, owned.projectPath);
  if (!file) return null;
  if (!isCodexDescendant(dirs, threadId, owned.sessionId, owned.projectPath)) return null;
  return { key: threadId, path: file, provider: "codex" };
}

function resolveMember(owned: OwnedSession, teamName: string, memberName: string): TranscriptFileRef[] | SourceError {
  if (!SESSION_ID_RE.test(teamName)) return err("invalid_team_name");
  if (!MEMBER_NAME_RE.test(memberName)) return err("invalid_member_name");
  // A team is itself a session (resolveTeamSubagentsDir → resolveSessionDir): pin it to the
  // project the same way the primary session id is, before trusting anything it names.
  if (!pinClaudeSessionDir(teamName, owned.projectPath)) return err("member_not_found");
  const path = resolveMemberTranscript(teamName, memberName, owned.projectPath);
  if (!path) return err("member_not_found");
  const real = realpathContained(path, claudeProjectsRoot());
  if (!real) return err("member_not_found");
  return [{ key: memberName, path: real, provider: "claude" }];
}

function computeSources(owned: OwnedSession, source: AgentTranscriptSource): TranscriptFileRef[] | SourceError {
  if (source.kind === "member") return resolveMember(owned, source.teamName, source.memberName);
  return owned.providerId === "claude" ? resolveClaudeCard(owned, source.cardId) : resolveCodexCard(owned, source.cardId);
}

export function resolveSources(owned: OwnedSession, source: AgentTranscriptSource): TranscriptFileRef[] | SourceError {
  const key = sourceCacheKey(owned.sessionId, source);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.result;
  evictForCapacity(now);
  const result = computeSources(owned, source);
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}

/** Test-only: clear the 2s resolve cache between cases. */
export function _resetSourcesCache(): void {
  cache.clear();
}

/** Test-only: current cache size, to assert the capacity bound holds. */
export function _sourcesCacheSizeForTest(): number {
  return cache.size;
}
