/**
 * The turns of a chat session — every real prompt and what answered it, from the session's
 * first prompt on, compacted segments included and rolled-back turns left out.
 *
 * Every entry point takes the session the way a caller names it and makes it safe before any
 * file is opened: the id is checked against `SESSION_ID_RE`, followed through a Codex migration
 * (`resolveMigratedSession`: a tab can still hold the id PPM created before codex named the
 * thread), and the transcript path comes only from `assertSessionInProject`, which proves the
 * session belongs to the caller's project. `resolveSessionDir` is never used here — it searches
 * every project on disk and checks no id.
 */
import { existsSync } from "node:fs";
import { resolveMigratedSession } from "../db.service.ts";
import { assertSessionInProject, SESSION_ID_RE } from "../agent-transcript/session-ownership.ts";
import { TurnIndexCache, type ScanEntry } from "./turn-index-cache.ts";
import { claudeStateBytes, claudeTurnView, newClaudeScanState, scanClaudeTranscript, type ClaudeScanState } from "./turn-index-claude.ts";
import { codexStateBytes, codexTurnView, newCodexScanState, scanCodexRollout, type CodexScanState } from "./turn-index-codex.ts";
import { SessionTurnError, type SessionTurnSummary, type TurnProviderId, type TurnStamp, type TurnView } from "./session-turn-types.ts";

/** A session as a caller names it: the provider, the id, and the project asking. */
export interface SessionRef {
  providerId: string;
  sessionId: string;
  projectPath: string;
}

export interface ResolvedSession {
  providerId: TurnProviderId;
  /** The id that owns the transcript, after any migration. */
  sessionId: string;
  path: string;
}

const claudeCache = new TurnIndexCache<ClaudeScanState>({
  newState: newClaudeScanState, scan: scanClaudeTranscript, sizeOf: claudeStateBytes,
});
const codexCache = new TurnIndexCache<CodexScanState>({
  newState: newCodexScanState, scan: scanCodexRollout, sizeOf: codexStateBytes,
});

/** Owned paths already proven, so a Codex lookup does not walk the sessions tree every ask. */
const ownedPaths = new Map<string, string>();
const OWNED_PATHS_MAX = 500;

let runningProbe: (sessionId: string) => boolean = () => false;

/**
 * Who can tell whether a session has a turn in flight (the chat socket registers itself).
 * Returns the probe it replaces, so a test can put it back.
 */
export function setTurnRunningProbe(probe: (sessionId: string) => boolean): (sessionId: string) => boolean {
  const previous = runningProbe;
  runningProbe = probe;
  return previous;
}

/** Canonical id and owned transcript path, or a `SessionTurnError`. */
export function resolveSessionTranscript(ref: SessionRef): ResolvedSession {
  const { providerId, projectPath } = ref;
  if (providerId !== "claude" && providerId !== "codex") throw new SessionTurnError("invalid", `Unknown provider: ${providerId}`);
  if (!SESSION_ID_RE.test(ref.sessionId)) throw new SessionTurnError("invalid", "Invalid session id");
  const sessionId = resolveMigratedSession(ref.sessionId);
  const key = `${providerId}\0${sessionId}\0${projectPath}`;
  const known = ownedPaths.get(key);
  if (known && existsSync(known)) return { providerId, sessionId, path: known };
  const owned = assertSessionInProject({ providerId, sessionId, projectPath });
  if (!owned.ok) {
    throw new SessionTurnError(owned.code === "invalid_session_id" ? "invalid" : "session_missing", "Session not found in this project");
  }
  const path = owned.claude ? `${owned.claude.sessionDir}.jsonl` : owned.codex!.path;
  ownedPaths.set(key, path);
  if (ownedPaths.size > OWNED_PATHS_MAX) ownedPaths.delete(ownedPaths.keys().next().value!);
  return { providerId, sessionId, path };
}

