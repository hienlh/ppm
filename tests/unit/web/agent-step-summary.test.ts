import { describe, expect, test } from "bun:test";
import {
  agentStepInfo,
  applyChildToParent,
  describeStep,
  formatStepCount,
  mergeFallbackEvents,
  pushRecentChild,
  recursiveStepCount,
  slimAgentChildren,
  slimHistoryEvents,
  MAX_RECENT_BYTES,
  MAX_RECENT_CHILDREN,
} from "../../../src/web/lib/agent-step-summary";
import type { ChatEvent } from "../../../src/types/chat";

function toolUse(tool: string, input: Record<string, unknown>, toolUseId?: string): ChatEvent {
  return { type: "tool_use", tool, input, toolUseId };
}

function toolResult(toolUseId: string, output = "ok"): ChatEvent {
  return { type: "tool_result", output, toolUseId };
}

/** A fresh Agent/Task parent with no routed children yet. */
function parent(): ChatEvent {
  return toolUse("Agent", { description: "worker" }, "parent-1");
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

describe("recursiveStepCount — nested agent totals equal the window's flat count (M5)", () => {
  test("sums a nested Agent's own subtree on top of this card's direct steps", () => {
    // Top card: t1 (Read, direct), t2 (Edit, direct), t3 (nested Agent — counts once for the
    // spawn, its own gc1/gc2 counted on top). Flat on-disk total: t1,t2,t3,gc1,gc2 = 5.
    const nestedAgent: Extract<ChatEvent, { type: "tool_use" }> = {
      ...(toolUse("Agent", { description: "nested" }, "t3") as Extract<ChatEvent, { type: "tool_use" }>),
      children: [
        toolUse("Read", { file_path: "/g1.ts" }, "gc1"),
        toolResult("gc1"),
        toolUse("Edit", { file_path: "/g2.ts" }, "gc2"),
        toolResult("gc2"),
      ],
    };
    let top = toolUse("Agent", { description: "top" }, "top1");
    top = applyChildToParent(top, toolUse("Read", { file_path: "/a.ts" }, "t1"));
    top = applyChildToParent(top, toolUse("Edit", { file_path: "/b.ts" }, "t2"));
    top = applyChildToParent(top, nestedAgent);

    expect(recursiveStepCount(top as Extract<ChatEvent, { type: "tool_use" }>)).toBe(5);
    expect(agentStepInfo(top as Extract<ChatEvent, { type: "tool_use" }>).stepCount).toBe(5);
  });

  test("a leaf agent (no nested Agent/Task) is unaffected — count equals direct steps", () => {
    const tool = {
      ...(toolUse("Agent", {}, "a1") as Extract<ChatEvent, { type: "tool_use" }>),
      stepCount: 16,
      stepIds: Array.from({ length: 16 }, (_, i) => `idx:${i}`),
    };
    expect(recursiveStepCount(tool)).toBe(16);
  });
});

describe("formatStepCount", () => {
  test("singular for exactly one step, plural otherwise", () => {
    expect(formatStepCount(1)).toBe("1 step");
    expect(formatStepCount(0)).toBe("0 steps");
    expect(formatStepCount(2)).toBe("2 steps");
    expect(formatStepCount(16)).toBe("16 steps");
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

  test("also caps by approximate serialized size, dropping oldest before the count cap kicks in (L3)", () => {
    const big = "x".repeat(50_000); // ~50KB per entry once serialized
    let buf: ChatEvent[] = [];
    for (let i = 0; i < 10; i++) {
      buf = pushRecentChild(buf, { type: "text", content: `${big}-${i}` });
    }
    // 10 * ~50KB ≈ 500KB, well past MAX_RECENT_BYTES (256KB) and far under the 200-entry cap.
    expect(buf.length).toBeLessThan(10);
    const totalBytes = buf.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_RECENT_BYTES);
    // The most recent entry always survives even if it alone would exceed the budget.
    expect((buf[buf.length - 1] as any).content).toBe(`${big}-9`);
  });

  test("stamps arrivalSeq when a seq is given; preserves the original seq across an update", () => {
    let buf: ChatEvent[] = [];
    buf = pushRecentChild(buf, toolUse("Bash", { command: "pending" }, "b1"), 3);
    expect((buf[0] as any).arrivalSeq).toBe(3);
    buf = pushRecentChild(buf, toolResult("b1", "still running"), 3);
    buf = pushRecentChild(buf, toolResult("b1", "done"), 7); // later delivery, same entry updated
    expect((buf[1] as any).arrivalSeq).toBe(3); // position preserved, not moved to seq 7
    expect((buf[1] as any).output).toBe("done");
  });
});

describe("applyChildToParent", () => {
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

  test("stamps each routed child with a monotonically increasing arrivalSeq", () => {
    let p = parent();
    p = applyChildToParent(p, toolUse("Bash", { command: "one" }, "b1")); // -> recentChildren, seq 0
    p = applyChildToParent(p, toolUse("Edit", { file_path: "/a.ts" }, "e1")); // -> children, seq 1
    p = applyChildToParent(p, toolUse("Bash", { command: "two" }, "b2")); // -> recentChildren, seq 2
    expect((p as any).recentChildren.map((c: any) => c.arrivalSeq)).toEqual([0, 2]);
    expect((p as any).children.map((c: any) => c.arrivalSeq)).toEqual([1]);
  });
});

describe("mergeFallbackEvents (M6)", () => {
  test("interleaves kept children and the ring buffer back into original arrival order", () => {
    let p = parent();
    p = applyChildToParent(p, toolUse("Bash", { command: "read something" }, "b1")); // not kept
    p = applyChildToParent(p, toolUse("Edit", { file_path: "/a.ts" }, "e1")); // kept
    p = applyChildToParent(p, toolResult("e1", "file updated successfully"));
    p = applyChildToParent(p, toolUse("Bash", { command: "read again" }, "b2")); // not kept

    const merged = mergeFallbackEvents((p as any).children, (p as any).recentChildren);
    // Arrival order was b1, e1, e1-result, b2 — a plain concatenation of children (e1, e1
    // result) then recentChildren (b1, b2) would show the edit before the read that preceded
    // it, which is exactly the bug M6 reports.
    expect(merged.map((e: any) => e.toolUseId)).toEqual(["b1", "e1", "e1", "b2"]);
  });

  test("falls back to each list's own order when neither side carries an arrivalSeq", () => {
    const kept: ChatEvent[] = [toolUse("Edit", { file_path: "/a.ts" }, "e1")];
    const recent: ChatEvent[] = [toolUse("Bash", { command: "x" }, "b1")];
    expect(mergeFallbackEvents(kept, recent).map((e: any) => e.toolUseId)).toEqual(["e1", "b1"]);
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
