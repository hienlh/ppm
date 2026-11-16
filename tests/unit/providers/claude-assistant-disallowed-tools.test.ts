/**
 * A Claude PPM Assistant session is offered no file edits unless the user lets it act on its
 * own; a command PPM shows only reads runs with no card, its result badged and its run recorded
 * in the session trace.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { assistantWorkDir, ensureAssistantWorkDir } from "../../../src/services/assistant/assistant-work-dir.ts";
import { assistantDisallowedTools } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { shellDecisionDeps } from "../../../src/services/assistant/assistant-shell-decision.ts";
import * as traceRecorder from "../../../src/services/session-trace/trace-recorder.ts";
import { createCorpusFixture, q, type CorpusFixture } from "../services/readonly-shell/adversarial-bash-corpus.ts";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** What the mocked SDK does once started: nothing, or run the permission hook then report the tool's result. */
let script: ((options: any) => Promise<unknown[]>) | null = null;

function scriptedQuery(options: any) {
  let items: unknown[] | null = null;
  return {
    close() { items = []; },
    [Symbol.asyncIterator]() { return this; },
    async next() {
      items ??= script ? await script(options) : [{ type: "result" }];
      const value = items.shift();
      return value ? { done: false, value } : { done: true, value: undefined };
    },
  };
}

let mockQueryFn: ReturnType<typeof mock>;
mock.module("@anthropic-ai/claude-agent-sdk", () => {
  mockQueryFn = mock((args: any) => scriptedQuery(args.options));
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

let fx: CorpusFixture;
let savedAssistant: unknown;
let savedProjects: unknown;
const originalDeps = { ...shellDecisionDeps };

beforeAll(() => {
  fx = createCorpusFixture();
  ensureAssistantWorkDir();
  savedAssistant = configService.get("assistant");
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "p", path: fx.proj }] as never);
});
afterAll(() => {
  Object.assign(shellDecisionDeps, originalDeps);
  configService.set("assistant", savedAssistant as never);
  configService.set("projects", savedProjects as never);
  fx.cleanup();
});

const permissionHook = (options: any) => options.hooks.PreToolUse.find((m: { matcher: string }) => m.matcher === ".*").hooks[0];

describe("assistantDisallowedTools", () => {
  it("names the four file writers unless the Assistant may act on its own", () => {
    expect(assistantDisallowedTools({ actOnOwn: false }).sort()).toEqual([...EDIT_TOOLS].sort());
    expect(assistantDisallowedTools({ actOnOwn: true })).toEqual([]);
  });
});

describe("Claude Assistant session", () => {
  let provider: InstanceType<typeof ClaudeAgentSdkProvider>;
  beforeEach(() => {
    provider = new ClaudeAgentSdkProvider();
    spyOn(provider as any, "resolveMcpServers").mockReturnValue({});
    script = null;
    mockQueryFn.mockClear();
  });

  async function turn(extra: Record<string, unknown> = {}) {
    const session = await provider.createSession({ projectName: "__assistant__", projectPath: assistantWorkDir() });
    const events: any[] = [];
    for await (const ev of provider.sendMessage(session.id, "hi", { assistantSession: true, assistantInstructions: "# PPM Assistant", ...extra })) {
      events.push(ev);
    }
    return { options: mockQueryFn.mock.calls.at(-1)![0].options, events };
  }

  it("is not offered file edits by default, and is offered them once it may act on its own", async () => {
    configService.set("assistant", { ...(savedAssistant as object), act_on_own: false } as never);
    const off = (await turn()).options.disallowedTools as string[];
    for (const tool of EDIT_TOOLS) expect(off).toContain(tool);
    configService.set("assistant", { ...(savedAssistant as object), act_on_own: true } as never);
    const on = ((await turn()).options.disallowedTools ?? []) as string[];
    for (const tool of EDIT_TOOLS) expect(on).not.toContain(tool);
  });

  it("is the only session the edit tools are taken from", async () => {
    configService.set("assistant", { ...(savedAssistant as object), act_on_own: false } as never);
    const session = await provider.createSession({ projectName: "p", projectPath: fx.proj });
    for await (const _ of provider.sendMessage(session.id, "hi", { permissionMode: "default" })) { /* consume */ }
    const disallowed = (mockQueryFn.mock.calls.at(-1)![0].options.disallowedTools ?? []) as string[];
    for (const tool of EDIT_TOOLS) expect(disallowed).not.toContain(tool);
  });

  it("runs a read-only command with no card, badges its result and records it", async () => {
    configService.set("assistant", { ...(savedAssistant as object), auto_readonly_commands: true, act_on_own: false } as never);
    const traced: unknown[][] = [];
    const spy = spyOn(traceRecorder, "traceServerEvent").mockImplementation((...args: unknown[]) => { traced.push(args); });
    let verdict: unknown;
    script = async (options) => {
      verdict = await permissionHook(options)({
        tool_name: "Bash", tool_use_id: "tu-1", cwd: assistantWorkDir(),
        tool_input: { command: `git -C ${q(fx.proj)} log --oneline -5` },
      });
      return [
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "abc" }] } },
        { type: "result", subtype: "success" },
      ];
    };
    try {
      const { events } = await turn();
      expect(verdict).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
      expect(events.find((e) => e.type === "approval_request")).toBeUndefined();
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ toolUseId: "tu-1", autoApproved: "readonly" });
      for (let i = 0; i < 50 && traced.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(traced[0]?.[2]).toBe("assistant_auto_allowed");
      expect(traced[0]?.[3]).toMatchObject({ tool: "Bash", via: "readonly", toolUseId: "tu-1" });
      expect(JSON.stringify(traced[0]?.[3])).not.toContain("git -C");
    } finally {
      spy.mockRestore();
    }
  });
});
