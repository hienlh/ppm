/**
 * Every history surface sorts the same way: the project's manager chat first, then pinned chats,
 * then the most recently active. The browser's bulk-delete approximation keeps the manager too.
 */
import { describe, expect, it } from "bun:test";
import { compareSessionsByActivity, type SessionInfo } from "../../../src/types/chat.ts";
import { removeOlderThan, sortSessions } from "../../../src/web/lib/session-list-merge.ts";

const at = (id: string, updatedAt: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, providerId: "claude", title: id, createdAt: "2026-01-01T00:00:00Z", updatedAt, ...extra });

describe("session order", () => {
  it("puts the manager before pinned chats and pinned chats before activity", () => {
    const list = [
      at("recent", "2026-11-10T09:00:00Z"),
      at("pinned", "2026-11-01T00:00:00Z", { pinned: true }),
      at("manager", "2026-10-01T00:00:00Z", { manager: true }),
      at("older", "2026-11-05T00:00:00Z"),
    ];
    expect([...list].sort(compareSessionsByActivity).map((s) => s.id)).toEqual(["manager", "pinned", "recent", "older"]);
    expect(sortSessions(list).map((s) => s.id)).toEqual(["manager", "pinned", "recent", "older"]);
  });

  it("orders a pinned manager like any manager", () => {
    const a = at("a", "2026-11-01T00:00:00Z", { manager: true, pinned: true });
    const b = at("b", "2026-11-09T00:00:00Z", { pinned: true });
    expect(compareSessionsByActivity(a, b)).toBeLessThan(0);
  });

  it("keeps the manager through the browser's bulk-delete approximation", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    const kept = removeOlderThan([at("manager", "2026-01-01T00:00:00Z", { manager: true }), at("old", "2026-01-01T00:00:00Z")], 30, now);
    expect(kept.map((s) => s.id)).toEqual(["manager"]);
  });
});
