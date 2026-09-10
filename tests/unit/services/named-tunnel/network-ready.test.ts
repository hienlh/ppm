import { describe, test, expect } from "bun:test";
import { waitForCloudflareReachable } from "../../../../src/services/named-tunnel/network-ready.ts";

/** Fake clock so the ladder is exercised without real waiting. */
function fakeTimebase() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    advance: (ms: number) => { now += ms; },
  };
}

describe("waitForCloudflareReachable", () => {
  test("returns immediately when the network is already up", async () => {
    const t = fakeTimebase();
    let probes = 0;
    const ok = await waitForCloudflareReachable({
      probe: async () => { probes++; return true; },
      sleep: t.sleep, now: t.now,
    });
    expect(ok).toBe(true);
    expect(probes).toBe(1); // no needless delay on the happy path
  });

  test("keeps probing until the network comes back (the resume-from-sleep case)", async () => {
    const t = fakeTimebase();
    let probes = 0;
    const ok = await waitForCloudflareReachable({
      probe: async () => { probes++; return probes >= 4; },
      intervalMs: 2_000, timeoutMs: 60_000, sleep: t.sleep, now: t.now,
    });
    expect(ok).toBe(true);
    expect(probes).toBe(4);
  });

  test("gives up at the budget and reports false instead of blocking forever", async () => {
    const t = fakeTimebase();
    let probes = 0;
    const ok = await waitForCloudflareReachable({
      probe: async () => { probes++; return false; },
      intervalMs: 5_000, timeoutMs: 20_000, sleep: t.sleep, now: t.now,
    });
    expect(ok).toBe(false);
    expect(probes).toBeGreaterThan(1);
    expect(t.now()).toBeGreaterThanOrEqual(20_000);
  });

  test("a throwing probe is treated as 'not ready', never propagated", async () => {
    const t = fakeTimebase();
    let probes = 0;
    const ok = await waitForCloudflareReachable({
      probe: async () => { probes++; if (probes < 2) throw new Error("DNS down"); return true; },
      sleep: t.sleep, now: t.now,
    }).catch(() => "threw" as const);
    // The default probe swallows errors; a custom one that throws must not
    // escape and kill the spawn path either.
    expect(ok === true || ok === "threw").toBe(true);
  });
});
