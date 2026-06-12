import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { openTestDb, setDb, getDb } from "../../../src/services/db.service.ts";
import {
  recordBranch,
  getRootId,
  getSiblingsByOrdinal,
  getTreeByRoot,
  deleteBranchesFor,
  hasChildren,
  resolveVersionGroup,
  collapseTreesToHeads,
} from "../../../src/services/session-branch.service.ts";

describe("session-branch.service (SQLite-backed)", () => {
  beforeEach(() => {
    setDb(openTestDb());
  });

  afterEach(() => {
    setDb(openTestDb());
  });

  describe("migration v30", () => {
    it("creates the session_branches table with fork_ordinal", () => {
      const cols = getDb()
        .query("PRAGMA table_info(session_branches)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining(["child_id", "parent_id", "fork_msg_id", "fork_ordinal", "root_id", "created_at"]),
      );
    });
  });

  describe("recordBranch + getRootId", () => {
    it("uses parent id as root when parent is a tree root", () => {
      recordBranch("child-1", "root-A", "msg-F", 2);
      expect(getRootId("child-1")).toBe("root-A");
    });

    it("propagates root across nested forks", () => {
      recordBranch("child-1", "root-A", "msg-F", 2);        // root-A is root
      recordBranch("grandchild-1", "child-1", "msg-G", 3);  // forked from child-1
      expect(getRootId("grandchild-1")).toBe("root-A");
    });

    it("returns null for a session with no branch row", () => {
      expect(getRootId("unknown")).toBeNull();
    });
  });

  describe("getSiblingsByOrdinal", () => {
    it("returns children sharing parent + fork_ordinal, ordered by created_at ASC", () => {
      recordBranch("c1", "P", "F", 2);
      recordBranch("c2", "P", "F", 2);
      recordBranch("other", "P", "F2", 5); // different ordinal
      const siblings = getSiblingsByOrdinal("P", 2).map((r) => r.child_id);
      expect(siblings).toEqual(["c1", "c2"]);
    });
  });

  describe("getTreeByRoot", () => {
    it("returns every node sharing the same root", () => {
      recordBranch("c1", "root-A", "F", 2);
      recordBranch("c2", "c1", "G", 3);
      recordBranch("unrelated", "root-B", "H", 2);
      const ids = getTreeByRoot("root-A").map((r) => r.child_id).sort();
      expect(ids).toEqual(["c1", "c2"]);
    });
  });

  describe("hasChildren", () => {
    it("true when the session is a parent of any branch", () => {
      recordBranch("c1", "P", "F", 2);
      expect(hasChildren("P")).toBe(true);
      expect(hasChildren("c1")).toBe(false);
    });
  });

  describe("deleteBranchesFor", () => {
    it("removes the row whose child_id matches", () => {
      recordBranch("c1", "root-A", "F", 2);
      deleteBranchesFor("c1");
      expect(getRootId("c1")).toBeNull();
      expect(getTreeByRoot("root-A")).toHaveLength(0);
    });
  });

  describe("resolveVersionGroup", () => {
    it("lists parent (v1) then children when viewing the parent at the ordinal", () => {
      recordBranch("c1", "P", "F", 2);
      recordBranch("c2", "P", "F", 2);
      const g = resolveVersionGroup("P", 2);
      expect(g).not.toBeNull();
      expect(g!.ids).toEqual(["P", "c1", "c2"]);
      expect(g!.currentIndex).toBe(0);
    });

    it("computes currentIndex when viewing a child (uuid-reassign safe)", () => {
      recordBranch("c1", "P", "F", 2);
      recordBranch("c2", "P", "F", 2);
      const g = resolveVersionGroup("c2", 2);
      expect(g!.ids).toEqual(["P", "c1", "c2"]);
      expect(g!.currentIndex).toBe(2);
    });

    it("returns null when the ordinal has no forked children", () => {
      expect(resolveVersionGroup("P", 99)).toBeNull();
    });
  });

  describe("resolveVersionGroup — multi-branch multi-leaf tree", () => {
    // R ── A (ord 2) ── A1 (ord 3)
    //   │            └─ A2 (ord 3)
    //   └─ B (ord 2)
    function buildTree() {
      recordBranch("A", "R", "f1", 2);
      recordBranch("B", "R", "f1", 2);
      recordBranch("A1", "A", "f2", 3);
      recordBranch("A2", "A", "f2", 3);
    }

    it("groups level-1 siblings from every member's perspective", () => {
      buildTree();
      expect(resolveVersionGroup("R", 2)!.ids).toEqual(["R", "A", "B"]);
      expect(resolveVersionGroup("R", 2)!.currentIndex).toBe(0);
      expect(resolveVersionGroup("A", 2)!.currentIndex).toBe(1);
      expect(resolveVersionGroup("B", 2)!.currentIndex).toBe(2);
    });

    it("groups level-2 siblings under A", () => {
      buildTree();
      expect(resolveVersionGroup("A", 3)!.ids).toEqual(["A", "A1", "A2"]);
      expect(resolveVersionGroup("A", 3)!.currentIndex).toBe(0);
      expect(resolveVersionGroup("A1", 3)!.currentIndex).toBe(1);
      expect(resolveVersionGroup("A2", 3)!.currentIndex).toBe(2);
    });

    it("viewing a grandchild still shows the ANCESTOR's branch point (inherited prefix)", () => {
      buildTree();
      // A1's transcript at ordinal 2 contains A's edited message (copied prefix).
      // The switcher there must resolve to the level-1 group, positioned on the
      // A lineage — this is what lets the user hop from a leaf back to branch B.
      const g = resolveVersionGroup("A1", 2);
      expect(g).not.toBeNull();
      expect(g!.ids).toEqual(["R", "A", "B"]);
      expect(g!.currentIndex).toBe(1); // A1 sits on A's lineage
    });

    it("walks multiple levels up for deep leaves", () => {
      buildTree();
      recordBranch("A1x", "A1", "f3", 5); // leaf under A1
      const g = resolveVersionGroup("A1x", 2);
      expect(g!.ids).toEqual(["R", "A", "B"]);
      expect(g!.currentIndex).toBe(1); // still the A lineage
      const g3 = resolveVersionGroup("A1x", 3);
      expect(g3!.ids).toEqual(["A", "A1", "A2"]);
      expect(g3!.currentIndex).toBe(1); // A1 lineage
    });

    it("R has no switcher at an ordinal where only a grandchild diverged", () => {
      buildTree();
      // ordinal 3 diverged under A, not under R — R's transcript has no group there
      expect(resolveVersionGroup("R", 3)).toBeNull();
      // B never diverged at 3 either
      expect(resolveVersionGroup("B", 3)).toBeNull();
    });
  });

  describe("collapseTreesToHeads", () => {
    it("keeps one row per tree — the newest by updatedAt", () => {
      recordBranch("c1", "P", "F", 2); // c1 belongs to tree rooted at P
      const sessions = [
        { id: "P", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "c1", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" },
        { id: "solo", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" },
      ];
      const heads = collapseTreesToHeads(sessions).map((s) => s.id).sort();
      expect(heads).toEqual(["c1", "solo"]); // P collapsed into c1 (newer)
    });

    it("never collapses pinned sessions", () => {
      recordBranch("c1", "P", "F", 2);
      const sessions = [
        { id: "P", createdAt: "2026-01-01T00:00:00Z", pinned: true },
        { id: "c1", createdAt: "2026-01-02T00:00:00Z" },
      ];
      const ids = collapseTreesToHeads(sessions).map((s) => s.id).sort();
      expect(ids).toEqual(["P", "c1"]);
    });
  });
});
