import { describe, expect, it } from "bun:test";
import { compareSessionsByActivity, type SessionInfo } from "../../../src/types/chat.ts";

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "session",
    providerId: "mock",
    title: "Chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("compareSessionsByActivity", () => {
  it("orders by update time, with creation time as the legacy fallback", () => {
    const oldButActive = session({ id: "old", updatedAt: "2026-02-03T00:00:00.000Z" });
    const newerButIdle = session({ id: "new", createdAt: "2026-02-02T00:00:00.000Z" });

    expect([newerButIdle, oldButActive].sort(compareSessionsByActivity).map((item) => item.id))
      .toEqual(["old", "new"]);
  });

  it("keeps pinned conversations ahead of newer unpinned ones", () => {
    const pinned = session({ id: "pinned", pinned: true, updatedAt: "2026-01-02T00:00:00.000Z" });
    const active = session({ id: "active", updatedAt: "2026-02-03T00:00:00.000Z" });

    expect([active, pinned].sort(compareSessionsByActivity).map((item) => item.id))
      .toEqual(["pinned", "active"]);
  });
});
