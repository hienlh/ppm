/**
 * A PPM Assistant session reads content it did not write, so on Claude its permission hook
 * lets through only reads inside registered projects and the Assistant's own tools, whatever
 * mode was asked for; the web tools, the shell, writes and reads anywhere else ask first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { assistantWorkDir, ensureAssistantWorkDir } from "../../../src/services/assistant/assistant-work-dir.ts";
import { assistantToolDecision } from "../../../src/services/assistant/assistant-tool-policy.ts";

/** A query that yields one `result` and can be closed, as the provider's cleanup expects. */
function resultOnlyQuery() {
  const items = [{ type: "result" }];
  return {
    close() { items.length = 0; },
    [Symbol.asyncIterator]() { return this; },
    async next() {
      const value = items.shift();
      return value ? { done: false, value } : { done: true, value: undefined };
    },
  };
}

let mockQueryFn: ReturnType<typeof mock>;
mock.module("@anthropic-ai/claude-agent-sdk", () => {
  mockQueryFn = mock(() => resultOnlyQuery());
  return {
    query: (...args: any[]) => mockQueryFn(...args),
    listSessions: mock(() => Promise.resolve([])),
    getSessionInfo: mock(() => Promise.resolve(undefined)),
    getSessionMessages: mock(() => Promise.resolve([])),
    forkSession: mock(() => Promise.resolve({ sessionId: "mock-fork-id" })),
    renameSession: mock(() => Promise.resolve()),
  };
});
const { ClaudeAgentSdkProvider } = await import("../../../src/providers/claude-agent-sdk.ts");

const ALLOW = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
const DENY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "User denied tool execution" } };

let project: string;
let outside: string;
let savedProjects: unknown;

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-asst-project-"));
  outside = mkdtempSync(join(tmpdir(), "ppm-asst-outside-"));
  writeFileSync(join(project, "a.ts"), "x");
  writeFileSync(join(outside, "secret.txt"), "x");
  mkdirSync(getPpmDir(), { recursive: true });
  writeFileSync(join(getPpmDir(), "ppm.db"), "");
  ensureAssistantWorkDir();
  savedProjects = configService.get("projects");
  // The PPM dir itself registered as a project, the way a project at the home directory
  // contains it: reads must still stop there.
  configService.set("projects", [{ name: "p", path: project }, { name: "home", path: getPpmDir() }]);
});
afterAll(() => {
  configService.set("projects", savedProjects as never);
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ctx = () => ({ cwd: assistantWorkDir(), projectRoots: configService.get("projects").map((p) => p.path) });

describe("assistantToolDecision", () => {
  it("allows reads inside a registered project", () => {
    expect(assistantToolDecision("Read", { file_path: join(project, "a.ts") }, ctx())).toBe("allow");
    expect(assistantToolDecision("Read", { file_path: join(project, "not-yet.ts") }, ctx())).toBe("allow");
    expect(assistantToolDecision("Glob", { pattern: "**/*.ts", path: project }, ctx())).toBe("allow");
    expect(assistantToolDecision("Grep", { pattern: "x", path: project }, ctx())).toBe("allow");
  });

  it("asks for reads outside the projects, inside the PPM dir, or with no path to judge", () => {
    expect(assistantToolDecision("Read", { file_path: join(outside, "secret.txt") }, ctx())).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: join(getPpmDir(), "ppm.db") }, ctx())).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: "../ppm.db" }, ctx())).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: "a.ts" }, { projectRoots: [project] })).toBe("ask");
    // Glob/Grep with no path search the Assistant's own folder, inside the PPM dir.
    expect(assistantToolDecision("Glob", { pattern: "*" }, ctx())).toBe("ask");
    expect(assistantToolDecision("Grep", { pattern: "token" }, ctx())).toBe("ask");
    expect(assistantToolDecision("Glob", { pattern: "../**", path: project }, ctx())).toBe("ask");
    expect(assistantToolDecision("Glob", { pattern: "/etc/*", path: project }, ctx())).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: 42 }, ctx())).toBe("ask");
    expect(assistantToolDecision("Read", null, ctx())).toBe("ask");
  });

  it("allows the conversation-only tools and the Assistant's own MCP tools, and asks for the rest", () => {
    for (const tool of ["ToolSearch", "TodoWrite", "mcp__ppm-assistant__ui_state"]) {
      expect(assistantToolDecision(tool, {}, ctx())).toBe("allow");
    }
    for (const tool of ["WebFetch", "WebSearch", "Bash", "Write", "Edit", "Agent", "Skill", "mcp__github__create_issue", "mcp__ppm-tabs__open_file"]) {
      expect(assistantToolDecision(tool, { file_path: join(project, "a.ts"), url: "https://x" }, ctx())).toBe("ask");
    }
  });
});

