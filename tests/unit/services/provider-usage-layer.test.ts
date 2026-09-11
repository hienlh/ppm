import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { UsageInfo } from "../../../src/types/chat.ts";
import type { ProviderUsageSource } from "../../../src/services/provider-usage/usage-source.ts";
import { AMBIENT_ACCOUNT_KEY } from "../../../src/services/provider-usage/usage-source.ts";
import {
  registerUsageSource,
  getUsage,
  getOrFetchUsage,
  refreshUsage,
  invalidateUsage,
  _clearUsageSources,
} from "../../../src/services/provider-usage/usage-registry.ts";
import { sweepUsageSource } from "../../../src/services/provider-usage/usage-scheduler.ts";
import { resetUsageRuntimeState } from "../../../src/services/provider-usage/index.ts";

/**
 * The shared layer on its own — no Claude, no codex. A fake source stands in for
 * a provider, which is the point: the generic behaviour a new provider inherits
 * has to hold without any provider-specific code involved.
 *
 * Buckets are deliberately absent from most fixtures so the snapshot store skips
 * the database entirely and these stay pure in-memory tests.
 */

const PROVIDER = "fake-provider";

function bucketedUsage(utilization: number): UsageInfo {
  return { session: { utilization, resetsAt: "", resetsInMinutes: 0, resetsInHours: null, windowHours: 5 } };
}

interface FakeSource extends ProviderUsageSource {
  calls: string[];
}

function makeSource(over: Partial<ProviderUsageSource> = {}): FakeSource {
  const calls: string[] = [];
  return {
    providerId: PROVIDER,
    calls,
    listAccountIds: () => ["a1", "a2"],
    async fetch(accountId: string) {
      calls.push(accountId);
      return { totalCostUsd: 1 };
    },
    ...over,
  } as FakeSource;
}

beforeEach(() => {
  _clearUsageSources();
  resetUsageRuntimeState();
});

afterEach(() => {
  _clearUsageSources();
  resetUsageRuntimeState();
});

describe("reads never call the provider", () => {
  it("getUsage returns {} for an unknown provider without throwing", () => {
    expect(getUsage("nobody", "a1")).toEqual({});
  });

  it("getUsage does not fetch, even when a source is registered", () => {
    const source = makeSource();
    registerUsageSource(source);
    expect(getUsage(PROVIDER, "a1")).toEqual({});
    // The whole point of the layer: a toolbar read is never a provider call.
    expect(source.calls).toEqual([]);
  });

  it("getUsage serves what a refresh put in the cache", async () => {
    registerUsageSource(makeSource());
    await refreshUsage(PROVIDER, "a1");
    expect(getUsage(PROVIDER, "a1")).toEqual({ totalCostUsd: 1 });
  });

  it("keeps accounts apart", async () => {
    registerUsageSource(makeSource({
      async fetch(accountId: string) { return { totalCostUsd: accountId === "a1" ? 1 : 2 }; },
    }));
    await refreshUsage(PROVIDER, "a1");
    await refreshUsage(PROVIDER, "a2");
    expect(getUsage(PROVIDER, "a1")).toEqual({ totalCostUsd: 1 });
    expect(getUsage(PROVIDER, "a2")).toEqual({ totalCostUsd: 2 });
  });
});

describe("failures", () => {
  it("a rejected fetch resolves to {} rather than propagating", async () => {
    registerUsageSource(makeSource({ fetch: async () => { throw new Error("boom"); } }));
    expect(await refreshUsage(PROVIDER, "a1")).toEqual({});
  });

  it("is remembered, so a miss does not re-fetch on every read", async () => {
    const source = makeSource({
      async fetch(accountId: string) { this.calls.push(accountId); throw new Error("boom"); },
    } as Partial<ProviderUsageSource>);
    registerUsageSource(source);

    await getOrFetchUsage(PROVIDER, "a1");
    await getOrFetchUsage(PROVIDER, "a1");
    await getOrFetchUsage(PROVIDER, "a1");

    // Without negative caching this was one provider call per request — for
    // codex, one spawned subprocess per request.
    expect(source.calls).toEqual(["a1"]);
  });

  it("an explicit invalidate clears the remembered failure", async () => {
    let attempt = 0;
    registerUsageSource(makeSource({
      async fetch() {
        attempt++;
        if (attempt === 1) throw new Error("boom");
        return { totalCostUsd: 9 };
      },
    }));

    expect(await getOrFetchUsage(PROVIDER, "a1")).toEqual({});
    invalidateUsage(PROVIDER, "a1");
    expect(await getOrFetchUsage(PROVIDER, "a1")).toEqual({ totalCostUsd: 9 });
  });
});

