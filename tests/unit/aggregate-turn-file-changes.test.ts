import { describe, test, expect } from "bun:test";
import {
  aggregateTurnFileChanges,
  collectTurnMessages,
  sessionFileWrites,
} from "../../src/web/lib/aggregate-turn-file-changes.ts";
import { applyChildToParent, slimAgentChildren } from "../../src/web/lib/agent-step-summary.ts";
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
  test("a codex patch over several files counts every file it lists, not just the card's", () => {
    const patch = toolUse("Edit", {
      file_path: "/p/a.ts", old_string: "a", new_string: "b",
      files: [
        { file_path: "/p/a.ts", op: "update", old_string: "a", new_string: "b" },
        { file_path: "/p/new.ts", op: "add", old_string: "", new_string: "one\ntwo\n" },
        { file_path: "/p/gone.ts", op: "delete", old_string: "x\n", new_string: "" },
      ],
    }, "item_1");
    const out = aggregateTurnFileChanges([assistantMsg([patch])]);
    expect(out.map((c) => [c.filePath, c.op, c.linesAdded, c.linesRemoved])).toEqual([
      ["/p/a.ts", "edit", 1, 1],
      ["/p/new.ts", "create", 2, 0],
      ["/p/gone.ts", "edit", 0, 1],
    ]);
  });

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

describe("aggregateTurnFileChanges over slimmed Agent cards (depth-2 nesting)", () => {
  test("a grandchild Edit two Agent levels down still routes and lists after slimming", () => {
    // Codex shape: root card -> nested subagent (depth 1) -> nested subagent (depth 2) -> Edit.
    const deepest = toolUse("Agent", { description: "depth-2 worker" }, "nested-2", [
      edit("/deep.ts", "x", "y", "grandchild-edit"),
      toolResult("grandchild-edit", "file updated successfully"),
      toolUse("Read", { file_path: "/noise.ts" }, "noise"), // dropped by slimming
    ]);
    const root = toolUse("Agent", { description: "root worker" }, "root-1", [
      toolUse("Agent", { description: "depth-1 worker" }, "nested-1", [deepest]),
    ]);

    const { kept } = slimAgentChildren(root.children);
    const slimmedRoot = { ...root, children: kept };
    const changes = aggregateTurnFileChanges([assistantMsg([slimmedRoot])]);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.filePath).toBe("/deep.ts");
    expect(changes[0]!.viaSubagent).toBe(true);
  });

  test("step count equals the number of distinct child tool_use ids after two replays", () => {
    let card = toolUse("Agent", { description: "root worker" }, "root-1");
    const stream: ChatEvent[] = [
      edit("/a.ts", "x", "y", "e1"),
      toolResult("e1", "file updated successfully"),
      toolUse("Bash", { command: "echo hi" }, "b1"),
      toolResult("b1", "hi"),
    ];
    for (const ev of stream) card = applyChildToParent(card, ev);
    // A reconnect replays the same buffered events twice — a stable step count is the
    // one thing `children.length` could never guarantee.
    for (const ev of stream) card = applyChildToParent(card, ev);
    for (const ev of stream) card = applyChildToParent(card, ev);

    expect((card as any).stepIds).toEqual(["e1", "b1"]);
    expect((card as any).stepCount).toBe(2);
    const changes = aggregateTurnFileChanges([assistantMsg([card])]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.filePath).toBe("/a.ts");
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

describe("sessionFileWrites", () => {
  test("names every file written across the session's turns, first-touched first", () => {
    const messages = [
      userMsg("one"),
      assistantMsg([edit("/p/b.ts", "x", "y", "t1"), toolResult("t1", "ok")], "a1"),
      userMsg("two", "u2"),
      assistantMsg([
        toolUse("Write", { file_path: "/p/a.ts", content: "new" }, "t2"),
        edit("/p/b.ts", "y", "z", "t3"),
        toolUse("Read", { file_path: "/p/c.ts" }, "t4"),
      ], "a2"),
    ];
    expect(sessionFileWrites(messages).paths).toEqual(["/p/b.ts", "/p/a.ts"]);
  });

  test("counts a write as settled only once its result is in, wherever the result lands", () => {
    const announced = assistantMsg([edit("/p/a.ts", "x", "y", "t1")], "a1");
    expect(sessionFileWrites([announced]).settled).toBe(0);
    // A result can arrive in a later message, or be embedded on the tool_use for replay.
    const later = assistantMsg([toolResult("t1", "ok")], "a2");
    expect(sessionFileWrites([announced, later]).settled).toBe(1);
    const replayed = assistantMsg([{ ...edit("/p/c.ts", "x", "y", "t9"), result: { output: "ok" } } as ChatEvent], "a3");
    expect(sessionFileWrites([replayed]).settled).toBe(1);
    // A Read finishing is not a write finishing.
    const read = assistantMsg([toolUse("Read", { file_path: "/p/a.ts" }, "r1"), toolResult("r1", "text")], "a4");
    expect(sessionFileWrites([announced, read]).settled).toBe(0);
  });

  test("counts a finished shell command too, since only the server knows what it changed", () => {
    const running = assistantMsg([toolUse("Bash", { command: "cp a.ts b.ts" }, "b1")], "a1");
    expect(sessionFileWrites([running])).toEqual({ paths: [], settled: 0 });
    const done = assistantMsg([toolResult("b1", "")], "a2");
    expect(sessionFileWrites([running, done])).toEqual({ paths: [], settled: 1 });
    const powershell = assistantMsg([toolUse("PowerShell", { command: "ni x" }, "p1"), toolResult("p1", "")], "a3");
    expect(sessionFileWrites([running, done, powershell]).settled).toBe(2);
  });

  test("includes a sub-agent's writes and every file of a codex patch", () => {
    const messages = [assistantMsg([
      toolUse("Agent", { prompt: "go" }, "ag", [edit("/p/sub.ts", "a", "b", "s1")]),
      toolUse("Edit", {
        file_path: "/p/one.ts", old_string: "a", new_string: "b",
        files: [
          { file_path: "/p/one.ts", op: "update", old_string: "a", new_string: "b" },
          { file_path: "/p/two.ts", op: "add", old_string: "", new_string: "x" },
        ],
      }, "cx"),
    ])];
    expect(sessionFileWrites(messages).paths).toEqual(["/p/sub.ts", "/p/one.ts", "/p/two.ts"]);
  });

  test("walks a message again once it is replaced, as streaming replaces it", () => {
    const first = assistantMsg([edit("/p/a.ts", "x", "y", "t1")], "a1");
    expect(sessionFileWrites([first]).paths).toEqual(["/p/a.ts"]);
    const grown = { ...first, events: [...first.events!, edit("/p/b.ts", "x", "y", "t2")] };
    expect(sessionFileWrites([grown]).paths).toEqual(["/p/a.ts", "/p/b.ts"]);
  });
});
