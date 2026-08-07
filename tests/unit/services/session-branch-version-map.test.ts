/**
 * Equivalence contract for resolveVersionMap vs resolveVersionGroup.
 *
 * resolveVersionMap batches what resolveVersionGroup answers one ordinal at a
 * time (the per-ordinal path cost up to 100 sequential DB queries and was called
 * once per rendered user message). The batch version is only safe if it returns
 * exactly the same group for every ordinal, from every node in the tree — that
 * is what this file locks down. Written before the implementation on purpose.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import {
  recordBranch,
  resolveVersionGroup,
  resolveVersionMap,
} from "../../../src/services/session-branch.service.ts";

/** Insert a fork with a deterministic created_at so sibling order is stable. */
function fork(childId: string, parentId: string, ordinal: number, createdAt: string): void {
  recordBranch(childId, parentId, `msg-${childId}`, ordinal);
  getDb().run("UPDATE session_branches SET created_at = ? WHERE child_id = ?", [createdAt, childId]);
}

/**
 * Tree used by most cases:
 *
 *   root
 *    ├── childA   forked at ordinal 2   (t1)
 *    │    └── grandchild  forked at ordinal 5  (t3)
 *    └── childB   forked at ordinal 2   (t2)
 *   root
 *    └── childC   forked at ordinal 4   (t4)
 *
 * Gives: two siblings at one ordinal, a deeper fork under a child (so the
 * ancestor-walk branch is exercised), and a second unrelated ordinal.
 */
function buildTree(): void {
  fork("childA", "root", 2, "2026-01-01T00:00:01.000Z");
  fork("childB", "root", 2, "2026-01-01T00:00:02.000Z");
  fork("grandchild", "childA", 5, "2026-01-01T00:00:03.000Z");
  fork("childC", "root", 4, "2026-01-01T00:00:04.000Z");
}

const NODES = ["root", "childA", "childB", "grandchild", "childC"];
const ORDINALS = [1, 2, 3, 4, 5, 6, 7, 8];

beforeEach(() => {
  getDb().run("DELETE FROM session_branches");
});

describe("resolveVersionMap — equivalence with resolveVersionGroup", () => {
  it("matches resolveVersionGroup for every ordinal from every node in the tree", () => {
    buildTree();

    for (const node of NODES) {
      const map = resolveVersionMap(node);
      for (const ordinal of ORDINALS) {
        const single = resolveVersionGroup(node, ordinal);
        const batched = map[ordinal] ?? null;
        expect(batched).toEqual(single);
      }
    }
  });

  it("matches for a session with no branch rows at all (empty map)", () => {
    const map = resolveVersionMap("lonely-session");
    expect(map).toEqual({});
    for (const ordinal of ORDINALS) {
      expect(resolveVersionGroup("lonely-session", ordinal)).toBeNull();
    }
  });

  it("matches for a root whose only child forks at ordinal 1", () => {
    fork("only-child", "solo-root", 1, "2026-01-01T00:00:01.000Z");

    for (const node of ["solo-root", "only-child"]) {
      const map = resolveVersionMap(node);
      for (const ordinal of ORDINALS) {
        expect(map[ordinal] ?? null).toEqual(resolveVersionGroup(node, ordinal));
      }
    }
  });

  it("ignores legacy rows with a NULL fork_ordinal", () => {
    // Rows predating the fork_ordinal migration still exist in real databases.
    // SQL `fork_ordinal = NULL` never matches, so the per-ordinal function skips
    // them; the batch version must not emit a `null` key either.
    fork("legacy", "legacy-root", 2, "2026-01-01T00:00:01.000Z");
    getDb().run("UPDATE session_branches SET fork_ordinal = NULL WHERE child_id = 'legacy'");

    for (const node of ["legacy-root", "legacy"]) {
      const map = resolveVersionMap(node);
      expect(Object.keys(map)).toEqual([]);
      for (const ordinal of ORDINALS) {
        expect(map[ordinal] ?? null).toEqual(resolveVersionGroup(node, ordinal));
      }
    }
  });

  it("keeps valid ordinals when a NULL-ordinal row is present in the same tree", () => {
    fork("mixed-a", "mixed-root", 3, "2026-01-01T00:00:01.000Z");
    fork("mixed-b", "mixed-root", 3, "2026-01-01T00:00:02.000Z");
    fork("mixed-legacy", "mixed-root", 7, "2026-01-01T00:00:03.000Z");
    getDb().run("UPDATE session_branches SET fork_ordinal = NULL WHERE child_id = 'mixed-legacy'");

    const map = resolveVersionMap("mixed-root");
    expect(Object.keys(map)).toEqual(["3"]);
    expect(map[3]!.ids).toEqual(["mixed-root", "mixed-a", "mixed-b"]);
  });

  it("matches on a 4-level chain (deep ancestor walk)", () => {
    fork("l1", "deep-root", 2, "2026-01-01T00:00:01.000Z");
    fork("l2", "l1", 4, "2026-01-01T00:00:02.000Z");
    fork("l3", "l2", 6, "2026-01-01T00:00:03.000Z");
    // A sibling at the deepest fork so a real group exists there.
    fork("l3b", "l2", 6, "2026-01-01T00:00:04.000Z");

    for (const node of ["deep-root", "l1", "l2", "l3", "l3b"]) {
      const map = resolveVersionMap(node);
      for (const ordinal of ORDINALS) {
        expect(map[ordinal] ?? null).toEqual(resolveVersionGroup(node, ordinal));
      }
    }
  });
});

