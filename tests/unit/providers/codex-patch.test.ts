import { describe, it, expect } from "bun:test";
import { parseApplyPatch, diffToOldNew, changeToToolUse } from "../../../src/providers/codex-app-server/codex-patch.ts";

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
