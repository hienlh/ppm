import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { api } from "../../../src/web/lib/api-client";
import {
  clearSlashItemsCache, fetchSlashItems, getCachedSlashItems, subscribeSlashItems,
  registerPendingSlash, seedSlashItems, SLASH_ITEMS_TTL_MS,
} from "../../../src/web/lib/slash-items-cache";
import { hydrateProjectCache } from "../../../src/web/lib/browser-cache/project-cache-hydration";
import { projectCacheId, slash as slashKey } from "../../../src/web/lib/browser-cache/cache-keys";
import { SCHEMA_VERSION, __setRawEnvelopeForTest } from "../../../src/web/lib/browser-cache/idb-keyval-cache";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  clearSlashItemsCache();
});

it("shares requests, then discovers newly installed skills after cache expiry", async () => {
  let now = 1000;
  spies.push(spyOn(Date, "now").mockImplementation(() => now));
  const get = spyOn(api, "get").mockResolvedValue({ items: [], recentNames: [] });
  spies.push(get);
  const first = fetchSlashItems("ppm", "codex", "session");
  expect(fetchSlashItems("ppm", "codex", "session")).toBe(first);
  await first;
  get.mockResolvedValue({ items: [{ type: "skill", name: "ak-cook", description: "Cook" }], recentNames: [] });
  now += SLASH_ITEMS_TTL_MS + 1;
  expect((await fetchSlashItems("ppm", "codex", "session")).items[0]?.name).toBe("ak-cook");
  expect(get).toHaveBeenCalledTimes(2);
});

it("shares across sessions and exposes provider skills immediately in another project", async () => {
  const get = spyOn(api, "get").mockResolvedValue({ items: [
    { type: "skill", name: "global", scope: "user" },
    { type: "skill", name: "local", scope: "project" },
  ], recentNames: ["local"] });
  spies.push(get);
  await fetchSlashItems("one", "codex", "a");
  await fetchSlashItems("one", "codex", "b");
  expect(get).toHaveBeenCalledTimes(1);
  expect(getCachedSlashItems("two", "codex")?.items.map(i => i.name)).toEqual(["global"]);
  expect(getCachedSlashItems("two", "codex")?.recentNames).toEqual([]);
  expect(getCachedSlashItems("two", "claude")).toBeUndefined();
});

it("manual refresh shares a request and a failed refresh preserves the catalog", async () => {
  const get = spyOn(api, "get").mockResolvedValue({ items: [{ name: "kept", type: "skill" }], recentNames: [] });
  spies.push(get);
  await fetchSlashItems("one", "claude");
  clearSlashItemsCache("one");
  get.mockRejectedValue(new Error("offline"));
  const refresh = fetchSlashItems("one", "claude", "a");
  expect(fetchSlashItems("one", "claude", "b")).toBe(refresh);
  await expect(refresh).rejects.toThrow("offline");
  expect(getCachedSlashItems("one", "claude")?.items[0]?.name).toBe("kept");
});

it("seedSlashItems sets the data, the provider-wide entry, and notifies subscribers", () => {
  const notified = mock(() => {});
  const unsubscribe = subscribeSlashItems(notified);
  seedSlashItems({ name: "seed-proj", path: "/seed-proj" }, "codex", {
    items: [{ type: "skill", name: "seeded", description: "", scope: "project" },
      { type: "skill", name: "global", description: "", scope: "user" }],
    recentNames: ["seeded"],
  });
  expect(notified).toHaveBeenCalledTimes(1);
  expect(getCachedSlashItems("seed-proj", "codex")?.items.map((i) => i.name)).toEqual(["seeded", "global"]);
  // Provider-wide entry drops project-scoped items, same as a real fetch's settle path.
  expect(getCachedSlashItems("other-proj", "codex")?.items.map((i) => i.name)).toEqual(["global"]);
  unsubscribe();
});

it("registerPendingSlash makes a concurrent fetchSlashItems join it instead of firing its own GET", async () => {
  const get = spyOn(api, "get").mockResolvedValue({ items: [{ type: "skill", name: "network" }], recentNames: [] });
  registerPendingSlash("pending-proj", "claude",
    Promise.resolve({ items: [{ type: "skill", name: "from-prepare", description: "" }], recentNames: [] }));
  expect((await fetchSlashItems("pending-proj", "claude")).items[0]?.name).toBe("from-prepare");
  expect(get).not.toHaveBeenCalled();
  get.mockRestore();
});