describe("resolveVersionMap — group content", () => {
  it("returns the parent first, then children oldest-first", () => {
    buildTree();
    const group = resolveVersionMap("root")[2];
    expect(group).toBeDefined();
    expect(group!.ids).toEqual(["root", "childA", "childB"]);
  });

  it("positions currentIndex by lineage — a grandchild counts as its ancestor", () => {
    buildTree();
    // grandchild descends from childA, so at ordinal 2 it occupies childA's slot.
    const fromGrandchild = resolveVersionMap("grandchild")[2];
    expect(fromGrandchild!.ids).toEqual(["root", "childA", "childB"]);
    expect(fromGrandchild!.currentIndex).toBe(1);
    // Cross-check the single-ordinal function agrees.
    expect(fromGrandchild).toEqual(resolveVersionGroup("grandchild", 2));
  });

  it("omits ordinals that have no fork (absence replaces the old HTTP 400 signal)", () => {
    buildTree();
    const map = resolveVersionMap("root");
    expect(map[1]).toBeUndefined();
    expect(map[3]).toBeUndefined();
    expect(map[2]).toBeDefined();
    expect(map[4]).toBeDefined();
  });

  it("includes a single-child ordinal (2 versions: original + one edit)", () => {
    buildTree();
    const group = resolveVersionMap("root")[4];
    expect(group!.ids).toEqual(["root", "childC"]);
    expect(group!.currentIndex).toBe(0);
  });
});

describe("resolveVersionMap — query cost", () => {
  it("issues a constant number of queries regardless of how many ordinals exist", () => {
    // 20 siblings across 10 distinct ordinals — the per-ordinal function would
    // walk the ancestor chain once per ordinal.
    for (let o = 1; o <= 10; o++) {
      fork(`c${o}a`, "wide-root", o, `2026-01-01T00:00:${String(o * 2).padStart(2, "0")}.000Z`);
      fork(`c${o}b`, "wide-root", o, `2026-01-01T00:00:${String(o * 2 + 1).padStart(2, "0")}.000Z`);
    }

    const db = getDb();
    const originalQuery = db.query.bind(db);
    let queries = 0;
    (db as unknown as { query: typeof originalQuery }).query = ((sql: string) => {
      queries++;
      return originalQuery(sql);
    }) as typeof originalQuery;

    try {
      const map = resolveVersionMap("wide-root");
      expect(Object.keys(map)).toHaveLength(10);
      // Ancestor lookup + whole-tree fetch. Allow a small margin for
      // implementation detail, but it must not scale with ordinal count.
      expect(queries).toBeLessThanOrEqual(4);
    } finally {
      (db as unknown as { query: typeof originalQuery }).query = originalQuery;
    }
  });
});
