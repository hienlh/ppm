import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AntigravityProvider } from "../../../src/providers/antigravity/antigravity-provider.ts";
import { agyStoreArgs } from "../../../src/providers/antigravity/acp-launch.ts";
import { mapAcpUpdate, newToolState } from "../../../src/providers/antigravity/acp-event-mapper.ts";
import { agySlashItems, parseAgyCommands, rememberAgyCommands } from "../../../src/providers/antigravity/antigravity-commands.ts";
import { createAntigravityAccount, removeAntigravityAccount } from "../../../src/services/antigravity-account.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getConfigValue, getSessionAccount, openTestDb, setDb } from "../../../src/services/db.service.ts";
import type { ChatEvent } from "../../../src/types/chat.ts";

const FAKE_AGY = resolve(import.meta.dir, "../../fixtures/fake-agy-acp.ts");
const NEW_ID = "4d0c6a5e-1111-4222-8333-444455556666";

/** Drains a chat's generator in the background; it stays open across turns until the chat is stopped. */
function consume(iterable: AsyncIterable<ChatEvent>) {
  const events: ChatEvent[] = [];
  let ended = false;
  const finished = (async () => {
    for await (const ev of iterable) events.push(ev);
    ended = true;
  })();
  const until = async (pred: (evs: ChatEvent[]) => boolean, timeoutMs = 8000) => {
    const start = Date.now();
    while (!pred(events)) {
      if (ended || Date.now() - start > timeoutMs) {
        throw new Error(`condition not met (ended=${ended}); events: ${JSON.stringify(events).slice(0, 2000)}`);
      }
      await Bun.sleep(5);
    }
  };
  return { events, finished, until, isEnded: () => ended };
}

const dones = (evs: ChatEvent[]) => evs.filter((e) => e.type === "done");
const texts = (evs: ChatEvent[]) => evs.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text").map((e) => e.content);