describe("a hung provider cannot hang the caller", () => {
  it("times the fetch out instead of waiting forever", async () => {
    registerUsageSource(makeSource({
      // Never settles — the exact shape of the codex app-server that accepts a
      // spawn and then goes silent. The real ceiling is 20s; overridden here so
      // the assertion is about the timeout existing, not about waiting for it.
      fetchTimeoutMs: 150,
      fetch: () => new Promise<UsageInfo>(() => {}),
    }));

    const result = await Promise.race([
      refreshUsage(PROVIDER, "a1"),
      new Promise((r) => setTimeout(() => r("STILL-HANGING"), 3_000)),
    ]);

    expect(result).toEqual({});
  });

  it("lets a source raise its own ceiling", () => {
    const slow = makeSource({ fetchTimeoutMs: 60_000 });
    expect(slow.fetchTimeoutMs).toBe(60_000);
  });
});

describe("de-duplication", () => {
  it("concurrent refreshes of one account share a single fetch", async () => {
    let calls = 0;
    registerUsageSource(makeSource({
      async fetch() {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { totalCostUsd: 3 };
      },
    }));

    const all = await Promise.all([
      refreshUsage(PROVIDER, "a1"),
      refreshUsage(PROVIDER, "a1"),
      refreshUsage(PROVIDER, "a1"),
    ]);

    expect(calls).toBe(1);
    expect(all).toEqual([{ totalCostUsd: 3 }, { totalCostUsd: 3 }, { totalCostUsd: 3 }]);
  });

  it("an abandoned fetch settling late does not evict its replacement", async () => {
    let release!: () => void;
    let calls = 0;
    registerUsageSource(makeSource({
      async fetch() {
        calls++;
        if (calls === 1) await new Promise<void>((r) => { release = r; });
        return { totalCostUsd: calls };
      },
    }));

    const abandoned = refreshUsage(PROVIDER, "a1");
    resetUsageRuntimeState();          // caller gives up on the stuck attempt
    const replacement = refreshUsage(PROVIDER, "a1");

    release();                          // the old one finally answers
    await abandoned;
    await new Promise((r) => setTimeout(r, 10));

    expect(await replacement).toEqual({ totalCostUsd: 2 });
  });
});

describe("sweeps", () => {
  it("visits every account the source lists", async () => {
    const source = makeSource();
    registerUsageSource(source);
    await sweepUsageSource(source);
    expect(source.calls).toEqual(["a1", "a2"]);
  });

  it("falls back to the ambient login when there are no accounts", async () => {
    const source = makeSource({ listAccountIds: () => [] });
    registerUsageSource(source);
    await sweepUsageSource(source);
    expect(source.calls).toEqual([AMBIENT_ACCOUNT_KEY]);
  });

  it("honours shouldSkip without recording a failure", async () => {
    const source = makeSource({ shouldSkip: (id: string) => id === "a1" });
    registerUsageSource(source);
    await sweepUsageSource(source);
    expect(source.calls).toEqual(["a2"]);
  });

  it("treats a source that cannot decide as skip, not fetch", async () => {
    const source = makeSource({ shouldSkip: () => { throw new Error("cannot tell"); } });
    registerUsageSource(source);
    await sweepUsageSource(source);
    expect(source.calls).toEqual([]);
  });

  it("keeps going after one account fails", async () => {
    const source = makeSource({
      async fetch(accountId: string) {
        this.calls.push(accountId);
        if (accountId === "a1") throw new Error("boom");
        return bucketedUsage(0.5);
      },
    } as Partial<ProviderUsageSource>);
    registerUsageSource(source);

    await sweepUsageSource(source);
    // A broken account must not cut the sweep short for the ones behind it.
    expect(source.calls).toEqual(["a1", "a2"]);
  });
});
