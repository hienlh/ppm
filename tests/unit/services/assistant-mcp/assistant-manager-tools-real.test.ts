import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../../src/services/config.service.ts";
import { setSessionMetadata, setSessionProvider } from "../../../../src/services/db.service.ts";
import { _setClaudeProjectsRoot } from "../../../../src/services/agent-transcript/claude-projects-root.ts";
import { managerChats } from "../../../../src/services/assistant-managers/manager-chats.service.ts";
import { createManagerToolHandlers } from "../../../../src/services/assistant-mcp/assistant-manager-tools.ts";
import type { ApprovalAsk } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import { MANAGER_ASSIGN_TOOL, MANAGER_UNASSIGN_TOOL } from "../../../../src/shared/assistant-manager-tool-names.ts";

/**
 * The manager tools over PPM's real dependencies: a registered project, a Claude chat PPM recorded
 * with its transcript where Claude files it, and the manager service the session list's "Set as
 * manager chat" calls. Assigning writes the same row and the same rules file the screen does.
 */

let root: string;
let projectPath: string;
const sessionId = crypto.randomUUID();
const asks: ApprovalAsk[] = [];
const ctx: ToolContext = {
  sessionId: "assistant-real-test",
  callRoute: (async () => { throw new Error("no route may be called"); }) as ToolContext["callRoute"],
  ask: async (ask) => { asks.push(ask); return { verdict: "approved" }; },
};
const handlers = createManagerToolHandlers();
const call = (tool: string, args: Record<string, unknown>) =>
  handlers[tool]!(ctx, args) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-manager-real-"));
  projectPath = join(root, "nxsys");
  mkdirSync(projectPath, { recursive: true });
  const claudeRoot = join(root, "claude-projects");
  _setClaudeProjectsRoot(claudeRoot);
  const slugDir = join(claudeRoot, projectPath.replace(/[/\\:.]/g, "-"));
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "hi" } })}\n`);
  configService.set("projects", [...configService.get("projects"), { name: "NxsysReal", path: projectPath }]);
  setSessionMetadata(sessionId, "NxsysReal", projectPath);
  setSessionProvider(sessionId, "claude");
});

afterAll(() => {
  managerChats.unassign("NxsysReal");
  configService.set("projects", configService.get("projects").filter((p) => p.name !== "NxsysReal"));
  _setClaudeProjectsRoot(null);
  rmSync(root, { recursive: true, force: true });
});

describe("manager tools on the real service", () => {
  test("assign writes the manager row and the rules file, unassign removes the role only", async () => {
    const r = await call(MANAGER_ASSIGN_TOOL, { project: "NxsysReal", sessionId });
    expect({ isError: r.isError ?? false, text: r.content[0]!.text }).toMatchObject({ isError: false });
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ outcome: "assigned", sessionId });
    expect(asks[0]!.summary.facts.map((f) => f.label)).toEqual(["Project", "Chat", "Provider", "Last activity", "Mode (unchanged)"]);
    expect(asks[0]!.summary.facts[3]!.value).not.toBe("Unknown");
    const row = managerChats.managerFor(projectPath);
    expect(row).toMatchObject({ sessionId, providerId: "claude", assignedBy: "assistant" });
    expect(existsSync(join(projectPath, ".ppm", "manager.md"))).toBe(true);

    const again = await call(MANAGER_ASSIGN_TOOL, { project: "NxsysReal", sessionId });
    expect(again.content[0]!.text).toContain("already is the manager chat");

    const u = await call(MANAGER_UNASSIGN_TOOL, { project: "NxsysReal" });
    expect(JSON.parse(u.content[0]!.text)).toMatchObject({ outcome: "unassigned", sessionId });
    expect(managerChats.managerFor(projectPath)).toBeNull();
    // The chat itself is kept, and so is its rules file.
    expect(existsSync(join(projectPath, ".ppm", "manager.md"))).toBe(true);
  }, 30_000);
});
