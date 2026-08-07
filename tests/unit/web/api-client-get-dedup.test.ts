/**
 * In-flight GET sharing in ApiClient.
 *
 * Several components request the same project-scoped data when a chat tab mounts —
 * measured 4 identical `providers/claude/models` and 4 `chat/sessions` requests
 * within 2ms on a single tab open. This shares the in-flight promise.
 *
 * The property that must hold: sharing is ONLY for requests still in flight. Once
 * one settles its entry is dropped, so this can never serve a stale response.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// api-client touches localStorage at call time; stub before importing it.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { api } = await import("../../../src/web/lib/api-client");

const realFetch = globalThis.fetch;
let calls: string[] = [];
/** Resolvers for pending stub responses, so tests control settle timing. */
let release: Array<() => void> = [];

function stubFetch(payload: unknown, opts?: { manual?: boolean }) {
  (globalThis as any).fetch = (url: string) => {
    calls.push(String(url));
    const respond = () =>
      new Response(JSON.stringify({ ok: true, data: payload }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (!opts?.manual) return Promise.resolve(respond());
    return new Promise<Response>((res) => release.push(() => res(respond())));
  };
}

beforeEach(() => {
  calls = [];
  release = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ApiClient.get — in-flight sharing", () => {
  it("issues ONE request for concurrent identical GETs", async () => {
    stubFetch([{ id: "m1" }], { manual: true });

    const all = Promise.all([
      api.get("/api/project/p/chat/providers/claude/models"),
      api.get("/api/project/p/chat/providers/claude/models"),
      api.get("/api/project/p/chat/providers/claude/models"),
      api.get("/api/project/p/chat/providers/claude/models"),
    ]);
    release.forEach((r) => r());
    const results = await all;

    expect(calls).toHaveLength(1);
    // Every caller still gets the payload.
    for (const r of results) expect(r).toEqual([{ id: "m1" }]);
  });

  it("does NOT share across different paths", async () => {
    stubFetch([], { manual: true });
    const all = Promise.all([api.get("/api/a"), api.get("/api/b"), api.get("/api/c")]);
    release.forEach((r) => r());
    await all;
    expect(calls).toHaveLength(3);
  });

  it("refetches after the first settles — this is not a response cache", async () => {
    stubFetch({ v: 1 });
    await api.get("/api/project/p/tags");
    await api.get("/api/project/p/tags");
    await api.get("/api/project/p/tags");
    expect(calls).toHaveLength(3);
  });

  it("drops the entry on failure so the next caller retries", async () => {
    let n = 0;
    (globalThis as any).fetch = (url: string) => {
      calls.push(String(url));
      n++;
      if (n === 1) return Promise.reject(new Error("network down"));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, data: "recovered" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    await expect(api.get("/api/flaky")).rejects.toThrow("network down");
    expect(await api.get("/api/flaky")).toBe("recovered");
    expect(calls).toHaveLength(2);
  });

  it("concurrent callers all reject when the shared request fails", async () => {
    (globalThis as any).fetch = (url: string) => {
      calls.push(String(url));
      return Promise.reject(new Error("boom"));
    };

    const a = api.get("/api/shared-fail");
    const b = api.get("/api/shared-fail");
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    expect(calls).toHaveLength(1);
  });

  it("opts out when an AbortSignal is passed, so one abort cannot cancel another caller", async () => {
    stubFetch([], { manual: true });
    const ac = new AbortController();

    const all = Promise.all([
      api.get("/api/abortable", { signal: ac.signal }),
      api.get("/api/abortable", { signal: new AbortController().signal }),
    ]);
    release.forEach((r) => r());
    await all;

    expect(calls).toHaveLength(2);
  });
});
