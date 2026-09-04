// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/use-resource-monitor-lease-auth.test.ts
//
// Regression for the bug where the subscriber-lease ping/DELETE sent no Authorization
// header: under default auth (enabled), every ping 401s, the server reaps the lease at
// 30s, and the client reconnects forever. The kill request already carried the bearer;
// this covers the lease requests the same way.
import { describe, it, expect, afterEach } from "bun:test";

// api-client (and this hook, transitively) touches localStorage at call time — stub
// before importing, same pattern as tests/unit/web/api-client-get-dedup.test.ts.
const TOKEN_KEY = "ppm-auth-token";
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { pingLease, deleteLease, authHeaders, withGroupsRetention } = await import(
  "../../../src/web/hooks/use-resource-monitor.ts"
);

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as any).fetch = realFetch;
  store.clear();
});

function captureFetch(): { headers: Record<string, string> | undefined; method: string | undefined }[] {
  const calls: { headers: Record<string, string> | undefined; method: string | undefined }[] = [];
  (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
    calls.push({ headers: init?.headers as Record<string, string> | undefined, method: init?.method });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return calls;
}

describe("subscriber lease requests carry the bearer token", () => {
  it("pingLease sends Authorization: Bearer <token> on a POST", async () => {
    store.set(TOKEN_KEY, "tok-ping-abc");
    const calls = captureFetch();
    await pingLease("sid-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers?.Authorization).toBe("Bearer tok-ping-abc");
  });

  it("deleteLease sends Authorization: Bearer <token> on a DELETE", async () => {
    store.set(TOKEN_KEY, "tok-delete-xyz");
    const calls = captureFetch();
    await deleteLease("sid-2");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.headers?.Authorization).toBe("Bearer tok-delete-xyz");
  });

  it("authHeaders is empty (never 'Bearer null') when no token is stored", () => {
    store.clear();
    expect(authHeaders()).toEqual({});
  });
});

describe("withGroupsRetention", () => {
  const point = (ts: number, groupCpu: number) => ({
    ts,
    system: {} as any,
    groups: { "root:1": { cpu: groupCpu, ramMB: 10 } },
  });

  it("strips groups from every point older than the retention window", () => {
    const history = Array.from({ length: 65 }, (_, i) => point(i, i));
    const result = withGroupsRetention(history, 60);
    // First 5 (65 - 60) stripped, last 60 keep their groups.
    for (let i = 0; i < 5; i++) expect(Object.keys(result[i]!.groups)).toHaveLength(0);
    for (let i = 5; i < 65; i++) expect(Object.keys(result[i]!.groups)).toHaveLength(1);
  });

  it("leaves system aggregates untouched — only groups are stripped", () => {
    const history = [{ ts: 1, system: { cpu: { total: 42 } } as any, groups: { a: { cpu: 1, ramMB: 1 } } }];
    const result = withGroupsRetention(history, 0);
    expect(result[0]!.groups).toEqual({});
    expect((result[0]!.system as any).cpu.total).toBe(42);
  });

  it("is a no-op (same reference) when the window already fits within retention", () => {
    const history = Array.from({ length: 10 }, (_, i) => point(i, i));
    const result = withGroupsRetention(history, 60);
    expect(result).toBe(history);
  });

  it("is a no-op (same reference) when already-stripped points have nothing left to strip", () => {
    const history = [
      { ts: 1, system: {} as any, groups: {} },
      point(2, 5),
    ];
    const result = withGroupsRetention(history, 1);
    expect(result).toBe(history);
  });
});
