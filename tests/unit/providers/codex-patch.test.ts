import { describe, it, expect } from "bun:test";
import { parseApplyPatch, diffToOldNew, changeToToolUse, fileUpdateChanges, rolloutFileChanges } from "../../../src/providers/codex-app-server/codex-patch.ts";

describe("parseApplyPatch", () => {
  it("parses Add File → add change with content", () => {
    const c = parseApplyPatch("*** Begin Patch\n*** Add File: tests/x.txt\n+initial\n*** End Patch\n");
    expect(c).toEqual([{ path: "tests/x.txt", op: "add", oldString: "", newString: "initial" }]);
  });
  it("parses Update File → old/new from -/+", () => {
    const c = parseApplyPatch("*** Begin Patch\n*** Update File: a.ts\n@@\n ctx\n-old\n+new\n*** End Patch\n");
    expect(c[0]).toMatchObject({ path: "a.ts", op: "update", oldString: "ctx\nold", newString: "ctx\nnew" });
  });
  it("parses Delete File", () => {
    const c = parseApplyPatch("*** Begin Patch\n*** Delete File: gone.txt\n-bye\n*** End Patch\n");
    expect(c[0]).toMatchObject({ path: "gone.txt", op: "delete", oldString: "bye" });
  });
});

describe("changeToToolUse", () => {
  it("add → Write with content", () => {
    expect(changeToToolUse({ path: "x.txt", op: "add", oldString: "", newString: "hi" }, "call_1")).toEqual({
      type: "tool_use", tool: "Write", input: { file_path: "x.txt", content: "hi" }, toolUseId: "call_1",
    });
  });
  it("update → Edit with old/new", () => {
    expect(changeToToolUse({ path: "a.ts", op: "update", oldString: "o", newString: "n" })).toMatchObject({
      type: "tool_use", tool: "Edit", input: { file_path: "a.ts", old_string: "o", new_string: "n" },
    });
  });
  it("delete → Edit with empty new", () => {
    expect(changeToToolUse({ path: "g", op: "delete", oldString: "x", newString: "" }).input).toEqual({ file_path: "g", old_string: "x", new_string: "" });
  });
});

describe("diffToOldNew", () => {
  it("splits a unified diff into old/new", () => {
    expect(diffToOldNew("@@ -1 +1 @@\n ctx\n-a\n+b")).toEqual({ oldString: "ctx\na", newString: "ctx\nb" });
  });
});

describe("fileUpdateChanges (live fileChange items)", () => {
  it("reads an added file's diff as its whole content, and a deleted file's as what it held", () => {
    const changes = fileUpdateChanges([
      { path: "/p/new.srt", kind: { type: "add" }, diff: "1\n00:00:01,000 --> 00:00:04,000\n  indented\n" },
      { path: "/p/old.txt", kind: { type: "delete" }, diff: "bye\n" },
    ]);
    expect(changes).toEqual([
      { path: "/p/new.srt", op: "add", oldString: "", newString: "1\n00:00:01,000 --> 00:00:04,000\n  indented\n" },
      { path: "/p/old.txt", op: "delete", oldString: "bye\n", newString: "" },
    ]);
  });

  it("reads an update's diff as hunks, keeping the diff and leaving a move's note out of it", () => {
    const [moved] = fileUpdateChanges([
      { path: "/p/a.ts", kind: { type: "update", move_path: "/p/b.ts" }, diff: "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: /p/b.ts" },
    ]);
    expect(moved).toEqual({ path: "/p/a.ts", op: "update", oldString: "a", newString: "b", unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n", movePath: "/p/b.ts" });
  });

  it("still reads hunks for an add that arrives as one", () => {
    expect(fileUpdateChanges([{ path: "x", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+hi" }])[0]!.newString).toBe("hi");
  });
});

describe("rolloutFileChanges (item_completed FileChange records)", () => {
  it("reads the path-keyed map codex writes to the rollout", () => {
    expect(rolloutFileChanges({
      "/p/a.srt": { type: "add", content: "x\n" },
      "/p/b.md": { type: "update", unified_diff: "@@ -1 +1 @@\n-o\n+n\n", move_path: null },
      "/p/c.txt": { type: "delete", content: "gone\n" },
    })).toEqual([
      { path: "/p/a.srt", op: "add", oldString: "", newString: "x\n" },
      { path: "/p/b.md", op: "update", oldString: "o", newString: "n", unifiedDiff: "@@ -1 +1 @@\n-o\n+n\n" },
      { path: "/p/c.txt", op: "delete", oldString: "gone\n", newString: "" },
    ]);
    expect(rolloutFileChanges(null)).toEqual([]);
    expect(rolloutFileChanges([])).toEqual([]);
  });
});

describe("changeToToolUse with several files", () => {
  it("lists every file under `files`, the first one on the card", () => {
    const changes = fileUpdateChanges([
      { path: "/p/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "/p/n.ts", kind: { type: "add" }, diff: "new\n" },
      { path: "/p/d.ts", kind: { type: "delete" }, diff: "old\n" },
    ]);
    const ev = changeToToolUse(changes[0]!, "item_1", changes) as { input: Record<string, unknown> };
    expect(ev.input.file_path).toBe("/p/a.ts");
    expect(ev.input.files).toEqual([
      { file_path: "/p/a.ts", op: "update", old_string: "a", new_string: "b" },
      { file_path: "/p/n.ts", op: "add", old_string: "", new_string: "new\n" },
      { file_path: "/p/d.ts", op: "delete", old_string: "old\n", new_string: "" },
    ]);
  });

  it("adds nothing for a single file", () => {
    const [only] = fileUpdateChanges([{ path: "/p/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }]);
    expect((changeToToolUse(only!, "i", [only!]) as { input: Record<string, unknown> }).input.files).toBeUndefined();
  });
});
