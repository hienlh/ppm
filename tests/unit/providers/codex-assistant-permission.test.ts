/**
 * A PPM Assistant session on Codex runs read-only with every untrusted command asking first,
 * whatever mode was asked for, and never without its instructions: a codex too old to take
 * `developerInstructions` fails the session with a reason — at connect, and again when an
 * account switch respawns the app-server — instead of quietly running it as an ordinary chat.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import { ASSISTANT_PERMISSION, permissionModeToCodex } from "../../../src/providers/codex-app-server/codex-permission-map.ts";
import {
  REQUIRED_INSTRUCTIONS_UNSUPPORTED, RequiredInstructionsError, requestWithInstructionsFallback,
} from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import * as accounts from "../../../src/services/codex-account.service.ts";
import { setSessionMetadata } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import type { ChatEvent } from "../../../src/types/chat.ts";

const ASSISTANT_OPTS = {
  assistantSession: true, assistantInstructions: "# PPM Assistant", permissionMode: "bypassPermissions",
  tabToolsMcp: { url: "http://127.0.0.1:1/api/tab-tools-mcp", token: "t" },
};
const UNKNOWN_FIELD = "unknown field `developerInstructions`";

describe("Codex Assistant permission profile", () => {
  it("is read-only and asks before untrusted commands, whatever mode was asked for", () => {
    expect(ASSISTANT_PERMISSION).toEqual({ sandbox: "read-only", approvalPolicy: "untrusted" });
    for (const mode of ["bypassPermissions", "acceptEdits", "default", "plan", "nonsense", undefined]) {
      expect(permissionModeToCodex(mode, { assistantSession: true })).toEqual(ASSISTANT_PERMISSION);
      expect(permissionModeToCodex(mode, { assistantSession: true, designSession: true })).toEqual(ASSISTANT_PERMISSION);
    }
    expect(permissionModeToCodex("bypassPermissions", { assistantSession: false }))
      .toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
  });
});

describe("required instructions", () => {
  it("refuses instead of retrying without them", async () => {
    let calls = 0;
    await expect(requestWithInstructionsFallback({ cwd: "/p", developerInstructions: "# A" }, async () => {
      calls++;
      throw new Error(UNKNOWN_FIELD);
    }, () => {}, true)).rejects.toThrow(REQUIRED_INSTRUCTIONS_UNSUPPORTED);
    expect(calls).toBe(1);
  });

  it("refuses params that carry none, before sending anything", async () => {
    let calls = 0;
    await expect(requestWithInstructionsFallback({ cwd: "/p" }, async () => { calls++; return "x"; }, () => {}, true))
      .rejects.toBeInstanceOf(RequiredInstructionsError);
    expect(calls).toBe(0);
  });
});

describe("Codex Assistant session", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let provider: CodexAppServerProvider;
  let internal: any;
  let params: Array<{ method: string; value: any }>;
  let oldCodex: boolean;
  let previousAi: ReturnType<typeof configService.get<"ai">>;

  beforeEach(() => {
    provider = new CodexAppServerProvider();
    internal = provider;
    params = [];
    oldCodex = false;
    previousAi = configService.get("ai");
    configService.set("ai", { ...previousAi, providers: { ...previousAi.providers, codex: { type: "cli", cli_command: "codex" } } });
    spies.push(spyOn(accounts, "resolveCodexAccountForSession").mockResolvedValue(null));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method: string, value: any) => {
      params.push({ method, value });
      if ((method === "thread/start" || method === "thread/resume") && oldCodex && value?.developerInstructions) {
        throw new Error(UNKNOWN_FIELD);
      }
      if (method === "thread/start") return { thread: { id: `thread-${crypto.randomUUID()}` } };
      return {};
    }));
  });

  afterEach(() => {
    provider.cleanupAll();
    configService.set("ai", previousAi);
    spies.splice(0).forEach((spy) => spy.mockRestore());
  });

  it("starts read-only with its instructions and no tab tools, and remembers they are required", async () => {
    const live = await internal.connect((await provider.createSession({})).id, ASSISTANT_OPTS);
    const start = params.find((p) => p.method === "thread/start")!.value;
    expect(start).toMatchObject({ sandbox: "read-only", approvalPolicy: "untrusted", developerInstructions: "# PPM Assistant" });
    // No tab tools; codex's own web search off (the Assistant's tools come with an endpoint).
    expect(start.config).toEqual({ web_search: "disabled" });
    expect(live.requireInstructions).toBe(true);
    expect(live.tabToolsMcp).toBeUndefined();
  });

  it("fails the turn with the reason on a codex that refuses the instructions", async () => {
    oldCodex = true;
    const session = await provider.createSession({});
    const events: ChatEvent[] = [];
    for await (const event of provider.sendMessage(session.id, "hi", ASSISTANT_OPTS)) events.push(event);
    expect(events[0]).toEqual({ type: "error", message: REQUIRED_INSTRUCTIONS_UNSUPPORTED });
    expect(params.filter((p) => p.method === "thread/start")).toHaveLength(1);
  });

  it("refuses the same codex after an account switch rather than resuming without the instructions", async () => {
    const id = crypto.randomUUID();
    const make = (name: string): accounts.CodexAccount => ({
      id: `${name}-${id}`, label: name, home: join(process.env.PPM_HOME!, `${name}-${id}`),
      type: "apiKey", planType: null, status: "active", addedAt: new Date().toISOString(),
    });
    const source = make("source");
    const target = make("target");
    mkdirSync(join(source.home, "sessions"), { recursive: true });
    writeFileSync(join(source.home, "sessions", `rollout-test-${id}.jsonl`), JSON.stringify({
      type: "session_meta", payload: { id, cwd: process.cwd(), timestamp: new Date().toISOString() },
    }) + "\n");
    spies.push(spyOn(accounts, "listCodexAccounts").mockReturnValue([source, target]));
    setSessionMetadata(id, "__assistant__", process.cwd());
    await provider.resumeSession(id);
    const live = await internal.connect(id, ASSISTANT_OPTS);

    oldCodex = true; // the account switched to runs an older codex
    await expect(internal.respawnOn(live, id, target)).rejects.toThrow(REQUIRED_INSTRUCTIONS_UNSUPPORTED);
    const resumes = params.filter((p) => p.method === "thread/resume");
    expect(resumes).toHaveLength(2);
    expect(resumes.every((p) => p.value.developerInstructions === "# PPM Assistant")).toBe(true);
  });

  it("reports that reason, not a usage limit, when the rotation fails on it", async () => {
    const pushed: ChatEvent[] = [];
    const live: any = {
      client: { isClosed: false, close() {}, request: async () => ({}) },
      threadId: "s-asst", cwd: process.cwd(),
      channel: { push: (ev: ChatEvent) => pushed.push(ev), done: () => {}, iterator: null },
      permission: ASSISTANT_PERMISSION, requireInstructions: true, pendingApprovals: new Map(), answeredCodexIds: new Set(),
      history: [], transcript: [], currentAssistant: "", currentEvents: [], pendingTurns: [], subagentThreadIds: new Set(), rotating: true,
    };
    internal.live.set("s-asst", live);
    const next = { id: "next", label: "next", home: "/nowhere", type: "apiKey", planType: null, status: "active", addedAt: "" };
    spies.push(spyOn(accounts, "getAllCodexUsages").mockResolvedValue({}));
    spies.push(spyOn(accounts, "selectCodexAccount").mockReturnValue(next as accounts.CodexAccount));
    internal.respawnOn = async () => { throw new RequiredInstructionsError(); };
    await internal.rotateAccount(live, "s-asst", null, "usage limit reached", "usage");
    expect(pushed.find((e) => e.type === "error")).toEqual({ type: "error", message: REQUIRED_INSTRUCTIONS_UNSUPPORTED });
  });
});
