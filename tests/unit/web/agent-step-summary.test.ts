import { describe, expect, test } from "bun:test";
import {
  agentStepInfo,
  applyChildToParent,
  describeStep,
  pushRecentChild,
  slimAgentChildren,
  slimHistoryEvents,
  MAX_RECENT_CHILDREN,
} from "../../../src/web/lib/agent-step-summary";
import type { ChatEvent } from "../../../src/types/chat";

function toolUse(tool: string, input: Record<string, unknown>, toolUseId?: string): ChatEvent {
  return { type: "tool_use", tool, input, toolUseId };
}

function toolResult(toolUseId: string, output = "ok"): ChatEvent {
  return { type: "tool_result", output, toolUseId };
}

describe("describeStep", () => {
  test("file tools show tool name + basename", () => {
    expect(describeStep(toolUse("Edit", { file_path: "/repo/src/index.ts" }))).toBe("Edit index.ts");
  });

  test("Bash prefers description over the raw command", () => {
    expect(describeStep(toolUse("Bash", { command: "ls -la", description: "list files" }))).toBe("list files");
    expect(describeStep(toolUse("Bash", { command: "ls -la" }))).toBe("ls -la");
  });

  test("nested Agent/Task leads with the handle when addressable", () => {
    expect(describeStep(toolUse("Agent", { name: "dev-p1", description: "fix bug" }))).toBe("dev-p1 · fix bug");
    expect(describeStep(toolUse("Agent", { description: "one-shot review" }))).toBe("one-shot review");
  });

  test("non tool_use events describe as empty", () => {
    expect(describeStep({ type: "text", content: "hi" })).toBe("");
  });
});

describe("slimAgentChildren", () => {
  test("keeps nested Agent/Task stubs and file mutations + their results; drops everything else", () => {
    const children: ChatEvent[] = [
      toolUse("Read", { file_path: "/a.ts" }, "t1"),
      toolResult("t1", "contents"),
      toolUse("Edit", { file_path: "/b.ts", old_string: "a", new_string: "b" }, "t2"),
      toolResult("t2", "file updated successfully"),
      toolUse("Agent", { description: "nested worker" }, "t3"),
      toolResult("t3", "worker done"),
      { type: "text", content: "narration" },
    ];
    const { stepIds, lastStep, kept } = slimAgentChildren(children);

    expect(stepIds).toEqual(["t1", "t2", "t3"]);
    expect(lastStep).toBe(describeStep(children[4]!));
    // Read (t1) + its result are dropped; Edit (t2)+result and Agent (t3)+result survive.
    expect(kept.map((e) => e.type === "tool_use" ? `use:${(e as any).toolUseId}` : `res:${(e as any).toolUseId}`))
      .toEqual(["use:t2", "res:t2", "use:t3", "res:t3"]);
  });

  test("recursively slims a nested Agent's own children (Codex depth-2 shape)", () => {
    const grandchildEdit = toolUse("Edit", { file_path: "/deep.ts", old_string: "x", new_string: "y" }, "gc1");
    const grandchildRead = toolUse("Read", { file_path: "/noise.ts" }, "gc2");
    const nestedAgent: ChatEvent = {
      ...toolUse("Agent", { description: "reviewer" }, "n1"),
      children: [grandchildRead, toolResult("gc2", "noise"), grandchildEdit, toolResult("gc1", "edited")],
    };
    const { kept } = slimAgentChildren([nestedAgent]);
    expect(kept).toHaveLength(1);
    const slimmedNested = kept[0] as any;
    expect(slimmedNested.toolUseId).toBe("n1");
    expect(slimmedNested.stepCount).toBe(2); // gc1 + gc2, both counted as steps
    // Only the Edit (+ its result) survives the nested agent's own slimming — the noise Read is gone.
    expect(slimmedNested.children.map((e: any) => e.toolUseId)).toEqual(["gc1", "gc1"]);
  });

  test("step ids fall back to a stable per-call index when a tool_use carries none", () => {
    const children = Array.from({ length: 5 }, (_, i) => toolUse("Read", { file_path: `/f${i}.ts` }));
    const { stepIds } = slimAgentChildren(children);
    expect(new Set(stepIds).size).toBe(5);
  });
});

describe("agentStepInfo", () => {
  test("prefers stamped stepCount/lastStep over recomputing from children", () => {
    const tool = { ...toolUse("Agent", {}, "a1"), stepCount: 42, lastStep: "cached" } as Extract<ChatEvent, { type: "tool_use" }>;
    expect(agentStepInfo(tool)).toEqual({ stepCount: 42, lastStep: "cached" });
  });

  test("recomputes from children when unstamped", () => {
    const tool = {
      ...toolUse("Agent", {}, "a1"),
      children: [toolUse("Read", { file_path: "/x.ts" }, "c1"), toolResult("c1")],
    } as Extract<ChatEvent, { type: "tool_use" }>;
    expect(agentStepInfo(tool)).toEqual({ stepCount: 1, lastStep: "Read x.ts" });
  });
});