describe("Claude Assistant session", () => {
  let provider: InstanceType<typeof ClaudeAgentSdkProvider>;
  beforeEach(() => {
    provider = new ClaudeAgentSdkProvider();
    // The machine's own MCP configuration has no business in these turns.
    spyOn(provider as any, "resolveMcpServers").mockReturnValue({});
    mockQueryFn.mockReset();
    mockQueryFn.mockImplementation(() => resultOnlyQuery());
  });

  async function startTurn(extra: Record<string, unknown> = {}) {
    const session = await provider.createSession({ projectName: "__assistant__", projectPath: assistantWorkDir() });
    for await (const _ of provider.sendMessage(session.id, "hi", {
      assistantSession: true, assistantInstructions: "# PPM Assistant", permissionMode: "bypassPermissions", ...extra,
    })) { /* consume */ }
    return mockQueryFn.mock.calls.at(-1)![0].options;
  }

  const permissionHook = (options: any) => options.hooks.PreToolUse.find((m: { matcher: string }) => m.matcher === ".*").hooks[0];

  /** Runs a hook call that should stop for approval, declines it, and returns the verdict. */
  async function declined(run: () => Promise<unknown>): Promise<unknown> {
    const pending = (provider as any).pendingApprovals as Map<string, unknown>;
    const before = new Set(pending.keys());
    const verdict = run();
    await new Promise((r) => setTimeout(r, 0));
    const requestId = [...pending.keys()].find((k) => !before.has(k));
    expect(requestId).toBeTruthy();
    provider.resolveApproval(requestId!, false);
    return verdict;
  }

  it("runs in default mode with its instructions and pre-approves nothing, even when bypass was asked for", async () => {
    const opts = await startTurn();
    expect(opts.permissionMode).toBe("default");
    expect(opts.allowDangerouslySkipPermissions).toBe(false);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "# PPM Assistant" });
    expect(permissionHook(opts)).toBeFunction();
  });

  it("lets project reads and its own tools through the hook", async () => {
    const hook = permissionHook(await startTurn());
    const cwd = assistantWorkDir();
    expect(await hook({ tool_name: "Read", tool_input: { file_path: join(project, "a.ts") }, cwd })).toEqual(ALLOW);
    expect(await hook({ tool_name: "mcp__ppm-assistant__x", tool_input: {}, cwd })).toEqual(ALLOW);
    expect(await hook({ tool_name: "ToolSearch", tool_input: { query: "x" }, cwd })).toEqual(ALLOW);
  });

  it("asks for reads outside the projects or in the PPM dir, the web tools and the shell", async () => {
    const hook = permissionHook(await startTurn());
    const cwd = assistantWorkDir();
    for (const input of [
      { tool_name: "Read", tool_input: { file_path: join(outside, "secret.txt") } },
      { tool_name: "Read", tool_input: { file_path: join(getPpmDir(), "ppm.db") } },
      { tool_name: "WebFetch", tool_input: { url: "https://example.com/?k=secret", prompt: "x" } },
      { tool_name: "WebSearch", tool_input: { query: "secret" } },
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { tool_name: "mcp__github__create_issue", tool_input: {} },
    ]) {
      expect(await declined(() => hook({ ...input, cwd }))).toEqual(DENY);
    }
  });

  it("backstops the hook in canUseTool", async () => {
    const opts = await startTurn();
    expect(await opts.canUseTool("Read", { file_path: join(project, "a.ts") }))
      .toEqual({ behavior: "allow", updatedInput: { file_path: join(project, "a.ts") } });
    expect(await declined(() => opts.canUseTool("WebFetch", { url: "https://x" })))
      .toEqual({ behavior: "deny", message: "User denied tool execution" });
  });

  it("gets no tab tools, no design server, and never a user MCP server under the Assistant's name", async () => {
    spyOn(provider as any, "resolveMcpServers").mockReturnValue({
      "ppm-assistant": { type: "http", url: "http://evil" }, github: { type: "http", url: "http://gh" },
    });
    const opts = await startTurn({
      tabToolsMcp: { url: "http://127.0.0.1:1/api/tab-tools-mcp", token: "t" },
      designSession: true, designMcp: { url: "http://127.0.0.1:1/api/design-mcp", token: "d" },
    });
    expect(Object.keys(opts.mcpServers)).toEqual(["github"]);
  });

  it("gets PPM's own ppm-assistant server over a user one of that name, and loads no MCP config PPM did not pass", async () => {
    spyOn(provider as any, "resolveMcpServers").mockReturnValue({
      "ppm-assistant": { type: "stdio", command: "evil" }, github: { type: "http", url: "http://gh" },
    });
    const opts = await startTurn({ assistantMcp: { url: "http://127.0.0.1:8125/api/assistant-mcp", token: "tok" } });
    expect(opts.mcpServers["ppm-assistant"]).toEqual({
      type: "http", url: "http://127.0.0.1:8125/api/assistant-mcp", headers: { Authorization: "Bearer tok" }, timeout: 12 * 60_000,
    });
    expect(opts.mcpServers.github).toEqual({ type: "http", url: "http://gh" });
    expect(opts.strictMcpConfig).toBe(true);
  });

  it("leaves an ordinary chat's MCP loading as it was", async () => {
    const session = await provider.createSession({ projectName: "p", projectPath: project });
    for await (const _ of provider.sendMessage(session.id, "hi", {
      permissionMode: "bypassPermissions", assistantMcp: { url: "http://127.0.0.1:1/api/assistant-mcp", token: "t" },
    })) { /* consume */ }
    const opts = mockQueryFn.mock.calls.at(-1)![0].options;
    expect(opts.strictMcpConfig).toBeUndefined();
    expect(opts.mcpServers?.["ppm-assistant"]).toBeUndefined();
  });
});
