import { describe, expect, test } from "bun:test";
import { buildSessionTree, descendantsOf } from "../../../src/web/lib/session-tree";
import type { SessionInfo } from "../../../src/types/chat";

const s = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, providerId: "claude", title: id, createdAt: "2026-11-10T00:00:00Z", ...extra });

describe("buildSessionTree", () => {
  test("a person's chats stay a flat list in their order", () => {
    const roots = buildSessionTree([s("a"), s("b"), s("c")]);
    expect(roots.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  test("task chats sit under the spec's chat, and the family takes its newest member's place", () => {
    // Tasks are newer than the spec chat, which another chat outranks.
    const roots = buildSessionTree([
      s("t2", { spawnedBy: "spec" }), s("other"), s("t1", { spawnedBy: "spec" }), s("spec"),
    ]);
    expect(roots.map((r) => r.id)).toEqual(["spec", "other"]);
    expect(roots[0]!.session?.id).toBe("spec");
    expect(roots[0]!.children.map((n) => n.session.id)).toEqual(["t2", "t1"]);
  });

  test("grandchildren nest under their own parent", () => {
    const roots = buildSessionTree([s("gc", { spawnedBy: "c" }), s("c", { spawnedBy: "p" }), s("p")]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children[0]!.session.id).toBe("c");
    expect(roots[0]!.children[0]!.children[0]!.session.id).toBe("gc");
    expect(descendantsOf(roots[0]!.children).map((x) => x.id)).toEqual(["c", "gc"]);
  });

  test("children whose creator is not in the list are grouped under a stand-in named by parentTitle", () => {
    const roots = buildSessionTree([
      s("a"), s("t1", { spawnedBy: "gone", parentTitle: "Big spec" }), s("t2", { spawnedBy: "gone", parentTitle: "Big spec" }),
    ]);
    expect(roots.map((r) => r.id)).toEqual(["a", "gone"]);
    expect(roots[1]!.session).toBeNull();
    expect(roots[1]!.parentTitle).toBe("Big spec");
    expect(roots[1]!.children.map((n) => n.session.id)).toEqual(["t1", "t2"]);
  });

  test("a pinned child stays on its own row", () => {
    const roots = buildSessionTree([s("t1", { spawnedBy: "p", pinned: true }), s("p")]);
    expect(roots.map((r) => r.id)).toEqual(["t1", "p"]);
    expect(roots[1]!.children).toHaveLength(0);
  });

  test("a loop in the data does not hang or drop sessions", () => {
    const roots = buildSessionTree([s("a", { spawnedBy: "b" }), s("b", { spawnedBy: "a" })]);
    expect(descendantsOf(roots.map((r) => ({ session: r.session!, children: r.children }))).map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
});
