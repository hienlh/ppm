/**
 * The Assistant's command tools on the server: the device's own list decides whether a command
 * changes data, read before anything runs; such a command runs only once the user approves a
 * card the server built from that entry, and the run request then carries the approval — never
 * on the agent's say-so. Unknown ids and a missing device run nothing.
 */
import { describe, expect, it } from "bun:test";
import { UI_COMMAND_WAIT_MS, uiListCommands, uiRunCommand } from "../../../src/services/assistant-mcp/assistant-ui-command-tools.ts";
import { ASSISTANT_UI_NO_DEVICE_MESSAGE, type AssistantUiBody, type AssistantUiOutcome } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import { noApprover, type ApprovalAsk, type ApprovalVerdict } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";

const text = (result: any): string => result.content[0].text;

/** A device with these commands, recording every request and answering like the browser would. */
function device(commands: Array<{ id: string; label: string; changesData: unknown; hint?: string }>, project: string | null = "api") {
  const asked: Array<{ sessionId: string; body: AssistantUiBody; waitMs: number }> = [];
  const request = async (sessionId: string, body: AssistantUiBody, waitMs: number): Promise<AssistantUiOutcome> => {
    asked.push({ sessionId, body, waitMs });
    const ok = (data: unknown): AssistantUiOutcome => ({ ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data } });
    if (body.op === "list_commands") {
      const id = body.args.id;
      const list = id === undefined ? commands : commands.filter((c) => c.id === id);
      return ok({ project, commands: list, total: list.length });
    }
    const cmd = commands.find((c) => c.id === body.args.id)!;
    return ok({ ran: true, id: cmd.id, label: cmd.label, project });
  };
  return { asked, request };
}

const noDevice = async (): Promise<AssistantUiOutcome> => ({ ok: false, reason: "no-device", message: ASSISTANT_UI_NO_DEVICE_MESSAGE } as AssistantUiOutcome);

function asker(verdict: ApprovalVerdict) {
  const asks: ApprovalAsk[] = [];
  return { asks, ask: async (a: ApprovalAsk) => { asks.push(a); return verdict; } };
}

const COMMANDS = [
  { id: "settings", label: "Settings", changesData: false },
  { id: "word-wrap", label: "Toggle Word Wrap", changesData: true },
  { id: "ext:git.pull", label: "Pull", hint: "Git", changesData: false },
];