describe("AntigravityProvider over agy acp", () => {
  let tempHome: string;
  let projectDir: string;
  let logFile: string;

  const provider = (extra: string[] = []) => new AntigravityProvider({
    customHome: tempHome,
    agyCommand: [process.execPath, FAKE_AGY, "--log", logFile, "--session-id", NEW_ID, ...extra],
  });
  const received = () => existsSync(logFile)
    ? readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>)
    : [];
  const calls = (method: string) => received().filter((m) => m.method === method);

  beforeEach(() => {
    setDb(openTestDb());
    tempHome = mkdtempSync(join(tmpdir(), "ppm-agy-acp-"));
    projectDir = join(tempHome, "workspace", "app");
    mkdirSync(projectDir, { recursive: true });
    logFile = join(tempHome, "agy.log");
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    // The slash commands a chat stored would otherwise reach the next test file in this process.
    setDb(openTestDb());
  });

  it("streams a new chat's turn under agy's session id and keeps the process for the next turn", async () => {
    const p = provider();
    const session = await p.createSession({ projectPath: projectDir });
    const run = consume(p.sendMessage(session.id, "hello there"));
    await run.until((evs) => dones(evs).length === 1);

    expect(run.events[0]).toEqual({ type: "session_migrated", oldSessionId: session.id, newSessionId: NEW_ID });
    expect(run.events[1]).toEqual({ type: "system", subtype: "init" });
    expect(run.events.slice(2, 5)).toEqual([
      { type: "thinking", content: "Greeting the user" },
      { type: "text", content: "Hel" },
      { type: "text", content: "lo" },
    ]);
    const done = run.events[5] as Extract<ChatEvent, { type: "done" }>;
    expect(done).toMatchObject({ type: "done", sessionId: NEW_ID, resultSubtype: "success" });
    expect(done.usage).toMatchObject({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 300 });

    // The title agy gave the chat replaces the first-line placeholder.
    expect((await p.resumeSession(NEW_ID)).title).toBe("Greeting Exchange");

    const init = calls("initialize")[0]!;
    expect(init.params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(calls("session/new")[0]!.params).toEqual({ cwd: projectDir, mcpServers: [] });
    expect(calls("session/set_model").map((m) => m.params.modelId)).toEqual(["gemini-4-argon-high"]);

    // The generator outlives the turn; a follow-up runs on the same process, under either id.
    expect(run.isEnded()).toBe(false);
    expect(p.hasStreamingSession(session.id)).toBe(true);
    expect(p.hasStreamingSession(NEW_ID)).toBe(true);
    p.pushMessage(session.id, "tool please");
    await run.until((evs) => dones(evs).length === 2);
    expect(calls("initialize")).toHaveLength(1);
    expect(calls("session/set_model")).toHaveLength(1);

    p.abortQuery(NEW_ID);
    await run.finished;
    expect(p.hasStreamingSession(NEW_ID)).toBe(false);
    expect(p.hasStreamingSession(session.id)).toBe(false);
  });

  it("hands agy PPM's tab and database tools as http MCP servers, the token in a header", async () => {
    const p = provider();
    const session = await p.createSession({ projectPath: projectDir });
    const run = consume(p.sendMessage(session.id, "hello there", {
      tabToolsMcp: { url: "http://127.0.0.1:1/api/tab-tools-mcp", token: "tab-token" },
      dbToolsMcp: { url: "http://127.0.0.1:1/api/db-tools-mcp", token: "db-token" },
    }));
    await run.until((evs) => dones(evs).length === 1);
    expect(calls("session/new")[0]!.params.mcpServers).toEqual([
      { type: "http", name: "ppm-tabs", url: "http://127.0.0.1:1/api/tab-tools-mcp", headers: [{ name: "Authorization", value: "Bearer tab-token" }] },
      { type: "http", name: "ppm-db", url: "http://127.0.0.1:1/api/db-tools-mcp", headers: [{ name: "Authorization", value: "Bearer db-token" }] },
    ]);
    // Not on agy's command line, which any process on the machine can read.
    expect(JSON.stringify(received()[0])).not.toContain("tab-token");
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("shows a tool call once, with its result, however many updates agy sends for it", async () => {
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "tool please"));
    await run.until((evs) => dones(evs).length === 1);
    const toolEvents = run.events.filter((e) => e.type === "tool_use" || e.type === "tool_result");
    expect(toolEvents).toEqual([
      {
        type: "tool_use",
        tool: "Bash",
        input: expect.objectContaining({ command: "ls -la", description: "List files" }),
        toolUseId: "call_1",
      },
      { type: "tool_result", toolUseId: "call_1", output: "Command exited with code 0.\n\nCommand output:\nREADME.md\n", exitCode: 0 },
    ]);
    expect(texts(run.events)).toEqual(["One file."]);
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("continues a chat on disk with session/load, in the store its files are in, and shows none of the replay", async () => {
    const existingId = "0e2b9b41-aaaa-4bbb-8ccc-000000000001";
    const store = join(tempHome, ".gemini", "antigravity");
    const logs = join(store, "brain", existingId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>an old question</USER_REQUEST>" })}\n`);
    const db = new Database(join(store, "conversation_summaries.db"));
    db.run("PRAGMA user_version = 3");
    db.close();

    const p = provider();
    await p.resumeSession(existingId);
    p.ensureProjectPath(existingId, projectDir);
    const run = consume(p.sendMessage(existingId, "hello again", { sharedContext: "Rule: be brief." }));
    await run.until((evs) => dones(evs).length === 1);

    expect(run.events.some((e) => e.type === "session_migrated")).toBe(false);
    expect(texts(run.events)).toEqual(["Hel", "lo"]);
    expect(run.events.some((e) => e.type === "tool_use")).toBe(false);
    expect(dones(run.events)[0]).toMatchObject({ sessionId: existingId, resultSubtype: "success" });
    // agy takes a system prompt only from session/new, so a chat it already has gets the context in the message.
    expect(calls("session/load")[0]!.params).toEqual({ sessionId: existingId, cwd: projectDir, mcpServers: [] });
    expect(calls("session/prompt")[0]!.params.prompt).toEqual([{ type: "text", text: "<ppm-shared-context>\nRule: be brief.\n</ppm-shared-context>\n\nhello again" }]);
    expect(calls("session/new")).toHaveLength(0);
    expect(received()[0]!.argv.slice(-3)).toEqual(["acp", "--app-data-dir", "antigravity"]);
    // The commands agy named while it replayed the chat are kept, unlike the replay itself.
    expect(agySlashItems(projectDir)?.map((i) => i.name)).toEqual(["goal", "compact"]);
    p.abortQuery(existingId);
    await run.finished;
  });

  it("gives a new chat the Additional Instructions and the shared context as its system prompt, not in the message", async () => {
    const previousAi = configService.get("ai");
    configService.set("ai", { ...previousAi, providers: { ...previousAi.providers,
      antigravity: { ...previousAi.providers.antigravity!, system_prompt: "Answer in English." } } });
    try {
      const p = provider();
      const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "hello there", { sharedContext: "Rule: be brief." }));
      await run.until((evs) => dones(evs).length === 1);
      expect(calls("session/new")[0]!.params._meta).toEqual({ antigravity: { systemPrompt: {
        append: "Answer in English.\n\n<ppm-shared-context>\nRule: be brief.\n</ppm-shared-context>",
      } } });
      expect(calls("session/prompt")[0]!.params.prompt).toEqual([{ type: "text", text: "hello there" }]);

      // A context that changed afterwards can only go in a message: agy never reads the system prompt again.
      p.pushMessage(NEW_ID, "tool please", { sharedContext: "Rule: be very brief." });
      await run.until((evs) => dones(evs).length === 2);
      expect(calls("session/prompt")[1]!.params.prompt).toEqual([{ type: "text", text: "<ppm-shared-context>\nRule: be very brief.\n</ppm-shared-context>\n\ntool please" }]);
      p.abortQuery(NEW_ID);
      await run.finished;
    } finally {
      configService.set("ai", previousAi);
    }
  });

  it("reports /compact as a compaction, since agy compacts without sending anything", async () => {
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "/compact"));
    await run.until((evs) => dones(evs).length === 1);
    expect(calls("session/prompt")[0]!.params.prompt).toEqual([{ type: "text", text: "/compact" }]);
    const order = run.events.map((e) => e.type === "system" ? e.subtype : e.type);
    expect(order).toEqual(["session_migrated", "init", "compacting", "compact_done", "done"]);
    expect(dones(run.events)[0]).toMatchObject({ resultSubtype: "success" });
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("offers the commands agy named in the picker, in place of the disk scan, with PPM's own commands", async () => {
    const { listSlashItemsForProvider } = await import("../../../src/services/slash-items-for-provider.ts");
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "hello"));
    await run.until((evs) => dones(evs).length === 1);
    p.abortQuery(NEW_ID);
    await run.finished;

    const items = await listSlashItemsForProvider(projectDir, "antigravity", undefined);
    expect(items.slice(0, 2)).toEqual([
      { type: "command", name: "goal", description: "Run until the specified goal is completely finished.", argumentHint: "the goal", scope: "bundled" },
      { type: "command", name: "compact", description: "Compact the conversation now.", scope: "bundled" },
    ]);
    expect(items.slice(2).map((i) => i.name).sort()).toEqual(["clear", "skills", "version"]);
  });

  it("continues an extra account's chat on that account's home and its file sign-in", async () => {
    const acctHome = join(tempHome, "acct-home");
    mkdirSync(acctHome, { recursive: true });
    createAntigravityAccount({ id: "acct-acp", label: "Second", email: "second@example.com", home: acctHome });
    try {
      const chatId = "0e2b9b41-aaaa-4bbb-8ccc-000000000002";
      const logs = join(acctHome, ".gemini", "antigravity", "brain", chatId, ".system_generated", "logs");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "transcript.jsonl"), `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>hi</USER_REQUEST>" })}\n`);

      const p = new AntigravityProvider({ agyCommand: [process.execPath, FAKE_AGY, "--log", logFile] });
      await p.resumeSession(chatId);
      p.ensureProjectPath(chatId, projectDir);
      const run = consume(p.sendMessage(chatId, "env check"));
      await run.until((evs) => dones(evs).length === 1);

      expect(run.events[0]).toMatchObject({ type: "account_info", accountId: "acct-acp" });
      expect(JSON.parse(texts(run.events)[0]!)).toMatchObject({ home: acctHome, wsl: "ppm", aiChat: "1" });
      expect(calls("session/load")[0]!.params.sessionId).toBe(chatId);
      expect(getSessionAccount(chatId)).toBe("acct-acp");
      p.abortQuery(chatId);
      await run.finished;
    } finally {
      removeAntigravityAccount("acct-acp");
    }
  });

  it("Stop cancels the running turn in agy and ends the chat's stream without a success", async () => {
    const p = provider();
    const session = await p.createSession({ projectPath: projectDir });
    const run = consume(p.sendMessage(session.id, "long story"));
    await run.until((evs) => texts(evs).length >= 3);
    p.abortQuery(session.id);
    await run.finished;

    expect(dones(run.events)).toHaveLength(0);
    // The cancel goes out before the process is closed, so agy records the turn as stopped.
    await Bun.sleep(100);
    expect(calls("session/cancel").map((m) => m.params)).toEqual([{ sessionId: NEW_ID }]);
  });

  it("queues a message sent mid-turn behind the running reply and ends the turn once, after both", async () => {
    const p = provider();
    const session = await p.createSession({ projectPath: projectDir });
    const run = consume(p.sendMessage(session.id, "slow first"));
    await run.until((evs) => texts(evs).includes("A0 "));
    p.pushMessage(NEW_ID, "slow second");
    await run.until((evs) => dones(evs).length === 1);
    await Bun.sleep(150);

    // agy answers the first prompt as soon as the second arrives, while its reply still streams.
    expect(dones(run.events)).toHaveLength(1);
    expect(texts(run.events).join("")).toBe("A0 A1 A2 A3 A4 A5 B0 B1 B2 B3 B4 B5 ");
    expect(run.events.at(-1)).toMatchObject({ type: "done", resultSubtype: "success", usage: expect.objectContaining({ inputTokens: 1200 }) });
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("asks the user before a tool agy wants approved, and sends back the answer", async () => {
    const p = provider();
    const session = await p.createSession({ projectPath: projectDir });
    const run = consume(p.sendMessage(session.id, "perm check", { permissionMode: "default" }));
    await run.until((evs) => evs.some((e) => e.type === "approval_request"));
    const ask = run.events.find((e) => e.type === "approval_request") as Extract<ChatEvent, { type: "approval_request" }>;
    expect(ask.tool).toBe("Bash");
    expect(ask.input).toMatchObject({ command: "rm -rf build" });

    p.resolveApproval(ask.requestId, false);
    await run.until((evs) => dones(evs).length === 1);
    expect(texts(run.events)).toEqual(["permission: deny"]);
    expect(run.events.find((e) => e.type === "tool_result")).toMatchObject({ toolUseId: "call_2", isError: true });

    p.pushMessage(NEW_ID, "perm again", { permissionMode: "default" });
    await run.until((evs) => evs.filter((e) => e.type === "approval_request").length === 2);
    const second = run.events.filter((e) => e.type === "approval_request")[1] as Extract<ChatEvent, { type: "approval_request" }>;
    p.resolveApproval(second.requestId, true);
    await run.until((evs) => dones(evs).length === 2);
    expect(texts(run.events).at(-1)).toBe("permission: allow");
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("answers agy's approvals itself in bypass mode", async () => {
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "perm check", { permissionMode: "bypassPermissions" }));
    await run.until((evs) => dones(evs).length === 1);
    expect(run.events.some((e) => e.type === "approval_request")).toBe(false);
    expect(texts(run.events)).toEqual(["permission: allow"]);
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("sends images ahead of the text", async () => {
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "image test", {
      images: [{ data: "iVBORw0KGgo=", mediaType: "image/png" }],
    }));
    await run.until((evs) => dones(evs).length === 1);
    expect(texts(run.events)).toEqual(["image:image/png,text"]);
    const blocks = calls("session/prompt")[0]!.params.prompt;
    expect(blocks[0]).toEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("gives agy only an allowlisted environment, marked as an AI chat", async () => {
    process.env.FAKE_AGY_SECRET = "must-not-leak";
    try {
      const p = provider();
      const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "env check"));
      await run.until((evs) => dones(evs).length === 1);
      expect(JSON.parse(texts(run.events)[0]!)).toEqual({ home: tempHome, wsl: null, aiChat: "1", secret: null });
      p.abortQuery(NEW_ID);
      await run.finished;
    } finally {
      delete process.env.FAKE_AGY_SECRET;
    }
  });

  it("refuses agy's file-system requests, since agy runs its tools itself", async () => {
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "fs check"));
    await run.until((evs) => dones(evs).length === 1);
    expect(texts(run.events)[0]).toContain('"code":-32601');
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("reports an agy that exits mid-turn and ends the stream", async () => {
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "crash now"));
    await run.finished;
    const error = run.events.find((e) => e.type === "error") as Extract<ChatEvent, { type: "error" }>;
    expect(error.message).toContain("exit code 3");
    expect(run.events.at(-1)).toMatchObject({ type: "done", resultSubtype: "error_during_execution" });
    expect(p.hasStreamingSession(NEW_ID)).toBe(false);
  });

  it("reports a refusal as an error, not a success", async () => {
    const p = provider();
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "refusal please"));
    await run.until((evs) => dones(evs).length === 1);
    expect(run.events.find((e) => e.type === "error")).toEqual({ type: "error", message: "Antigravity declined to continue this request." });
    expect(dones(run.events)[0]).toMatchObject({ resultSubtype: "error_during_execution" });
    p.abortQuery(NEW_ID);
    await run.finished;
  });

  it("reports an agy that cannot be started instead of waiting", async () => {
    const p = new AntigravityProvider({ customHome: tempHome, agyCommand: [join(tempHome, "no-such-agy")] });
    const run = consume(p.sendMessage((await p.createSession({ projectPath: projectDir })).id, "hello"));
    await run.finished;
    expect(run.events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("ENOENT") });
    expect(run.events.at(-1)).toMatchObject({ type: "done", resultSubtype: "error_during_execution" });
  });
});

