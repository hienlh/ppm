import { getSessionDesignSlug, getSessionProjectPath } from "../db.service.ts";
import { isValidDesignSlug } from "./design-slug.ts";
import { designLockKey, detachFromDesignLocks } from "./design-lock.ts";
import { snapshotDesign } from "./design-snapshots.service.ts";

/**
 * Snapshot a design after each turn of its design session.
 *
 * Called from `chatService.sendMessage` on every `done` and on every terminal background
 * task notification, so turns from the WebSocket, `ppm chat send`, the scheduler and the
 * bots are all covered. Work an agent started in the background can keep writing after
 * the turn's `done`, which is why its completion schedules a snapshot too.
 *
 * Debounced per design: a turn's `done` followed shortly by its background task finishing
 * produces one snapshot of the final state, not two. The timer is deliberately left
 * referenced so a one-shot CLI process stays alive long enough to take it.
 */

export const TURN_SNAPSHOT_DEBOUNCE_MS = 2000;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  fire: () => void;
}

const pending = new Map<string, Pending>();
const inFlight = new Set<Promise<void>>();
let debounceMs = TURN_SNAPSHOT_DEBOUNCE_MS;

/** Test seam for the debounce interval. */
export function setTurnSnapshotDebounceForTests(ms: number | null): void {
  debounceMs = ms ?? TURN_SNAPSHOT_DEBOUNCE_MS;
}

/**
 * Schedule a `turn` snapshot for the session's design. A no-op for an ordinary session
 * (no design slug) or one with no known project. Never throws: a snapshot problem must not
 * disturb the turn that triggered it.
 */
export function scheduleTurnSnapshot(sessionId: string, projectPath?: string | null): void {
  try {
    const slug = getSessionDesignSlug(sessionId);
    if (!slug || !isValidDesignSlug(slug)) return;
    const project = projectPath || getSessionProjectPath(sessionId);
    if (!project) return;
    const key = designLockKey(project, slug);
    const existing = pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const run = async (): Promise<void> => {
      pending.delete(key);
      try {
        await snapshotDesign(project, slug, "turn", { sessionId });
      } catch (e) {
        console.warn(`[design] turn snapshot of ${slug} failed: ${(e as Error).message}`);
      }
    };
    const fire = (): void => {
      const job = detachFromDesignLocks(run);
      inFlight.add(job);
      void job.finally(() => inFlight.delete(job));
    };
    pending.set(key, { timer: setTimeout(fire, debounceMs), fire });
  } catch (e) {
    console.warn(`[design] could not schedule a turn snapshot for ${sessionId}: ${(e as Error).message}`);
  }
}

/** Run every pending snapshot now and wait for all of them, in flight ones included. */
export async function flushTurnSnapshots(): Promise<void> {
  for (const job of [...pending.values()]) {
    clearTimeout(job.timer);
    job.fire();
  }
  await Promise.all([...inFlight]);
}

export function pendingTurnSnapshotCount(): number {
  return pending.size;
}
