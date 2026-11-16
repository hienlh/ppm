/**
 * A Codex PPM Assistant session's approvals, end to end inside PPM: the provider's server-request
 * handler gets the requests exactly as Codex sends them (the Windows display string recorded in a
 * live trial, Linux's `bash -lc`, and the legacy `execCommandApproval` argv), and everything after
 * that is real — the switches saved through the settings service, the bash classifier, PowerShell's
 * own parser where this host has it, the turn-provenance tracker. Only the Codex process is not.
 *
 * The unit test beside the provider (`tests/unit/providers/codex-assistant-command-approval.test.ts`)
 * covers the same answers with the switches and the PowerShell judge stubbed; this one proves the
 * wiring between them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerProvider } from "../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import * as accounts from "../../src/services/codex-account.service.ts";
import * as assistantHome from "../../src/providers/codex-app-server/codex-assistant-home.ts";
import { configService } from "../../src/services/config.service.ts";
import { assistantPolicySwitches, saveAssistantSettings } from "../../src/services/assistant/assistant-settings.service.ts";
import { createCorpusFixture, q, type CorpusFixture } from "../unit/services/readonly-shell/adversarial-bash-corpus.ts";

const COMMAND = "item/commandExecution/requestApproval";
const LEGACY_COMMAND = "execCommandApproval";
const FILE_CHANGE = "item/fileChange/requestApproval";
const POWERSHELL_EXE = "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe";
const HAS_POWERSHELL = process.platform === "win32"
  && existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));

let fx: CorpusFixture;
let savedProjects: unknown;

/** The request Codex sent in the live trial on Windows, with only the script swapped. */
const windowsCommand = (itemId: string, script: string) => ({
  kind: "command", threadId: "01a1264f-74e7-7d32-9495-428fabbe2a86", turnId: "01a12650-4894-7112-a814-2778a7030a3d",
  itemId, startedAtMs: 1791644163947, environmentId: "local",
  command: `"${POWERSHELL_EXE}" -Command ${script}`,
  cwd: fx.proj, commandActions: [{ type: "unknown", command: script }],
  proposedExecpolicyAmendment: [script], availableDecisions: ["accept", "cancel"],
});
/** One POSIX shell word, as Codex shows a bash script on Linux and macOS. */
const posixWord = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
const linuxCommand = (itemId: string, script: string) => ({
  threadId: "t", turnId: "u", itemId, startedAtMs: 1, cwd: fx.proj, command: `/bin/bash -lc ${posixWord(script)}`,
});

function saveSwitches(autoReadonly: boolean, actOnOwn: boolean): void {
  const result = saveAssistantSettings({ auto_readonly_commands: autoReadonly, act_on_own: actOnOwn }, () => true);
  if (!result.ok) throw new Error(result.errors.join("; "));
  expect(assistantPolicySwitches()).toEqual({ autoReadonlyCommands: autoReadonly, actOnOwn });
}

beforeAll(() => {
  fx = createCorpusFixture();
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "p", path: fx.proj }] as never);
});
afterAll(() => {
  configService.set("projects", savedProjects as never);
  fx.cleanup();
});

