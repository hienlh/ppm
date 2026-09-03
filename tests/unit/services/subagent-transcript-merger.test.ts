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

  test("no-op when subagents dir is missing", () => {
    const messages = [
      { content: "", events: [{ type: "tool_use", tool: "Agent", toolUseId: "toolu_parent1", input: {} }] as ChatEvent[] },
    ];
    mergeSubagentChildren(join(sessionDir, "nonexistent"), messages);
    expect((messages[0]!.events![0] as any).children).toBeUndefined();
  });
});
