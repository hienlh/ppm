/**
 * The shared session-list store, exercised through its in-memory IndexedDB
 * fallback — `bun:test` provides no `indexedDB` (see idb-keyval-cache.test.ts)
 * — and a stubbed `api.get`, so no real network or DOM is needed.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { api } from "../../../src/web/lib/api-client";
import { projectCacheId, sessions as sessionsKey } from "../../../src/web/lib/browser-cache/cache-keys";
import { idbGet, idbSet } from "../../../src/web/lib/browser-cache/idb-keyval-cache";
import { useSessionListStore, commitOptimistic, __clearInFlightForTest } from "../../../src/web/stores/session-list-store";
import type { SessionListResponse } from "../../../src/types/chat";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  __clearInFlightForTest();
});

function sessionsResponse(sessions: SessionListResponse["sessions"], hasMore = false): SessionListResponse {
  return { sessions, hasMore };
}

function tagsResponse() {
  return { tags: [], counts: {}, defaultTagId: null };
}

describe("session-list-store — sync", () => {
  it("has no indexedDB in this test environment (the scenario under test)", () => {
    expect(typeof indexedDB).toBe("undefined");
  });

  it("fetches sessions + tags and writes both through to IndexedDB", async () => {
    const project = { name: "sync-proj", path: "/sync-proj" };
    const spy = spyOn(api, "get").mockImplementation((async (url: string) =>
      url.includes("/tags") ? tagsResponse() : sessionsResponse([{ id: "s1", providerId: "claude", title: "Hello", createdAt: "2026-01-01T00:00:00.000Z" }])
    ) as typeof api.get);
    restore = () => spy.mockRestore();

    await useSessionListStore.getState().sync(project);

    const id = projectCacheId(project);
    const state = useSessionListStore.getState().byProject[id];
    expect(state?.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(state?.isSyncing).toBe(false);
    expect(state?.lastSyncError).toBeNull();
    expect(state?.lastSyncedAt).not.toBeNull();

    const cached = await idbGet<{ sessions: unknown[] }>(sessionsKey(id));
    expect(cached?.sessions).toHaveLength(1);
  });

  it("dedupes concurrent sync calls for the same project into one request", async () => {
    const project = { name: "dedupe-proj", path: "/dedupe-proj" };
    const spy = spyOn(api, "get").mockImplementation((async (url: string) =>
      url.includes("/tags") ? tagsResponse() : sessionsResponse([])
    ) as typeof api.get);
    restore = () => spy.mockRestore();

    const first = useSessionListStore.getState().sync(project);
    const second = useSessionListStore.getState().sync(project);
    await Promise.all([first, second]);

    expect(spy.mock.calls.filter(([url]) => String(url).includes("/chat/sessions"))).toHaveLength(1);
  });

  it("keeps the cached rows and records lastSyncError when the request fails", async () => {
    const project = { name: "fail-proj", path: "/fail-proj" };
    const id = projectCacheId(project);
    await idbSet(sessionsKey(id), { sessions: [{ id: "cached", providerId: "claude", title: "Cached", createdAt: "2026-01-01T00:00:00.000Z" }], hasMore: false });

    // Mocked before the first call — `ensure` must never reach the real
    // network in a suite run alongside other files.
    const spy = spyOn(api, "get").mockImplementation((async () => { throw new Error("offline"); }) as typeof api.get);
    restore = () => spy.mockRestore();

    await useSessionListStore.getState().ensure(project); // hydrates, then sync() fails

    const state = useSessionListStore.getState().byProject[id];
    expect(state?.sessions.map((s) => s.id)).toEqual(["cached"]);
    expect(state?.lastSyncError).toBe("offline");
    expect(state?.isSyncing).toBe(false);
  });

  it("ensure hydrates the cached row before its own sync overwrites it", async () => {
    const project = { name: "hydrate-proj", path: "/hydrate-proj" };
    const id = projectCacheId(project);
    await idbSet(sessionsKey(id), { sessions: [{ id: "cached", providerId: "claude", title: "Cached", createdAt: "2026-01-01T00:00:00.000Z" }], hasMore: false });

    let resolveSessions!: (v: SessionListResponse) => void;
    const pending = new Promise<SessionListResponse>((resolve) => { resolveSessions = resolve; });
    const spy = spyOn(api, "get").mockImplementation(((url: string) =>
      url.includes("/tags") ? Promise.resolve(tagsResponse()) : pending
    ) as typeof api.get);
    restore = () => spy.mockRestore();

    const ensurePromise = useSessionListStore.getState().ensure(project);
    // Let the hydration microtask chain (idbGet → set state) land before the
    // network response arrives — this is the "cache paints first" contract.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(useSessionListStore.getState().byProject[id]?.sessions.map((s) => s.id)).toEqual(["cached"]);

    resolveSessions(sessionsResponse([{ id: "fresh", providerId: "claude", title: "Fresh", createdAt: "2026-01-02T00:00:00.000Z" }]));
    await ensurePromise;
    expect(useSessionListStore.getState().byProject[id]?.sessions.map((s) => s.id)).toEqual(["fresh"]);
  });
});

describe("session-list-store — optimistic patches", () => {
  const project = { name: "mutate-proj", path: "/mutate-proj" };

  it("upsertSession inserts, and every mutation writes through to IndexedDB", async () => {
    useSessionListStore.getState().upsertSession(project, {
      id: "a", providerId: "claude", title: "First", createdAt: "2026-01-01T00:00:00.000Z",
    });
    const id = projectCacheId(project);
    expect(useSessionListStore.getState().byProject[id]?.sessions.map((s) => s.id)).toEqual(["a"]);
    await Promise.resolve(); // idbSet fire-and-forget
    const cached = await idbGet<{ sessions: { id: string }[] }>(sessionsKey(id));
    expect(cached?.sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("renameSession, setPinned and setSessionTag patch only the matching row", () => {
    const id = projectCacheId(project);
    useSessionListStore.getState().renameSession(project, "a", "Renamed");
    useSessionListStore.getState().setPinned(project, "a", true);
    useSessionListStore.getState().setSessionTag(project, "a", { id: 1, name: "work", color: "#fff" });
    const row = useSessionListStore.getState().byProject[id]?.sessions.find((s) => s.id === "a");
    expect(row?.title).toBe("Renamed");
    expect(row?.pinned).toBe(true);
    expect(row?.tag).toEqual({ id: 1, name: "work", color: "#fff" });
  });

  it("replaceSessionId follows a provider-adopted id", () => {
    const id = projectCacheId(project);
    useSessionListStore.getState().replaceSessionId(project, "a", "a-real");
    const ids = useSessionListStore.getState().byProject[id]?.sessions.map((s) => s.id);
    expect(ids).toEqual(["a-real"]);
  });

  it("removeSession drops the row", () => {
    const id = projectCacheId(project);
    useSessionListStore.getState().removeSession(project, "a-real");
    expect(useSessionListStore.getState().byProject[id]?.sessions).toEqual([]);
  });

  it("onTagDeleted clears the tag from cached rows carrying it", () => {
    const id = projectCacheId(project);
    useSessionListStore.getState().upsertSession(project, {
      id: "b", providerId: "claude", title: "B", createdAt: "2026-01-01T00:00:00.000Z",
      tag: { id: 9, name: "gone", color: "#000" },
    });
    useSessionListStore.getState().onTagDeleted(project, 9);
    expect(useSessionListStore.getState().byProject[id]?.sessions.find((s) => s.id === "b")?.tag).toBeNull();
  });

  it("removeOlderThan drops unpinned rows past the cutoff", () => {
    const id = projectCacheId(project);
    useSessionListStore.getState().upsertSession(project, {
      id: "old", providerId: "claude", title: "Old", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    });
    useSessionListStore.getState().removeOlderThan(project, 30);
    expect(useSessionListStore.getState().byProject[id]?.sessions.find((s) => s.id === "old")).toBeUndefined();
  });
});

describe("session-list-store — tags", () => {
  it("seedTags writes state + IndexedDB without a network call", async () => {
    const project = { name: "seed-proj", path: "/seed-proj" };
    const spy = spyOn(api, "get").mockResolvedValue(tagsResponse());
    restore = () => spy.mockRestore();
    const tags = { tags: [{ id: 1, projectPath: "/seed-proj", name: "work", color: "#fff", sortOrder: 0 }], counts: { 1: 2 }, defaultTagId: 1 };
    useSessionListStore.getState().seedTags(project, tags);
    expect(spy).not.toHaveBeenCalled();
    const id = projectCacheId(project);
    expect(useSessionListStore.getState().byProject[id]?.tags).toEqual(tags);
  });

  it("refreshTags re-fetches and patches state", async () => {
    const project = { name: "refresh-proj", path: "/refresh-proj" };
    const fresh = { tags: [{ id: 2, projectPath: "/refresh-proj", name: "urgent", color: "#f00", sortOrder: 0 }], counts: {}, defaultTagId: null };
    const spy = spyOn(api, "get").mockResolvedValue(fresh);
    restore = () => spy.mockRestore();
    await useSessionListStore.getState().refreshTags(project);
    const id = projectCacheId(project);
    expect(useSessionListStore.getState().byProject[id]?.tags).toEqual(fresh);
  });
});

describe("session-list-store — commitOptimistic", () => {
  const row = (title: string) => ({ id: "opt-1", providerId: "claude", title, createdAt: "2026-01-01T00:00:00.000Z" });

  it("keeps the optimistic change and does not re-sync when the request succeeds", async () => {
    const project = { name: "opt-ok", path: "/opt-ok" };
    const get = spyOn(api, "get");
    restore = () => get.mockRestore();
    const store = useSessionListStore.getState();
    store.upsertSession(project, row("Before"));

    // Applied before the request goes out — every list shows it immediately.
    store.renameSession(project, "opt-1", "After");
    expect(useSessionListStore.getState().byProject[projectCacheId(project)]?.sessions[0]?.title).toBe("After");

    expect(await commitOptimistic(project, () => Promise.resolve({}))).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(useSessionListStore.getState().byProject[projectCacheId(project)]?.sessions[0]?.title).toBe("After");
  });

  it("rolls a refused change back by re-syncing from the server", async () => {
    const project = { name: "opt-fail", path: "/opt-fail" };
    const get = spyOn(api, "get").mockImplementation((async (url: string) =>
      url.includes("/tags") ? tagsResponse() : sessionsResponse([row("Before")])
    ) as typeof api.get);
    restore = () => get.mockRestore();
    const store = useSessionListStore.getState();
    store.upsertSession(project, row("Before"));
    store.renameSession(project, "opt-1", "After");

    expect(await commitOptimistic(project, () => Promise.reject(new Error("HTTP 500")))).toBe(false);
    // The rollback sync is already in flight; wait for it like any other sync.
    await useSessionListStore.getState().sync(project);
    expect(useSessionListStore.getState().byProject[projectCacheId(project)]?.sessions[0]?.title).toBe("Before");
    expect(get.mock.calls.some(([url]) => String(url).includes("/chat/sessions"))).toBe(true);
  });

  it("never rejects, even when the rollback sync itself fails", async () => {
    const project = { name: "opt-offline", path: "/opt-offline" };
    const get = spyOn(api, "get").mockRejectedValue(new Error("offline"));
    restore = () => get.mockRestore();
    expect(await commitOptimistic(project, () => Promise.reject(new Error("offline")))).toBe(false);
    await useSessionListStore.getState().sync(project);
    expect(useSessionListStore.getState().byProject[projectCacheId(project)]?.lastSyncError).toBe("offline");
  });
});
