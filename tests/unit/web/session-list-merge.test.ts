import { describe, expect, it } from "bun:test";
import {
  sortSessions, dedupeById, upsertSession, removeSession, renameSession,
  replaceSessionId, setPinned, setSessionTag, clearDeletedTag, removeOlderThan,
} from "../../../src/web/lib/session-list-merge";
import type { SessionInfo } from "../../../src/types/chat";

function s(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, providerId: "claude", title: id, createdAt: "2026-01-01T00:00:00.000Z", ...over };
}

describe("sortSessions", () => {
  it("puts pinned first, then most recently active", () => {
    const list = [
      s("old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      s("pinned-old", { pinned: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
      s("new", { updatedAt: "2026-01-03T00:00:00.000Z" }),
    ];
    expect(sortSessions(list).map((x) => x.id)).toEqual(["pinned-old", "new", "old"]);
  });

  it("does not mutate the input array", () => {
    const list = [s("b"), s("a")];
    const out = sortSessions(list);
    expect(out).not.toBe(list);
  });
});

describe("dedupeById", () => {
  it("keeps only the first occurrence of each id", () => {
    const out = dedupeById([s("a"), s("b"), s("a", { title: "second a" })]);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
    expect(out[0]!.title).toBe("a");
  });
});

describe("upsertSession", () => {
  it("inserts a new session and sorts it in", () => {
    const out = upsertSession([s("existing")], s("new", { updatedAt: "2026-02-01T00:00:00.000Z" }));
    expect(out.map((x) => x.id)).toEqual(["new", "existing"]);
  });

  it("replaces an existing session by id, merging fields", () => {
    const out = upsertSession([s("a", { title: "old title" })], s("a", { title: "new title" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("new title");
  });
});

describe("removeSession / renameSession", () => {
  it("removes by id", () => {
    expect(removeSession([s("a"), s("b")], "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("renames the matching row only", () => {
    const out = renameSession([s("a", { title: "old" }), s("b", { title: "keep" })], "a", "new");
    expect(out.find((x) => x.id === "a")!.title).toBe("new");
    expect(out.find((x) => x.id === "b")!.title).toBe("keep");
  });
});

describe("replaceSessionId", () => {
  it("swaps the id of the matching row", () => {
    const out = replaceSessionId([s("temp-uuid"), s("other")], "temp-uuid", "real-id");
    expect(out.map((x) => x.id).sort()).toEqual(["other", "real-id"]);
  });

  it("is a no-op when the ids are identical", () => {
    const list = [s("a")];
    expect(replaceSessionId(list, "a", "a")).toBe(list);
  });

  it("drops the stale row when the new id already exists (double-migrate race)", () => {
    const out = replaceSessionId([s("temp"), s("real", { title: "canonical" })], "temp", "real");
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("canonical");
  });
});

describe("setPinned", () => {
  it("sets the flag and resorts", () => {
    const out = setPinned([s("a", { updatedAt: "2026-01-01T00:00:00.000Z" }), s("b", { updatedAt: "2026-01-02T00:00:00.000Z" })], "a", true);
    expect(out[0]!.id).toBe("a");
    expect(out[0]!.pinned).toBe(true);
  });
});

describe("setSessionTag / clearDeletedTag", () => {
  it("sets a tag on the matching row", () => {
    const tag = { id: 1, name: "work", color: "#fff" };
    const out = setSessionTag([s("a")], "a", tag);
    expect(out[0]!.tag).toEqual(tag);
  });

  it("clears only rows carrying the deleted tag id", () => {
    const kept = { id: 2, name: "other", color: "#000" };
    const out = clearDeletedTag(
      [s("a", { tag: { id: 1, name: "gone", color: "#fff" } }), s("b", { tag: kept })],
      1,
    );
    expect(out.find((x) => x.id === "a")!.tag).toBeNull();
    expect(out.find((x) => x.id === "b")!.tag).toEqual(kept);
  });
});

describe("removeOlderThan", () => {
  const now = Date.parse("2026-03-01T00:00:00.000Z");

  it("drops unpinned rows past the cutoff, keeps recent and pinned ones", () => {
    const out = removeOlderThan(
      [
        s("recent", { updatedAt: "2026-02-28T00:00:00.000Z" }),
        s("old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        s("old-pinned", { pinned: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      30,
      now,
    );
    expect(out.map((x) => x.id).sort()).toEqual(["old-pinned", "recent"]);
  });
});
