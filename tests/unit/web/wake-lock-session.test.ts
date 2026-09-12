import { describe, expect, test } from "bun:test";
import {
  startWakeLockSession,
  type WakeLockSentinelLike,
  type WakeLockSessionDeps,
} from "../../../src/web/hooks/use-wake-lock.ts";

/** A sentinel that records releases and can fire the platform's `release` event on demand. */
function fakeSentinel(log: string[], id: string) {
  let onRelease: (() => void) | null = null;
  const sentinel: WakeLockSentinelLike = {
    release: async () => { log.push(`release:${id}`); },
    addEventListener: (_type, listener) => { onRelease = listener; },
  };
  return { sentinel, fireRelease: () => onRelease?.() };
}

interface Harness {
  deps: WakeLockSessionDeps;
  log: string[];
  active: boolean[];
  setVisible: (v: boolean) => void;
  fireVisibilityChange: () => void;
  sentinels: ReturnType<typeof fakeSentinel>[];
}

function harness(opts: { visible?: boolean; failRequests?: boolean } = {}): Harness {
  const log: string[] = [];
  const active: boolean[] = [];
  const sentinels: ReturnType<typeof fakeSentinel>[] = [];
  let visible = opts.visible ?? true;
  let listener: (() => void) | null = null;

  const deps: WakeLockSessionDeps = {
    request: async () => {
      log.push("request");
      if (opts.failRequests) throw new Error("NotAllowedError");
      const s = fakeSentinel(log, String(sentinels.length));
      sentinels.push(s);
      return s.sentinel;
    },
    isVisible: () => visible,
    onVisibilityChange: (l) => {
      listener = l;
      return () => { listener = null; log.push("unsubscribed"); };
    },
    onActive: (a) => active.push(a),
  };

  return {
    deps, log, active, sentinels,
    setVisible: (v) => { visible = v; },
    fireVisibilityChange: () => listener?.(),
  };
}

/** `startWakeLockSession` acquires asynchronously; let the microtask queue drain. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("startWakeLockSession", () => {
  test("acquires a lock immediately and reports it active", async () => {
    const h = harness();
    startWakeLockSession(h.deps);
    await settle();

    expect(h.log).toEqual(["request"]);
    expect(h.active).toEqual([true]);
  });

  test("teardown releases the lock and clears the indicator", async () => {
    const h = harness();
    const stop = startWakeLockSession(h.deps);
    await settle();

    stop();
    await settle();

    expect(h.log).toContain("release:0");
    expect(h.log).toContain("unsubscribed");
    expect(h.active[h.active.length - 1]).toBe(false);
  });

  test("re-acquires when the document becomes visible again", async () => {
    // The browser drops the lock on every hide and never restores it, so without this the
    // feature would work exactly once per session.
    const h = harness();
    startWakeLockSession(h.deps);
    await settle();

    h.setVisible(false);
    h.fireVisibilityChange();
    h.sentinels[0]!.fireRelease();   // platform confirms the revoke
    await settle();
    expect(h.log.filter((l) => l === "request")).toHaveLength(1);

    h.setVisible(true);
    h.fireVisibilityChange();
    await settle();

    expect(h.log.filter((l) => l === "request")).toHaveLength(2);
    expect(h.active[h.active.length - 1]).toBe(true);
  });

  test("a platform revoke while visible reports the screen no longer held", async () => {
    // Battery saver can take the lock back mid-turn. The indicator must follow the browser,
    // not the setting.
    const h = harness();
    startWakeLockSession(h.deps);
    await settle();

    h.sentinels[0]!.fireRelease();

    expect(h.active).toEqual([true, false]);
  });

  test("re-acquires even when the release event never arrives before the tab returns", async () => {
    // `visibilitychange` and the sentinel's `release` event are separate tasks with no defined
    // order. If the hide/show pair lands first, a stale handle must not block the re-acquire.
    const h = harness();
    startWakeLockSession(h.deps);
    await settle();

    h.setVisible(false);
    h.fireVisibilityChange();
    h.setVisible(true);
    h.fireVisibilityChange();
    await settle();

    expect(h.log.filter((l) => l === "request")).toHaveLength(2);
    expect(h.active).toEqual([true, false, true]);
  });

  test("does not request while the document is hidden", async () => {
    // Requesting from a hidden document throws NotAllowedError, so the guard avoids a
    // guaranteed failure rather than catching one.
    const h = harness({ visible: false });
    startWakeLockSession(h.deps);
    await settle();

    expect(h.log).toEqual([]);
  });

  test("a refused request is reported inactive and not retried on its own", async () => {
    // Battery saver and a low battery are both legitimate refusals; retrying in a loop would
    // only drain the battery that caused the refusal.
    const h = harness({ failRequests: true });
    startWakeLockSession(h.deps);
    await settle();

    expect(h.log).toEqual(["request"]);
    expect(h.active).toEqual([false]);
  });

  test("holds only one lock when visibility flaps while still acquired", async () => {
    const h = harness();
    startWakeLockSession(h.deps);
    await settle();

    h.fireVisibilityChange();
    h.fireVisibilityChange();
    await settle();

    expect(h.log.filter((l) => l === "request")).toHaveLength(1);
  });

  test("does not fire a second request while the first is still in flight", async () => {
    // Tab flapping can re-enter before the first request resolves; a second lock would overwrite
    // the handle to the first and leak it.
    const h = harness();
    startWakeLockSession(h.deps);
    h.fireVisibilityChange();
    h.fireVisibilityChange();
    await settle();

    expect(h.log.filter((l) => l === "request")).toHaveLength(1);
  });

  test("releases a lock that resolves after teardown", async () => {
    // StrictMode tears the effect down immediately after mounting it; the in-flight request
    // must not leak a lock nobody holds a handle to.
    const h = harness();
    const stop = startWakeLockSession(h.deps);
    stop();
    await settle();

    expect(h.log).toContain("release:0");
    expect(h.active[h.active.length - 1]).toBe(false);
  });
});
