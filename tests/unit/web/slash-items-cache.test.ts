import { afterEach, expect, it, spyOn } from "bun:test";
import { api } from "../../../src/web/lib/api-client";
import { clearSlashItemsCache, fetchSlashItems } from "../../../src/web/lib/slash-items-cache";

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
  now += 60_001;
  expect((await fetchSlashItems("ppm", "codex", "session")).items[0]?.name).toBe("ak-cook");
  expect(get).toHaveBeenCalledTimes(2);
});
