// Builds a synthetic Claude session on disk: a top-level session JSONL with one user turn and
// one assistant "Agent" tool_use (the card), plus the card's own subagent transcript
// (`<sessionDir>/subagents/agent-root.jsonl`) and a nested child transcript
// (`agent-nested.jsonl`, parentAgentId: "root") — the shapes `groupSubagentsByCard` /
// `mergeSubagentChildren` / the agent-transcript hub already have unit tests against
// (tests/unit/services/subagent-transcript-group-by-card.test.ts, nested-subagent-spy.test.ts).
// Synthetic content only, never touches a real ~/.claude.

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

/** Same encoding `resolveSessionDir` / `pinClaudeSessionDir` use. */
export function slugForProjectPath(projectPath) {
  return projectPath.replace(/[/\\:.]/g, "-");
}

const rec = (o) => JSON.stringify(o) + "\n";

/**
 * Writes the top-level session JSONL (a user turn + an assistant "Agent" tool_use with id
 * `cardId`, no tool_result — the card stays "running" so the fixture's later appends have
 * somewhere to land) and the card's own `subagents/agent-root(.meta.json|.jsonl)` +
 * `agent-nested(.meta.json|.jsonl)` (parentAgentId: "root"). Returns paths the test needs.
 */
export async function writeAgentSessionFixture({ claudeHome, projectPath, sessionId, cardId }) {
  const slug = slugForProjectPath(projectPath);
  const projectDir = join(claudeHome, ".claude", "projects", slug);
  const sessionDir = join(projectDir, sessionId);
  const subagentsDir = join(sessionDir, "subagents");
  await mkdir(subagentsDir, { recursive: true });

  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  const now = new Date().toISOString();
  await writeFile(sessionFile,
    rec({ type: "user", uuid: "u1", parentUuid: null, sessionId, timestamp: now, cwd: projectPath,
      message: { role: "user", content: "Investigate the flaky test suite" } })
    + rec({ type: "assistant", uuid: "a1", parentUuid: "u1", sessionId, timestamp: now, cwd: projectPath,
      message: { role: "assistant", content: [
        { type: "tool_use", id: cardId, name: "Agent", input: { description: "Investigate flaky test", prompt: "Investigate the flaky test suite and report back." } },
      ] } }));

  const rootMeta = join(subagentsDir, "agent-root.meta.json");
  const rootJsonl = join(subagentsDir, "agent-root.jsonl");
  await writeFile(rootMeta, JSON.stringify({ toolUseId: cardId }));
  await writeFile(rootJsonl,
    rec({ type: "user", message: { role: "user", content: "spawn prompt" } })
    + rec({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_g1", name: "Grep", input: { pattern: "flaky" } }] } })
    + rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_g1", content: "3 matches in tests/" }] } }));

  const nestedMeta = join(subagentsDir, "agent-nested.meta.json");
  const nestedJsonl = join(subagentsDir, "agent-nested.jsonl");
  await writeFile(nestedMeta, JSON.stringify({ parentAgentId: "root", spawnDepth: 2 }));
  await writeFile(nestedJsonl,
    rec({ type: "user", message: { role: "user", content: "nested spawn prompt" } })
    + rec({ type: "assistant", message: { content: [{ type: "text", text: "checking fixtures" }] } }));

  return { sessionFile, sessionDir, subagentsDir, rootJsonl, nestedJsonl };
}

/** Appends one more step to the root subagent transcript — what the test calls while the
 *  window is open, to prove a disk write shows up live. */
export async function appendRootStep(rootJsonl, toolUseId, pattern) {
  await appendFile(rootJsonl,
    rec({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: pattern } }] } }));
}
