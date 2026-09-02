import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_CONCURRENT,
  _resetSemaphore,
  acquireSlot,
  activeCount,
} from "../../../src/web/components/os-explorer/icons/thumbnail-fetch-semaphore.ts";

describe("thumbnail fetch semaphore", () => {
  beforeEach(() => _resetSemaphore());

  test("30 concurrent acquisitions never exceed MAX_CONCURRENT in flight", async () => {
    const releases: (() => void)[] = [];
    const requesters = Array.from({ length: 30 }, (_, i) =>
      acquireSlot().then((release) => {
        releases[i] = release;
      }),
    );

    // Give the synchronously-resolvable acquisitions a tick to settle; the remaining
    // 30 - MAX_CONCURRENT stay queued until a slot frees up.
    await Promise.resolve();
    await Promise.resolve();

    expect(activeCount()).toBe(MAX_CONCURRENT);
    expect(activeCount()).toBeLessThanOrEqual(MAX_CONCURRENT);
    expect(releases.filter(Boolean)).toHaveLength(MAX_CONCURRENT);

    // Draining the queue one release at a time must never push active above the cap.
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      releases[i]!();
      await Promise.resolve();
      expect(activeCount()).toBeLessThanOrEqual(MAX_CONCURRENT);
      expect(activeCount()).toBeGreaterThanOrEqual(0);
    }

    await Promise.all(requesters);
    for (const release of releases) release();
    expect(activeCount()).toBe(0);
  });

  test("releasing the same acquisition twice is a no-op — active never goes negative", async () => {
    const release = await acquireSlot();
    expect(activeCount()).toBe(1);

    release();
    expect(activeCount()).toBe(0);

    // The bug this guards against: a second release call (e.g. from both a `finally`
    // block and an effect cleanup for the same completed fetch) must not decrement again.
    release();
    release();
    expect(activeCount()).toBe(0);
  });

  test("a released slot is handed to the next queued acquisition, not double-counted", async () => {
    const releases: (() => void)[] = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      releases.push(await acquireSlot());
    }
    expect(activeCount()).toBe(MAX_CONCURRENT);

    let queuedResolved = false;
    const queued = acquireSlot().then((release) => {
      queuedResolved = true;
      return release;
    });
    await Promise.resolve();
    expect(queuedResolved).toBe(false); // still queued, cap holds

    releases[0]!();
    releases[0]!(); // double-release the same freed slot — must not free a second one
    await Promise.resolve();
    expect(activeCount()).toBe(MAX_CONCURRENT); // one freed, one taken by the queue

    const queuedRelease = await queued;
    queuedRelease();
    expect(activeCount()).toBe(MAX_CONCURRENT - 1);
  });
});