export interface SessionTurnScan {
  session: ResolvedSession;
  view: TurnView;
  /** Where the scan stopped; a newest turn's range ends here. */
  indexedTo: number;
  /** The transcript as the scan saw it, so a reader can tell whether it has changed since. */
  file: { size: number; mtimeMs: number; fingerprint: string };
}

function scanOf<S>(session: ResolvedSession, entry: ScanEntry<S>, view: TurnView): SessionTurnScan {
  return {
    session, view, indexedTo: entry.offset,
    file: { size: entry.size, mtimeMs: entry.mtimeMs, fingerprint: entry.fingerprint },
  };
}

/** The session's turns as its transcript is now. */
export async function scanSessionTurns(ref: SessionRef): Promise<SessionTurnScan> {
  const session = resolveSessionTranscript(ref);
  try {
    if (session.providerId === "claude") {
      const entry: ScanEntry<ClaudeScanState> = await claudeCache.get(session.path);
      return scanOf(session, entry, claudeTurnView(entry.state));
    }
    const entry: ScanEntry<CodexScanState> = await codexCache.get(session.path);
    return scanOf(session, entry, codexTurnView(entry.state));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") throw new SessionTurnError("session_missing", "Transcript not found");
    throw e;
  }
}

/** Drop a transcript's scan, so the next ask rebuilds it from the start. */
export function invalidateSessionTurns(session: ResolvedSession): void {
  (session.providerId === "claude" ? claudeCache : codexCache).invalidate(session.path);
}

/** The turns as the index answers for them; the newest is "running" while a turn is in flight. */
export function summarizeTurns(scan: SessionTurnScan): SessionTurnSummary[] {
  const running = runningProbe(scan.session.sessionId);
  const last = scan.view.turns.length - 1;
  return scan.view.turns.map((turn, i) => ({
    turnId: turn.turnId,
    n: i + 1,
    startedAt: turn.startedAt,
    prompt: turn.prompt,
    messageCount: turn.messageCount,
    status: i === last && running && !turn.closed ? "running" : "complete",
  }));
}

export async function listSessionTurns(ref: SessionRef): Promise<{ sessionId: string; providerId: TurnProviderId; turns: SessionTurnSummary[] }> {
  const scan = await scanSessionTurns(ref);
  return { sessionId: scan.session.sessionId, providerId: scan.session.providerId, turns: summarizeTurns(scan) };
}

/** One turn's summary; `not_found` / `rolled_back` when the session has no such turn. */
export async function getSessionTurn(ref: SessionRef, turnId: string): Promise<SessionTurnSummary & { sessionId: string }> {
  const scan = await scanSessionTurns(ref);
  const turn = summarizeTurns(scan).find((t) => t.turnId === turnId);
  if (turn) return { ...turn, sessionId: scan.session.sessionId };
  if (scan.view.isRolledBack(turnId)) throw new SessionTurnError("rolled_back", "That turn was rolled back");
  throw new SessionTurnError("not_found", "No such turn in this session");
}

/** The turn a message belongs to — Claude: by record uuid; Codex: by native turn id. */
export async function resolveTurnOf(ref: SessionRef, key: { messageUuid: string }): Promise<TurnStamp | null> {
  return (await scanSessionTurns(ref)).view.stampOf(key.messageUuid) ?? null;
}

/** Turn lookup by message key, for stamping a whole history at once. */
export async function turnLookup(ref: SessionRef): Promise<(key: string) => TurnStamp | undefined> {
  const { view } = await scanSessionTurns(ref);
  return (key) => view.stampOf(key);
}

/** Every key the session's messages can be stamped by, with its turn. */
export async function uuidTurnMap(ref: SessionRef): Promise<Map<string, TurnStamp>> {
  const { view } = await scanSessionTurns(ref);
  const out = new Map<string, TurnStamp>();
  for (const key of view.keys()) {
    const stamp = view.stampOf(key);
    if (stamp) out.set(key, stamp);
  }
  return out;
}