it("registerPendingSlash falls back to a real GET when prepare's slash part came back null", async () => {
  const get = spyOn(api, "get").mockResolvedValue({ items: [{ type: "skill", name: "from-network" }], recentNames: [] });
  registerPendingSlash("pending-null-proj", "claude", Promise.resolve(null));
  expect((await fetchSlashItems("pending-null-proj", "claude")).items[0]?.name).toBe("from-network");
  expect(get).toHaveBeenCalledTimes(1);
  get.mockRestore();
});

const cachedPayload = (name: string) => ({ items: [{ type: "skill", name, description: "" }], recentNames: [] });
function storeInIdb(project: { name: string; path: string }, at: number, name: string) {
  __setRawEnvelopeForTest(slashKey(projectCacheId(project), "claude"), { v: SCHEMA_VERSION, at, data: cachedPayload(name) });
}

it("shows a list hydrated from IndexedDB but keeps its stored age, so an old one is refreshed", async () => {
  const project = { name: "hydrate-old", path: "/hydrate-old" };
  storeInIdb(project, Date.now() - SLASH_ITEMS_TTL_MS - 1, "from-idb");
  await hydrateProjectCache(project);
  expect(getCachedSlashItems(project.name, "claude")?.items[0]?.name).toBe("from-idb");

  const get = spyOn(api, "get").mockResolvedValue(cachedPayload("from-network"));
  spies.push(get);
  expect((await fetchSlashItems(project.name, "claude")).items[0]?.name).toBe("from-network");
  expect(get).toHaveBeenCalledTimes(1);
});

it("trusts a recently stored list until its own expiry", async () => {
  const project = { name: "hydrate-fresh", path: "/hydrate-fresh" };
  storeInIdb(project, Date.now() - 1000, "fresh-idb");
  await hydrateProjectCache(project);
  const get = spyOn(api, "get").mockResolvedValue(cachedPayload("from-network"));
  spies.push(get);
  expect((await fetchSlashItems(project.name, "claude")).items[0]?.name).toBe("fresh-idb");
  expect(get).not.toHaveBeenCalled();
});

it("fills an entry that only has a request in flight, then lets that request's answer win", async () => {
  const project = { name: "hydrate-race", path: "/hydrate-race" };
  storeInIdb(project, Date.now() - 1000, "from-idb");
  let answer!: (value: ReturnType<typeof cachedPayload>) => void;
  // The tab mounted (and registered its prepare) before the IndexedDB read landed.
  registerPendingSlash(project.name, "claude", new Promise((resolve) => { answer = resolve; }));
  const notified = mock(() => {});
  const unsubscribe = subscribeSlashItems(notified);
  await hydrateProjectCache(project);
  expect(getCachedSlashItems(project.name, "claude")?.items[0]?.name).toBe("from-idb");
  expect(notified).toHaveBeenCalledTimes(1);

  answer(cachedPayload("from-prepare"));
  await fetchSlashItems(project.name, "claude");
  expect(getCachedSlashItems(project.name, "claude")?.items[0]?.name).toBe("from-prepare");
  unsubscribe();
});

it("never replaces data that already landed with the IndexedDB copy", async () => {
  const project = { name: "hydrate-late", path: "/hydrate-late" };
  storeInIdb(project, Date.now(), "stale-idb");
  seedSlashItems(project, "claude", cachedPayload("seeded"));
  await hydrateProjectCache(project);
  expect(getCachedSlashItems(project.name, "claude")?.items[0]?.name).toBe("seeded");
});

it("registerPendingSlash is a no-op once real data already claims the key", async () => {
  const get = spyOn(api, "get").mockResolvedValue({ items: [{ type: "skill", name: "real" }], recentNames: [] });
  await fetchSlashItems("already-real-proj", "claude");
  registerPendingSlash("already-real-proj", "claude",
    Promise.resolve({ items: [{ type: "skill", name: "ignored", description: "" }], recentNames: [] }));
  expect(getCachedSlashItems("already-real-proj", "claude")?.items[0]?.name).toBe("real");
  get.mockRestore();
});
