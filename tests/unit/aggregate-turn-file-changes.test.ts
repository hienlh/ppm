import { describe, test, expect } from "bun:test";
import {
  aggregateTurnFileChanges,
  collectTurnMessages,
} from "../../src/web/lib/aggregate-turn-file-changes.ts";
import type { ChatEvent, ChatMessage } from "../../src/types/chat.ts";

function assistantMsg(events: ChatEvent[], id = "a1"): ChatMessage {
  return { id, role: "assistant", content: "", events, timestamp: "2026-08-26T00:00:00.000Z" };
}

function userMsg(content: string, id = "u1"): ChatMessage {
  return { id, role: "user", content, timestamp: "2026-08-26T00:00:00.000Z" };
}

function toolUse(
  tool: string,
  input: unknown,
  toolUseId?: string,
  children?: ChatEvent[],
): ChatEvent {
  return { type: "tool_use", tool, input, toolUseId, children };
}

function toolResult(toolUseId: string, output: string): ChatEvent {
  return { type: "tool_result", output, toolUseId };
}

const edit = (path: string, oldStr: string, newStr: string, id?: string) =>
  toolUse("Edit", { file_path: path, old_string: oldStr, new_string: newStr }, id);

describe("aggregateTurnFileChanges", () => {
  test("single Edit yields one row", () => {
    const out = aggregateTurnFileChanges([assistantMsg([edit("/a.ts", "x", "y", "t1")])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("/a.ts");
    expect(out[0]!.op).toBe("edit");
    expect(out[0]!.editCount).toBe(1);
    expect(out[0]!.viaSubagent).toBe(false);
  });

  test("three Edits across two files keep first-touched order", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([
        edit("/b.ts", "1", "2", "t1"),
        edit("/a.ts", "3", "4", "t2"),
        edit("/b.ts", "5", "6", "t3"),
      ]),
    ]);
    expect(out.map((c) => c.filePath)).toEqual(["/b.ts", "/a.ts"]);
    expect(out[0]!.editCount).toBe(2);
    expect(out[1]!.editCount).toBe(1);
  });

  test("MultiEdit produces one row with an edit per entry", () => {
    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
      { old_string: "e", new_string: "f" },
      { old_string: "g", new_string: "h" },
    ];
    const out = aggregateTurnFileChanges([
      assistantMsg([toolUse("MultiEdit", { file_path: "/m.ts", edits }, "t1")]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.edits).toHaveLength(4);
    expect(out[0]!.editCount).toBe(4);
    expect(out[0]!.edits.map((e) => e.editIndex)).toEqual([0, 1, 2, 3]);
  });

  test("Write reporting creation is op=create", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([
        toolUse("Write", { file_path: "/n.ts", content: "hi\n" }, "t1"),
        toolResult("t1", "File created successfully at: /n.ts"),
      ]),
    ]);
    expect(out[0]!.op).toBe("create");
  });

  test("Write reporting an update is op=write", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([
        toolUse("Write", { file_path: "/n.ts", content: "hi\n" }, "t1"),
        toolResult("t1", "The file /n.ts has been updated."),
      ]),
    ]);
    expect(out[0]!.op).toBe("write");
  });

  test("Write with no result yet defaults to write and does not throw", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([toolUse("Write", { file_path: "/n.ts", content: "hi\n" }, "t1")]),
    ]);
    expect(out[0]!.op).toBe("write");
  });

  test("NotebookEdit via notebook_path", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([toolUse("NotebookEdit", { notebook_path: "/n.ipynb", new_source: "x" }, "t1")]),
    ]);
    expect(out[0]!.filePath).toBe("/n.ipynb");
    expect(out[0]!.op).toBe("notebook");
  });

  test("NotebookEdit via file_path behaves identically", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([toolUse("NotebookEdit", { file_path: "/n.ipynb", new_source: "x" }, "t1")]),
    ]);
    expect(out[0]!.filePath).toBe("/n.ipynb");
    expect(out[0]!.op).toBe("notebook");
  });

  test("sub-agent edits are attributed", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([
        toolUse("Task", { description: "go" }, "task1", [edit("/s.ts", "a", "b", "c1")]),
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("/s.ts");
    expect(out[0]!.viaSubagent).toBe(true);
  });

  test("sub-agent and direct edits to one file collapse into one flagged row", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([
        toolUse("Task", { description: "go" }, "task1", [edit("/s.ts", "a", "b", "c1")]),
        edit("/s.ts", "c", "d", "t2"),
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.editCount).toBe(2);
    expect(out[0]!.viaSubagent).toBe(true);
  });

  test("read-only turn yields nothing", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([
        toolUse("Read", { file_path: "/a.ts" }, "t1"),
        toolUse("Grep", { pattern: "x" }, "t2"),
        toolUse("Bash", { command: "ls" }, "t3"),
      ]),
    ]);
    expect(out).toEqual([]);
  });

  test("malformed input is skipped without throwing", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([
        toolUse("Edit", null, "t1"),
        toolUse("Edit", {}, "t2"),
        toolUse("MultiEdit", { file_path: "/x.ts", edits: "nope" }, "t3"),
        toolUse("MultiEdit", { file_path: "/x.ts", edits: [] }, "t4"),
        toolUse("Write", {}, "t5"),
      ]),
    ]);
    expect(out).toEqual([]);
  });

  test("line counts reflect the diff", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([edit("/a.ts", "a\nb\nc", "a\nX\nc", "t1")]),
    ]);
    expect(out[0]!.linesAdded).toBe(1);
    expect(out[0]!.linesRemoved).toBe(1);
  });

  test("a new file counts every line as added", () => {
    const out = aggregateTurnFileChanges([
      assistantMsg([toolUse("Write", { file_path: "/n.ts", content: "l1\nl2\n" }, "t1")]),
    ]);
    expect(out[0]!.linesAdded).toBe(2);
    expect(out[0]!.linesRemoved).toBe(0);
  });

  test("editRef composes from toolUseId and index, absent without an id", () => {
    const withId = aggregateTurnFileChanges([
      assistantMsg([
        toolUse("MultiEdit", {
          file_path: "/m.ts",
          edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }],
        }, "tool_9"),
      ]),
    ]);
    expect(withId[0]!.edits.map((e) => e.editRef)).toEqual(["tool_9-0", "tool_9-1"]);

    const withoutId = aggregateTurnFileChanges([
      assistantMsg([edit("/a.ts", "x", "y")]),
    ]);
    expect(withoutId[0]!.edits[0]!.editRef).toBeUndefined();
  });
});

describe("collectTurnMessages", () => {
  test("walks back over consecutive assistant messages and stops at the user message", () => {
    const messages: ChatMessage[] = [
      userMsg("first", "u0"),
      assistantMsg([], "a0"),
      userMsg("second", "u1"),
      assistantMsg([], "a1"),
      assistantMsg([], "a2"),
    ];
    expect(collectTurnMessages(messages, 4).map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(collectTurnMessages(messages, 1).map((m) => m.id)).toEqual(["a0"]);
  });
});
