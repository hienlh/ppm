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