describe("Codex Assistant approvals, real policy", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let provider: CodexAppServerProvider;
  let responses: Array<{ id: unknown; result?: unknown; error?: string }>;
  let previousAi: ReturnType<typeof configService.get<"ai">>;

  beforeEach(() => {
    saveSwitches(true, false);
    provider = new CodexAppServerProvider();
    responses = [];
    previousAi = configService.get("ai");
    configService.set("ai", { ...previousAi, providers: { ...previousAi.providers, codex: { type: "cli", cli_command: "codex" } } });
    spies.push(spyOn(accounts, "resolveCodexAccountForSession").mockResolvedValue(null));
    spies.push(spyOn(assistantHome, "assistantSpawnHome").mockImplementation((home) => home));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "respond").mockImplementation((id: any, result: any) => { responses.push({ id, result }); }));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "respondError").mockImplementation((id: any, error: any) => { responses.push({ id, error }); }));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method: string) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") return { thread: { id: `thread-${crypto.randomUUID()}` } };
      return {};
    }));
  });
  afterEach(() => {
    provider.cleanupAll();
    configService.set("ai", previousAi);
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  async function live() {
    const session = await (provider as any).connect((await provider.createSession({})).id, {
      assistantSession: true, assistantInstructions: "# PPM Assistant",
    });
    const pushed: any[] = [];
    session.channel.push = (event: unknown) => { pushed.push(event); };
    return { session, pushed };
  }

  /** Sends one server request and waits (PowerShell's parser may be cold) until it is answered or carded. */
  async function request(session: any, pushed: any[], id: number, method: string, params: unknown) {
    const cards = pushed.length;
    (provider as any).handleServerRequest(session, { id, method, params });
    for (let i = 0; i < 1500 && !responses.some((r) => r.id === id) && pushed.length === cards; i++) await new Promise((r) => setTimeout(r, 5));
  }
  const answerOf = (id: number) => responses.find((r) => r.id === id)?.result;

  it("Linux bash -lc: a read is accepted with no card, a write and an unknown wrapper are carded", async () => {
    const { session, pushed } = await live();
    await request(session, pushed, 1, COMMAND, linuxCommand("read", `git -C ${q(fx.proj)} log --oneline -3`));
    expect(answerOf(1)).toEqual({ decision: "accept" });
    await request(session, pushed, 2, COMMAND, linuxCommand("write", `sort -o ${q(join(fx.proj, "a.json"))} ${q(join(fx.proj, "a.json"))}`));
    await request(session, pushed, 3, COMMAND, { ...linuxCommand("zsh", "ls"), command: "/bin/zsh -lc 'ls'" });
    await request(session, pushed, 4, COMMAND, { ...linuxCommand("env", "ls"), command: "/usr/bin/env bash -lc 'ls'" });
    expect(responses.map((r) => r.id)).toEqual([1]);
    expect(pushed.map((e) => [e.type, e.tool])).toEqual([["approval_request", "Bash"], ["approval_request", "Bash"], ["approval_request", "Bash"]]);
  });

  it("legacy execCommandApproval argv: a read is accepted, a write is carded", async () => {
    const { session, pushed } = await live();
    await request(session, pushed, 5, LEGACY_COMMAND, { conversationId: "c", callId: "call-r", cwd: fx.proj, command: ["bash", "-lc", `cat ${q(join(fx.proj, "a.json"))}`] });
    await request(session, pushed, 6, LEGACY_COMMAND, { conversationId: "c", callId: "call-w", cwd: fx.proj, command: ["bash", "-lc", `rm ${q(join(fx.proj, "a.json"))}`] });
    expect(answerOf(5)).toEqual({ decision: "approved" });
    expect(answerOf(6)).toBeUndefined();
    expect(pushed).toHaveLength(1);
  });

  it("Windows display string: judged by PowerShell's own parser where this host has it", async () => {
    const { session, pushed } = await live();
    await request(session, pushed, 7, COMMAND, windowsCommand("ps-read", `Get-ChildItem -LiteralPath '${fx.proj}'`));
    await request(session, pushed, 8, COMMAND, windowsCommand("ps-write", `Set-Content -LiteralPath '${join(fx.proj, "a.json")}' -Value x`));
    // An argument with a double quote is not shown as PowerShell receives it.
    await request(session, pushed, 9, COMMAND, { ...windowsCommand("ps-quote", "dir"), command: `"${POWERSHELL_EXE}" -Command "dir" x` });
    if (HAS_POWERSHELL) {
      expect(answerOf(7)).toEqual({ decision: "accept" });
      expect(pushed).toHaveLength(2);
    } else {
      // No parser on this host: PowerShell commands keep their card.
      expect(answerOf(7)).toBeUndefined();
      expect(pushed).toHaveLength(3);
    }
    expect(answerOf(8)).toBeUndefined();
    expect(answerOf(9)).toBeUndefined();
  }, 30_000);

  it("asks for a read while the read-only switch is off", async () => {
    saveSwitches(false, false);
    const { session, pushed } = await live();
    await request(session, pushed, 10, COMMAND, linuxCommand("read", `git -C ${q(fx.proj)} status`));
    expect(responses).toEqual([]);
    expect(pushed).toHaveLength(1);
  });

  it("declines a file change with no card while act_on_own is off, and while no user turn is running", async () => {
    const { session, pushed } = await live();
    await request(session, pushed, 11, FILE_CHANGE, { threadId: "t", turnId: "u", itemId: "f1" });
    expect(answerOf(11)).toEqual({ decision: "decline" });
    // On, but nothing the user typed opened this turn: the tracker has never seen it, which fails closed.
    saveSwitches(true, true);
    await request(session, pushed, 12, FILE_CHANGE, { threadId: "t", turnId: "u", itemId: "f2" });
    expect(answerOf(12)).toEqual({ decision: "decline" });
    expect(pushed).toEqual([]);
  });
});
