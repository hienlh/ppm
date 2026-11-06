import { resolveMigratedSession } from "../db.service.ts";
import { collabWaits } from "./collab-waits.ts";

/**
 * What the chat registry tells the session tools about turns, kept in a module that imports
 * nothing of the server's so `ws/chat.ts` can call it without an import cycle.
 *
 * A created session counts against the running limit from the moment it is created until its
 * first turn ends: in between it may not be running yet (resuming, waiting for the lock), and a
 * burst of creates would otherwise all see the old count.
 */

/** Longest a created session counts as starting when no turn end is ever heard for it. */
const STARTING_MAX_MS = 30 * 60_000;

const starting = new Map<string, { projectName: string; timer: ReturnType<typeof setTimeout> }>();

export function markChildStarting(childId: string, projectName: string): void {
  const id = resolveMigratedSession(childId);
  const held = starting.get(id);
  if (held) clearTimeout(held.timer);
  const timer = setTimeout(() => starting.delete(id), STARTING_MAX_MS);
  (timer as { unref?: () => void }).unref?.();
  starting.set(id, { projectName, timer });
}

/** Running-limit slots per project held by creates still being asked about or created. */
const reserved = new Map<string, number>();

/**
 * Holds one of the project's running-limit slots for a create from its check until the session
 * exists (then {@link markChildStarting} counts it). Taken synchronously with the check, so
 * creates arriving together cannot all see the same free slot. The release is idempotent.
 */
export function reserveChildSlot(projectName: string): () => void {
  reserved.set(projectName, (reserved.get(projectName) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (reserved.get(projectName) ?? 1) - 1;
    if (left > 0) reserved.set(projectName, left);
    else reserved.delete(projectName);
  };
}

/** Slots of the project held by creates in progress. */
export function reservedChildSlots(projectName: string): number {
  return reserved.get(projectName) ?? 0;
}

/** Created sessions of the project whose first turn has not ended yet. */
export function startingChildren(projectName: string): string[] {
  const out: string[] = [];
  for (const [id, held] of starting) if (held.projectName === projectName) out.push(resolveMigratedSession(id));
  return out;
}

/** A turn of the session ended (or its stream closed): waits on it are judged, and it stops starting. */
export function collabTurnEnded(sessionId: string): void {
  collabWaits.turnEnded(sessionId);
  const id = resolveMigratedSession(sessionId);
  for (const key of [sessionId, id]) {
    const held = starting.get(key);
    if (!held) continue;
    clearTimeout(held.timer);
    starting.delete(key);
  }
}

/** A provider renamed a session: a starting mark follows it. */
export function collabSessionRenamed(oldId: string, newId: string): void {
  const held = starting.get(oldId);
  if (!held) return;
  starting.delete(oldId);
  starting.set(newId, held);
}
