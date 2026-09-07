import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupSubagentsByCard } from "../../../src/services/team-member-activity/subagent-transcript-index.ts";

let dir: string;

/** Write a meta + empty transcript for agent `id`. */
function agent(id: string, meta: Record<string, unknown>): void {
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  writeFileSync(join(dir, `agent-${id}.jsonl`), "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-group-by-card-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("groupSubagentsByCard", () => {
  test("keys a chain by the root's toolUseId, root first then by depth", () => {
    agent("r", { toolUseId: "toolu_card", spawnDepth: 1 });
    agent("c", { parentAgentId: "r", spawnDepth: 2 });
    agent("g", { parentAgentId: "c", spawnDepth: 3 }); // depth 3 — grandchild of the card's agent
    const groups = groupSubagentsByCard(dir);
    expect([...groups.keys()]).toEqual(["toolu_card"]);
    expect(groups.get("toolu_card")!.map((e) => e.agentId)).toEqual(["r", "c", "g"]);
    expect(groups.get("toolu_card")![0]!.parentAgentId).toBeUndefined();
    expect(groups.get("toolu_card")![1]!.parentAgentId).toBe("r");
  });

  test("keeps separate cards apart and lets a nested agent carry its own toolUseId", () => {
    agent("a", { toolUseId: "toolu_a" });
    agent("b", { toolUseId: "toolu_b" });
    // a nested agent spawned via the Agent tool records the agent-local tool_use id too;
    // the chain, not that id, decides the card
    agent("a2", { toolUseId: "toolu_local", parentAgentId: "a" });
    const groups = groupSubagentsByCard(dir);
    expect(groups.get("toolu_a")!.map((e) => e.agentId)).toEqual(["a", "a2"]);
    expect(groups.get("toolu_b")!.map((e) => e.agentId)).toEqual(["b"]);
    expect(groups.has("toolu_local")).toBe(false);
  });

  test("drops agents whose chain has no parent meta, no root toolUseId, or a cycle", () => {
    agent("orphan", { parentAgentId: "missing" });
    agent("noid", {}); // root without toolUseId — nothing to attach to
    agent("x", { parentAgentId: "y" });
    agent("y", { parentAgentId: "x" });
    expect(groupSubagentsByCard(dir).size).toBe(0);
  });

  test("empty map when the dir does not exist", () => {
    expect(groupSubagentsByCard(join(dir, "nope")).size).toBe(0);
  });
});
