/**
 * The Assistant's `terminal_type`: one line typed into a new terminal for the user to run, through
 * the same terminal tools as an ordinary chat's `run_in_terminal`. It follows that tool's switch,
 * is refused in any turn the user did not start from PPM with only their own words in it, keeps the
 * AI-chat mark on the terminal, docks it where the user's device is, and names both projects.
 */
import { afterAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalTypeTool, type TerminalTypeDeps } from "../../../../src/services/assistant-mcp/assistant-terminal-type-tool.ts";
import {
  TERMINAL_TYPE_MAX_CHARS, TERMINAL_TYPE_TOOL_DEFINITION,
} from "../../../../src/services/assistant-mcp/assistant-terminal-type-tool-definition.ts";
import { createTerminalTools } from "../../../../src/services/tab-tools-mcp/terminal-tools.ts";
import type { TabOpenOutcome } from "../../../../src/services/tab-tools-mcp/tab-open-broker.ts";
import { UNATTENDED_TURN_REFUSAL } from "../../../../src/services/chat-control/chat-control.ts";
import type { AssistantProvenance } from "../../../../src/shared/assistant-provenance.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../../src/shared/assistant-project.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-terminal-type-"));
const project = join(root, "api");
mkdirSync(join(project, "scripts"), { recursive: true });
const outside = join(root, "elsewhere");
mkdirSync(outside);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CLEAN: AssistantProvenance = { startedBy: "user_ppm", untrusted: false };