describe("the command tools", () => {
  it("are served after ui_read_tab; listing reads, running may change data", () => {
    const names = ASSISTANT_TOOL_DEFINITIONS.map((d) => d.name);
    expect(names.slice(names.indexOf("ui_read_tab") + 1, names.indexOf("ui_read_tab") + 3)).toEqual(["ui_list_commands", "ui_run_command"]);
    const def = (name: string) => ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === name)!;
    expect(def("ui_list_commands").annotations).toMatchObject({ readOnlyHint: true });
    expect(def("ui_run_command").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe("ui_list_commands", () => {
  it("passes the query on and answers the device's list, an extension's command as changing data", async () => {
    const d = device(COMMANDS);
    const result = await uiListCommands("s1", { query: "  wrap  " }, d.request);
    expect(d.asked).toEqual([{ sessionId: "s1", waitMs: UI_COMMAND_WAIT_MS, body: { op: "list_commands", args: { query: "wrap" } } }]);
    const data = JSON.parse(text(result));
    expect(data.project).toBe("api");
    expect(data.commands).toEqual([
      { id: "settings", label: "Settings", changesData: false },
      { id: "word-wrap", label: "Toggle Word Wrap", changesData: true },
      { id: "ext:git.pull", label: "Pull", hint: "Git", changesData: true },
    ]);
  });

  it("answers no-device without inventing a list", async () => {
    const result = await uiListCommands("s1", {}, noDevice);
    expect((result as any).isError).toBe(true);
    expect(text(result)).toContain("no-device");
  });
});

describe("ui_run_command", () => {
  it("runs a command that changes nothing without asking", async () => {
    const d = device(COMMANDS);
    const a = asker({ verdict: "approved" });
    const result = await uiRunCommand("s1", { id: "settings" }, a.ask, d.request);
    expect(a.asks).toEqual([]);
    expect(d.asked.map((x) => x.body)).toEqual([
      { op: "list_commands", args: { id: "settings" } },
      { op: "run_command", args: { id: "settings" } },
    ]);
    expect(JSON.parse(text(result))).toMatchObject({ ran: true, id: "settings", label: "Settings", project: "api", changesData: false });
  });

  it("refuses an id the device does not offer, running nothing", async () => {
    const d = device(COMMANDS);
    const a = asker({ verdict: "approved" });
    const result = await uiRunCommand("s1", { id: "format-disk" }, a.ask, d.request);
    expect((result as any).isError).toBe(true);
    expect(text(result)).toContain("No command \"format-disk\"");
    expect(d.asked.map((x) => x.body.op)).toEqual(["list_commands"]);
    expect(a.asks).toEqual([]);
  });

  it("refuses a malformed id or arguments without asking the device", async () => {
    const d = device(COMMANDS);
    for (const args of [{}, { id: "" }, { id: 7 }, { id: "a\nb" }, { id: "x".repeat(201) }, { id: "settings", args: { force: true } }]) {
      expect(((await uiRunCommand("s1", args, noApprover, d.request)) as any).isError).toBe(true);
    }
    expect(d.asked).toEqual([]);
  });

  it("asks before a command that changes data, with a card built from the device's entry, then runs it approved", async () => {
    const d = device(COMMANDS);
    const a = asker({ verdict: "approved" });
    const result = await uiRunCommand("s1", { id: "word-wrap" }, a.ask, d.request);
    expect(a.asks).toHaveLength(1);
    expect(a.asks[0]!.tool).toBe("ui_run_command");
    expect(a.asks[0]!.input).toEqual({ id: "word-wrap" });
    expect(a.asks[0]!.summary.headline).toBe('Run the PPM command "Toggle Word Wrap" on your device');
    expect(a.asks[0]!.summary.facts).toEqual([
      { label: "Command", value: "Toggle Word Wrap" }, { label: "Id", value: "word-wrap" }, { label: "Project", value: "api" },
    ]);
    expect(d.asked[1]!.body).toEqual({ op: "run_command", args: { id: "word-wrap", approved: true, approvedLabel: "Toggle Word Wrap" } });
    expect(JSON.parse(text(result))).toMatchObject({ ran: true, id: "word-wrap", changesData: true });
  });

  it("asks before every extension command, whatever the device reported", async () => {
    const d = device(COMMANDS);
    const a = asker({ verdict: "approved" });
    await uiRunCommand("s1", { id: "ext:git.pull" }, a.ask, d.request);
    expect(a.asks).toHaveLength(1);
    expect(a.asks[0]!.summary.headline).toBe('Run the extension command "Pull" on your device');
    expect(a.asks[0]!.summary.warning).toContain("PPM cannot see what it changes");
    expect(d.asked[1]!.body.args).toEqual({ id: "ext:git.pull", approved: true, approvedLabel: "Pull" });
  });

  it("asks when the device's answer does not say false", async () => {
    const d = device([{ id: "odd", label: "Odd", changesData: "no" }]);
    const a = asker({ verdict: "denied", reason: "declined" });
    await uiRunCommand("s1", { id: "odd" }, a.ask, d.request);
    expect(a.asks).toHaveLength(1);
  });

  it("runs nothing when the user declines, does not answer, or there is nobody to ask", async () => {
    for (const verdict of [
      { verdict: "denied", reason: "The user declined." },
      { verdict: "timeout", reason: "No answer." },
      { verdict: "withdrawn", reason: "Withdrawn." },
    ] as const) {
      const d = device(COMMANDS);
      const result = await uiRunCommand("s1", { id: "word-wrap" }, asker(verdict).ask, d.request);
      expect((result as any).isError).toBe(true);
      expect(d.asked.map((x) => x.body.op)).toEqual(["list_commands"]);
    }
    const d = device(COMMANDS);
    await uiRunCommand("s1", { id: "ext:git.pull" }, noApprover, d.request);
    expect(d.asked.map((x) => x.body.op)).toEqual(["list_commands"]);
  });

  it("answers no-device without running or asking", async () => {
    const a = asker({ verdict: "approved" });
    const result = await uiRunCommand("s1", { id: "word-wrap" }, a.ask, noDevice);
    expect(text(result)).toContain("no-device");
    expect(a.asks).toEqual([]);
  });

  it("does not ask the device again when a run times out, and says it may have run", async () => {
    let runs = 0;
    const request = async (_s: string, body: AssistantUiBody): Promise<AssistantUiOutcome> => {
      if (body.op === "list_commands") return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data: { project: null, commands: [COMMANDS[0]], total: 1 } } };
      runs++;
      return { ok: false, reason: "timeout", message: "The user's device did not answer within 15 s." } as AssistantUiOutcome;
    };
    const result = await uiRunCommand("s1", { id: "settings" }, noApprover, request);
    expect(runs).toBe(1);
    expect(text(result)).toContain("may still have run");
  });
});
