import { afterEach, expect, it, spyOn } from "bun:test";
import { api } from "../../../src/web/lib/api-client";
import { clearSlashItemsCache, fetchSlashItems, getCachedSlashItems, SLASH_ITEMS_TTL_MS } from "../../../src/web/lib/slash-items-cache";

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
