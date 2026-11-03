/**
 * Which turns of *other projects* a chat session's AI may read with `read_session_turns`.
 *
 * A grant is written at one moment only: when a person sends a message with turn references from
 * a browser, over the authenticated chat socket (`ws/chat.ts`, after `validateTurnRefs`). It is
 * never derived from transcript text — compaction summaries, skill and hook text, task
 * notifications, Jira tickets, group-chat peers, schedules and PPMBot all write user-role records
 * that anyone could fill with a reference block.
 *
 * One JSON file per chat session under `<ppm dir>/session-turn-grants/`, named by the session's
 * canonical id at the time of writing, written atomically, capped at {@link MAX_GRANTS} (oldest
 * dropped), and deleted with the session. A Codex chat is renamed during its first turn, so a
 * lookup reads the files of every id that session has been known by.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, resolveMigratedSession } from "../db.service.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { createLogger } from "../logger.ts";
import { SESSION_ID_RE, TURN_ID_RE } from "../../shared/session-turn-ids.ts";
import type { TurnReference } from "../../shared/chat-turn-ref.ts";

const log = createLogger("turn-grants");

/** Most grants one session keeps; the oldest go first. */
export const MAX_GRANTS = 500;
/** How many earlier ids a lookup follows back from the canonical one. */
const MAX_ALIASES = 16;

export interface TurnGrant {
  projectName: string;
  providerId: "claude" | "codex";
  sessionId: string;
  turnId: string;
  /** ISO time the person sent the reference. */
  grantedAt: string;
}

interface GrantFile {
  version: 1;
  grants: TurnGrant[];
}

const grantsDir = (): string => join(getPpmDir(), "session-turn-grants");
const fileFor = (sessionId: string): string => join(grantsDir(), `${sessionId}.json`);

function readFile(sessionId: string): TurnGrant[] {
  if (!SESSION_ID_RE.test(sessionId)) return [];
  const path = fileFor(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GrantFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.grants)) return [];
    return parsed.grants.filter((g): g is TurnGrant => !!g && typeof g === "object"
      && typeof g.projectName === "string" && (g.providerId === "claude" || g.providerId === "codex")
      && typeof g.sessionId === "string" && SESSION_ID_RE.test(g.sessionId)
      && typeof g.turnId === "string" && TURN_ID_RE.test(g.turnId) && typeof g.grantedAt === "string");
  } catch (e) {
    log.warn(`unreadable grants for session=${sessionId}: ${(e as Error).message}`);
    return [];
  }
}

/** Every id the session has been known by: the canonical one, and those that migrated into it. */
function aliasesOf(sessionId: string): string[] {
  const canonical = resolveMigratedSession(sessionId);
  const out = [canonical];
  const query = getDb().query("SELECT session_id FROM session_metadata WHERE migrated_to = ?");
  for (let i = 0; i < out.length && out.length < MAX_ALIASES; i++) {
    for (const row of query.all(out[i]!) as Array<{ session_id: string }>) {
      if (!out.includes(row.session_id)) out.push(row.session_id);
    }
  }
  if (!out.includes(sessionId)) out.push(sessionId);
  return out;
}

const grantKey = (g: Pick<TurnGrant, "providerId" | "sessionId" | "turnId">): string =>
  `${g.providerId}\0${resolveMigratedSession(g.sessionId)}\0${g.turnId}`;

/**
 * Records the references a person just sent in `callerSessionId` as readable by that session's
 * AI. Call only for a message that came from an authenticated browser and passed
 * `validateTurnRefs`. A failure to write is logged, never thrown: the message still goes out.
 */
export function recordTurnGrants(callerSessionId: string, refs: readonly TurnReference[]): void {
  if (!refs.length) return;
  const owner = resolveMigratedSession(callerSessionId);
  if (!SESSION_ID_RE.test(owner)) return;
  try {
    const now = new Date().toISOString();
    const byKey = new Map<string, TurnGrant>();
    for (const g of readFile(owner)) byKey.set(grantKey(g), g);
    for (const ref of refs) {
      const grant: TurnGrant = { projectName: ref.projectName, providerId: ref.providerId, sessionId: ref.sessionId, turnId: ref.turnId, grantedAt: now };
      const key = grantKey(grant);
      byKey.delete(key); // re-sent: it moves to the newest end
      byKey.set(key, grant);
    }
    const grants = [...byKey.values()].slice(-MAX_GRANTS);
    mkdirSync(grantsDir(), { recursive: true });
    const path = fileFor(owner);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, grants } satisfies GrantFile), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    log.warn(`could not record turn grants for session=${owner}: ${(e as Error).message}`);
  }
}

/** Every grant the session holds, under any id it has been known by. */
export function turnGrantsFor(callerSessionId: string): TurnGrant[] {
  if (!SESSION_ID_RE.test(callerSessionId)) return [];
  const byKey = new Map<string, TurnGrant>();
  for (const id of aliasesOf(callerSessionId)) for (const g of readFile(id)) byKey.set(grantKey(g), g);
  return [...byKey.values()];
}

/** The grant for exactly this turn, or undefined. Session ids are compared after any migration. */
export function findTurnGrant(
  callerSessionId: string,
  turn: { projectName?: string; sessionId: string; turnId: string },
): TurnGrant | undefined {
  const target = resolveMigratedSession(turn.sessionId);
  return turnGrantsFor(callerSessionId).find((g) => g.turnId === turn.turnId
    && resolveMigratedSession(g.sessionId) === target
    && (turn.projectName === undefined || g.projectName === turn.projectName));
}

/** Deletes the session's grants, under every id it has been known by. */
export function deleteTurnGrants(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) return;
  for (const id of aliasesOf(sessionId)) {
    if (!SESSION_ID_RE.test(id)) continue;
    try {
      rmSync(fileFor(id), { force: true });
    } catch (e) {
      log.warn(`could not delete turn grants for session=${id}: ${(e as Error).message}`);
    }
  }
}
