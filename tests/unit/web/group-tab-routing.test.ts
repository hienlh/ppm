// Run in Docker (host Bun segfaults on `bun test`):
//   docker compose -f docker-compose.test.yml run --rm test bun test tests/unit/web/group-tab-routing.test.ts
import { describe, it, expect } from "bun:test";
import { deriveTabId } from "../../../src/web/stores/panel-utils.ts";
import { buildUrl, tabIdFromUrl } from "../../../src/web/hooks/use-url-sync.ts";

describe("group tab routing", () => {
  it("deriveTabId builds deterministic group:<id>", () => {
    expect(deriveTabId("group", { groupId: "abc-123" })).toBe("group:abc-123");
  });

  it("deriveTabId falls back when groupId missing", () => {
    expect(deriveTabId("group", {})).toBe("group:unknown");
  });

  it("buildUrl → tabIdFromUrl round-trips a group tab", () => {
    const tabId = deriveTabId("group", { groupId: "abc-123" });
    const url = buildUrl("proj", tabId);
    expect(url).toBe("/project/proj/group/abc-123");
    // Reconstruct the identifier the parser would extract (after /group/).
    expect(tabIdFromUrl("group", "abc-123")).toBe("group:abc-123");
  });

  it("panel-suffixed group tab id strips @panel in URL", () => {
    expect(buildUrl("proj", "group:abc-123@panel-9")).toBe("/project/proj/group/abc-123");
  });
});
