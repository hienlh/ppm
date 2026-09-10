import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSubagentChildren } from "../../../src/services/subagent-transcript-merger.ts";
import type { ChatEvent } from "../../../src/types/api.ts";

let sessionDir: string;

beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "ppm-subagent-merge-"));
  const subDir = join(sessionDir, "subagents");
  mkdirSync(subDir);
  writeFileSync(join(subDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_parent1" }));
  const lines = [
    // spawn prompt (plain text user record) — must be skipped
    { type: "user", uuid: "u0", message: { role: "user", content: "You are an agent, do things" } },
    { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "toolu_c1", name: "Bash", input: { command: "echo hi" } }] } },
    { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c1", content: "hi" }] } },
    { type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "done" }] } },
  ];
  writeFileSync(join(subDir, "agent-a1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // meta without a matching transcript — must be ignored
  writeFileSync(join(subDir, "agent-a2.meta.json"), JSON.stringify({ toolUseId: "toolu_ghost" }));

  // Nested chain: card toolu_parent2 → agent n1 (depth 1) → agent n2 (depth 2, spawned via Skill).
  // n2's meta has no toolUseId — only parentAgentId — exactly what the CLI writes.
  writeFileSync(join(subDir, "agent-n1.meta.json"), JSON.stringify({ agentType: "reviewer", toolUseId: "toolu_parent2", spawnDepth: 1 }));
  writeFileSync(join(subDir, "agent-n2.meta.json"), JSON.stringify({ agentType: "general-purpose", parentAgentId: "n1", spawnDepth: 2 }));
  const n1 = [
    { type: "user", uuid: "u0", timestamp: "2026-09-07T07:07:40.000Z", message: { role: "user", content: "spawn prompt" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-09-07T07:07:41.000Z", message: { content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "code-review" } }] } },
    // reviewer resumes after the nested worker finished
    { type: "user", uuid: "u1", timestamp: "2026-09-07T07:20:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "review done" }] } },
    { type: "assistant", uuid: "a2", timestamp: "2026-09-07T07:20:01.000Z", message: { content: [{ type: "text", text: "verdict" }] } },
  ];
  const n2 = [
    { type: "user", uuid: "u0", timestamp: "2026-09-07T07:07:42.000Z", message: { role: "user", content: "nested spawn prompt" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-09-07T07:10:00.000Z", message: { content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "x" } }] } },
    { type: "user", uuid: "u1", timestamp: "2026-09-07T07:10:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_grep", content: "hit" }] } },
  ];
  writeFileSync(join(subDir, "agent-n1.jsonl"), n1.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(subDir, "agent-n2.jsonl"), n2.map((l) => JSON.stringify(l)).join("\n") + "\n");
});

afterAll(() => rmSync(sessionDir, { recursive: true, force: true }));

describe("mergeSubagentChildren", () => {
  test("attaches agent transcript events as Agent card children, skipping the spawn prompt", () => {
    const messages = [
      { content: "", events: [{ type: "tool_use", tool: "Agent", toolUseId: "toolu_parent1", input: {} }] as ChatEvent[] },
    ];
    mergeSubagentChildren(sessionDir, messages);
    const card = messages[0]!.events![0] as any;
    expect(card.children?.length).toBe(3); // Bash tool_use + tool_result + text
    expect(card.children[0].type).toBe("tool_use");
    expect(card.children[0].tool).toBe("Bash");
    expect(card.children.some((c: any) => typeof c.content === "string" && c.content.includes("You are an agent"))).toBe(false);
  });

  test("leaves cards without a transcript untouched", () => {
    const messages = [
      { content: "", events: [{ type: "tool_use", tool: "Agent", toolUseId: "toolu_unknown", input: {} }] as ChatEvent[] },
    ];
    mergeSubagentChildren(sessionDir, messages);
    expect((messages[0]!.events![0] as any).children).toBeUndefined();
  });

  test("flattens a nested agent's events into the card, in time order between the parent's steps", () => {
    const messages = [
      { content: "", events: [{ type: "tool_use", tool: "Agent", toolUseId: "toolu_parent2", input: {} }] as ChatEvent[] },
    ];
    mergeSubagentChildren(sessionDir, messages);
    const children = (messages[0]!.events![0] as any).children as any[];
    // Skill tool_use → nested Grep tool_use + result → Skill result → verdict text
    expect(children.map((c) => c.type === "tool_use" ? `use:${c.tool}` : c.type === "tool_result" ? `res:${c.toolUseId}` : c.type)).toEqual([
      "use:Skill",
      "use:Grep",
      "res:toolu_grep",
      "res:toolu_skill",
      "text",
    ]);
    // both spawn prompts skipped
    expect(children.some((c) => typeof c.content === "string" && /spawn prompt/.test(c.content))).toBe(false);
  });

  test("no-op when subagents dir is missing", () => {
    const messages = [
      { content: "", events: [{ type: "tool_use", tool: "Agent", toolUseId: "toolu_parent1", input: {} }] as ChatEvent[] },
    ];
    mergeSubagentChildren(join(sessionDir, "nonexistent"), messages);
    expect((messages[0]!.events![0] as any).children).toBeUndefined();
  });
});