describe("agyStoreArgs", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ppm-agy-store-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const catalogue = (store: string, version: number) => {
    mkdirSync(join(home, ".gemini", store), { recursive: true });
    const db = new Database(join(home, ".gemini", store, "conversation_summaries.db"));
    db.run(`PRAGMA user_version = ${version}`);
    db.close();
  };

  it("puts a new chat in the app's store only while its catalogue has the checked layout", () => {
    expect(agyStoreArgs(home)).toEqual([]);
    catalogue("antigravity", 3);
    expect(agyStoreArgs(home)).toEqual(["--app-data-dir", "antigravity"]);
    catalogue("antigravity", 4);
    expect(agyStoreArgs(home)).toEqual([]);
  });

  it("continues an existing chat in the store its files are in", () => {
    catalogue("antigravity", 3);
    expect(agyStoreArgs(home, join(home, ".gemini", "antigravity-cli", "brain"))).toEqual([]);
    expect(agyStoreArgs(home, join(home, ".gemini", "antigravity", "brain"))).toEqual(["--app-data-dir", "antigravity"]);
  });
});

describe("agy's slash commands", () => {
  beforeEach(() => { setDb(openTestDb()); });
  afterEach(() => { setDb(openTestDb()); });

  const stored = () => JSON.parse(getConfigValue("antigravity_slash_commands") ?? "{}") as Record<string, unknown>;

  it("are null until agy names some, then follow the project, else the latest list any project got", () => {
    expect(agySlashItems("/p/a")).toBeNull();
    rememberAgyCommands("/p/a", [{ name: "goal", description: "Goal" }, { name: "a-skill", description: "A" }]);
    rememberAgyCommands("/p/b", [{ name: "goal", description: "Goal" }]);
    expect(agySlashItems("/p/a")?.map((i) => i.name)).toEqual(["goal", "a-skill"]);
    expect(agySlashItems("/p/b")?.map((i) => i.name)).toEqual(["goal"]);
    expect(agySlashItems("/p/never-seen")?.map((i) => i.name)).toEqual(["goal"]);
  });

  it("keep only entries that can be typed as a command, and ignore an empty or malformed list", () => {
    expect(parseAgyCommands([{ name: "ok" }, { name: "two words" }, { name: "" }, null, { description: "x" }, { name: "hinted", input: { hint: "h" } }]))
      .toEqual([{ name: "ok" }, { name: "hinted", hint: "h" }]);
    rememberAgyCommands("/p/a", [{ name: "goal" }]);
    rememberAgyCommands("/p/a", []);
    rememberAgyCommands("/p/a", "nonsense");
    expect(stored()).toEqual({ "/p/a": [{ name: "goal" }] });
  });

  it("forget the least recently changed projects past a hundred", () => {
    for (let i = 0; i <= 100; i++) rememberAgyCommands(`/p/${i}`, [{ name: "goal" }]);
    const projects = Object.keys(stored());
    expect(projects).toHaveLength(100);
    expect(projects).not.toContain("/p/0");
    expect(projects.at(-1)).toBe("/p/100");
  });
});

describe("mapAcpUpdate", () => {
  it("marks a failed tool call as an error and keeps its exit code", () => {
    const tools = newToolState();
    const evs = mapAcpUpdate({
      sessionUpdate: "tool_call", toolCallId: "c9", name: "run_command", args: { CommandLine: "false" },
      status: "failed", rawOutput: { output: "Command exited with code 1.", exit_code: 1 },
    }, tools);
    expect(evs.map((e) => e.type)).toEqual(["tool_use", "tool_result"]);
    expect(evs[1]).toEqual({ type: "tool_result", toolUseId: "c9", output: "Command exited with code 1.", isError: true, exitCode: 1 });
    expect(mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c9", status: "failed" }, tools)).toEqual([]);
  });
});