function harness(opts: { enabled?: boolean; unattended?: boolean; shownProject?: string } = {}) {
  const created: Array<{ id: string; dir: string; aiMark?: boolean; written: string[] }> = [];
  const requests: Array<Record<string, unknown>> = [];
  let clock = 1_000_000;
  const outcome: TabOpenOutcome = {
    ok: true,
    result: { type: "tab_open_result", requestId: "r".repeat(16), opened: true, ...(opts.shownProject ? { shownProject: opts.shownProject } : {}) },
  };
  const tools = createTerminalTools({
    terminals: {
      list: () => [],
      get: (id: string) => (created.some((t) => t.id === id) ? ({ cols: 80, rows: 24, lastOutputAt: clock - 1_000, pty: { closed: false } } as any) : undefined),
      getBuffer: () => "$ ",
      create: (dir: string, o?: { aiMark?: boolean }) => {
        const id = `${String(created.length + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
        created.push({ id, dir, aiMark: o?.aiMark, written: [] });
        return id;
      },
      write: (id: string, data: string) => { created.find((t) => t.id === id)?.written.push(data); },
      kill: () => {},
    },
    request: async (_sessionId, req) => { requests.push(req as Record<string, unknown>); return outcome; },
    enabled: () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const deps: TerminalTypeDeps = {
    enabled: () => opts.enabled ?? true,
    unattended: () => opts.unattended ?? false,
    projects: () => [{ name: "api", path: project }],
    run: (binding, args, runOpts) => tools.run(binding, args, runOpts),
  };
  // A clean turn unless the test passes a provenance, `undefined` included (unknown).
  const call = (args: Record<string, unknown>, ...provenance: [AssistantProvenance | undefined] | []) =>
    terminalTypeTool({ sessionId: "assistant-1", provenanceAtCall: provenance.length ? provenance[0] : CLEAN }, args, deps) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  return { created, requests, call };
}

describe("terminal_type", () => {
  it("types the command with no newline into a new terminal that keeps the AI mark, docked where the device is", async () => {
    const { created, requests, call } = harness({ shownProject: "web" });
    const result = await call({ project: "api", command: "  bun run migrate  ", cwd: "scripts" });
    expect(result.isError).toBeUndefined();
    expect(created).toEqual([{ id: expect.any(String), dir: join(project, "scripts"), aiMark: true, written: ["bun run migrate"] }]);
    expect(requests).toEqual([{
      tool: "run_in_terminal", terminalId: created[0]!.id, projectName: "api", cwd: join(project, "scripts"), dock: "current",
    }]);
    const text = result.content[0]!.text;
    // Both projects: the one the shell starts in, and the one whose dock the device put it in.
    expect(text).toContain('started in scripts (inside project "api")');
    expect(text).toContain('in the dock of the user\'s device, under the project it shows ("web")');
    expect(text).toContain("Nothing runs until the user presses Enter");
    // The Assistant reads a terminal through its UI tools; it has no read_terminal.
    expect(text).toContain("ui_read_tab");
    expect(text).not.toContain("read_terminal");
  });

  it("starts in the project's own folder by default", async () => {
    const { created, call } = harness();
    await call({ project: "api", command: "ls" });
    expect(created[0]!.dir).toBe(project);
  });

  it("is refused while the user has run_in_terminal off, and creates no terminal", async () => {
    const { created, requests, call } = harness({ enabled: false });
    const result = await call({ project: "api", command: "ls" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("turned off in PPM's settings (Settings → Tools)");
    expect(result.content[0]!.text).toContain("run_in_terminal");
    expect(created).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("is refused in a turn that read text the user did not write, came from Telegram, PPM started, or is unknown", async () => {
    const cases: Array<[AssistantProvenance | undefined, string]> = [
      [{ startedBy: "user_ppm", untrusted: true, reason: "read" }, "text the user did not write reached this turn (read)"],
      [{ startedBy: "user_ppm", untrusted: true, reason: "forwarded" }, "(forwarded)"],
      [{ startedBy: "user_telegram", untrusted: false }, "this turn came from Telegram"],
      [{ startedBy: "ppm", untrusted: false }, UNATTENDED_TURN_REFUSAL],
      [undefined, "cannot tell who started this turn"],
    ];
    for (const [provenance, why] of cases) {
      const { created, requests, call } = harness();
      const result = await call({ project: "api", command: "ls" }, provenance);
      expect({ provenance, error: result.isError, says: result.content[0]!.text.includes(why) }).toEqual({ provenance, error: true, says: true });
      if (why !== UNATTENDED_TURN_REFUSAL) expect(result.content[0]!.text).toContain("Give the user the command to run instead");
      expect(created).toEqual([]);
      expect(requests).toEqual([]);
    }
  });

  it("is refused in an unattended turn", async () => {
    const { created, call } = harness({ unattended: true });
    const result = await call({ project: "api", command: "ls" });
    expect(result.content[0]!.text).toBe(UNATTENDED_TURN_REFUSAL);
    expect(created).toEqual([]);
  });

  it("refuses the Assistant's own project, an unregistered one, and a folder outside the project", async () => {
    const { created, call } = harness();
    for (const [args, says] of [
      [{ project: ASSISTANT_PROJECT_NAME, command: "ls" }, "The Assistant's own chats are not a project"],
      [{ project: "nope", command: "ls" }, 'No registered project is named "nope"'],
      [{ project: "api", command: "ls", cwd: outside }, 'must be a folder inside project "api"'],
      [{ project: "api", command: "ls", cwd: "../elsewhere" }, 'must be a folder inside project "api"'],
    ] as const) {
      const result = await call(args);
      expect({ says, error: result.isError, text: result.content[0]!.text.includes(says) }).toEqual({ says, error: true, text: true });
    }
    expect(created).toEqual([]);
  });

  it(`refuses a command over ${TERMINAL_TYPE_MAX_CHARS} characters, or one that could run by itself, before a terminal starts`, async () => {
    const { created, call } = harness();
    const exact = await call({ project: "api", command: "x".repeat(TERMINAL_TYPE_MAX_CHARS) });
    expect(exact.isError).toBeUndefined();
    for (const command of ["x".repeat(TERMINAL_TYPE_MAX_CHARS + 1), "echo a\nrm -rf ~", "echo ‮hi", ""]) {
      const result = await call({ project: "api", command });
      expect(result.isError).toBe(true);
    }
    expect((await call({ project: "api", command: "y".repeat(401) })).content[0]!.text).toContain("longer than 400 characters; write it to a script file");
    expect(created).toHaveLength(1);
  });

  it("is described as a change that takes nothing away, capped at 400 characters", () => {
    expect(TERMINAL_TYPE_TOOL_DEFINITION.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(JSON.stringify(TERMINAL_TYPE_TOOL_DEFINITION.inputSchema)).toContain('"maxLength":400');
    expect(TERMINAL_TYPE_TOOL_DEFINITION.description).toContain("run_in_terminal switch");
  });
});