describe("pushRecentChild", () => {
  test("upserts by toolUseId instead of duplicating on replay", () => {
    let buf: ChatEvent[] = [];
    buf = pushRecentChild(buf, toolUse("Bash", { command: "pending" }, "b1"));
    buf = pushRecentChild(buf, toolResult("b1", "still running"));
    buf = pushRecentChild(buf, toolResult("b1", "done"));
    expect(buf).toHaveLength(2);
    expect((buf[1] as any).output).toBe("done");
  });

  test("caps at MAX_RECENT_CHILDREN, dropping the oldest", () => {
    let buf: ChatEvent[] = [];
    for (let i = 0; i < MAX_RECENT_CHILDREN + 10; i++) {
      buf = pushRecentChild(buf, { type: "text", content: String(i) });
    }
    expect(buf).toHaveLength(MAX_RECENT_CHILDREN);
    expect((buf[0] as any).content).toBe("10");
    expect((buf[buf.length - 1] as any).content).toBe(String(MAX_RECENT_CHILDREN + 9));
  });
});

describe("applyChildToParent", () => {
  function parent(): ChatEvent {
    return toolUse("Agent", { description: "worker" }, "parent-1");
  }

  test("counts a step exactly once even when the same tool_use is redelivered by a replay", () => {
    let p = parent();
    p = applyChildToParent(p, toolUse("Read", { file_path: "/a.ts" }, "c1"));
    p = applyChildToParent(p, toolUse("Read", { file_path: "/a.ts" }, "c1")); // replay redelivers c1
    expect((p as any).stepIds).toEqual(["c1"]);
    expect((p as any).stepCount).toBe(1);
  });

  test("routes a file mutation + its result into kept children; routes an ordinary tool_use into the ring buffer", () => {
    let p = parent();
    p = applyChildToParent(p, toolUse("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }, "e1"));
    p = applyChildToParent(p, toolResult("e1", "file updated successfully"));
    p = applyChildToParent(p, toolUse("Bash", { command: "echo hi" }, "b1"));
    p = applyChildToParent(p, toolResult("b1", "hi"));

    expect((p as any).children.map((e: any) => e.toolUseId)).toEqual(["e1", "e1"]);
    expect((p as any).recentChildren.map((e: any) => e.toolUseId)).toEqual(["b1", "b1"]);
    expect((p as any).stepIds).toEqual(["e1", "b1"]);
  });

  test("a nested Agent/Task tool_use is kept even with no result yet", () => {
    let p = parent();
    p = applyChildToParent(p, toolUse("Agent", { description: "sub" }, "n1"));
    expect((p as any).children.map((e: any) => e.toolUseId)).toEqual(["n1"]);
  });

  test("lastStep tracks the most recent step's description, kept or not", () => {
    let p = parent();
    p = applyChildToParent(p, toolUse("Edit", { file_path: "/a.ts" }, "e1"));
    p = applyChildToParent(p, toolUse("Bash", { command: "echo hi" }, "b1"));
    expect((p as any).lastStep).toBe("echo hi");
  });
});

describe("slimHistoryEvents", () => {
  test("slims a card stamped transcriptAvailable, leaves an unstamped one's children untouched", () => {
    const stamped: ChatEvent = {
      ...toolUse("Agent", {}, "a1"),
      transcriptAvailable: true,
      children: [toolUse("Read", { file_path: "/x.ts" }, "c1"), toolResult("c1")],
    };
    const unstamped: ChatEvent = {
      ...toolUse("Agent", {}, "a2"),
      children: [toolUse("Read", { file_path: "/y.ts" }, "c2"), toolResult("c2")],
    };
    const [slimmed, untouched] = slimHistoryEvents([stamped, unstamped])!;
    expect((slimmed as any).children).toEqual([]);
    expect((slimmed as any).stepCount).toBe(1);
    expect((untouched as any).children).toHaveLength(2);
    expect((untouched as any).stepCount).toBeUndefined();
  });

  test("passes through non-Agent/Task tool_use and non-tool_use events unchanged", () => {
    const events: ChatEvent[] = [toolUse("Bash", { command: "ls" }, "b1"), { type: "text", content: "hi" }];
    expect(slimHistoryEvents(events)).toEqual(events);
  });
});
