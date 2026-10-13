/**
 * `startChatTurn` against the real chat WebSocket handler, with the mock provider scripted per
 * test. Ported from the bots' `ppm-chat.test.js` (`runTurn`), which talked to PPM over a real
 * socket: the same expectations, now without the socket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import { chatWebSocket } from "../../../../src/server/ws/chat.ts";
import { chatService } from "../../../../src/services/chat.service.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { startChatTurn } from "../../../../src/services/schedule-script/chat-loopback.ts";
import { stripSharedContext } from "../../../../src/shared/provider-context.ts";

const restores: Array<() => void> = [];
const sockets: any[] = [];
let projectDir = "";
let previousProjects: unknown;

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ppm-loopback-"));
  previousProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: projectDir }]);
});
afterAll(() => {
  configService.set("projects", previousProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
  for (const restore of restores.splice(0)) restore();
});

/** Make the mock provider answer every message with `events`; returns the messages it got. */
function script(events: (sessionId: string) => AsyncIterable<any> | any[]) {
  const got: string[] = [];
  const provider = providerRegistry.get("mock")!;
  const send = spyOn(provider, "sendMessage").mockImplementation(async function* (sessionId: string, message: string) {
    got.push(stripSharedContext(message));
    yield* events(sessionId) as any;
  } as never);
  restores.push(() => send.mockRestore());
  return got;
}

function spy<T extends object>(obj: T, method: keyof T) {
  const s = spyOn(obj, method as never);
  restores.push(() => s.mockRestore());
  return s;
}

async function newSession() {
  return (await chatService.createSession("mock", { projectName: "demo", projectPath: projectDir })).id;
}

const turn = (sessionId: string, content = "review #1", timeoutMs = 2000) =>
  startChatTurn({ sessionId, projectName: "demo", content, permissionMode: "bypassPermissions", timeoutMs });

describe("startChatTurn", () => {
  it("sends the message once the session is idle, and returns the text after the last tool call", async () => {
    const id = await newSession();
    const sends = spy(chatService, "sendMessage");
    const got = script((sid) => [
      { type: "account_info", accountId: "a1", accountLabel: "Alden (Nxsys)" },
      { type: "text", content: "Let me read the diff." },
      { type: "tool_use", tool: "Bash", input: { command: "git diff" }, toolUseId: "t0" },
      { type: "text", content: "subagent noise", parentToolUseId: "t1" },
      { type: "tool_result", output: "diff", toolUseId: "t0" },
      { type: "text", content: "All " },
      { type: "text", content: "good." },
      { type: "done", sessionId: sid, resultSubtype: "success", costUsd: 1.25, numTurns: 3 },
    ]);
    const t = turn(id);
    expect(await t.sent).toBe(true);
    expect(await t.done).toEqual({ ok: true, text: "All good.", sessionId: id, account: "Alden (Nxsys)", costUsd: 1.25, numTurns: 3 });
    expect(got).toEqual(["review #1"]);
    // The trace records the turn as the scheduler's, with the schedule's permission mode.
    expect(sends.mock.calls[0]![3]).toMatchObject({ origin: "scheduler", permissionMode: "bypassPermissions" });
  });

  it("finds a session PPM is already running a turn in busy, and sends nothing", async () => {
    const id = await newSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const got = script(async function* (sid) {
      yield { type: "text", content: "working" };
      await gate;
      yield { type: "done", sessionId: sid, resultSubtype: "success" };
    });
    const browser = { data: { type: "chat", sessionId: id, projectName: "demo" }, send: () => {} };
    sockets.push(browser);
    chatWebSocket.open(browser as any);
    await chatWebSocket.message(browser as any, JSON.stringify({ type: "message", content: "from the browser" }));
    for (let i = 0; i < 100 && got.length === 0; i++) await Bun.sleep(5);

    const t = turn(id);
    expect(await t.sent).toBe(false);
    expect(await t.done).toMatchObject({ ok: false, busy: true, text: "", sessionId: id });
    expect((await t.done).error).toMatch(/^PPM session is (initializing|connecting|thinking|streaming)$/);
    expect(got).toEqual(["from the browser"]);
    release();
  });

  it("says the turn started only once PPM has taken the session out of idle, so the next message finds it busy", async () => {
    const id = await newSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // PPM resumes the session (slow on a first call) before the phase leaves idle.
    const resume = spy(providerRegistry.get("mock")!, "resumeSession");
    resume.mockImplementation((async (sid: string) => { await gate; return { id: sid }; }) as never);
    const got = script((sid) => [{ type: "text", content: "ok" }, { type: "done", sessionId: sid, resultSubtype: "success" }]);

    const first = turn(id, "first");
    // What the chat bridge does: the key's next call comes once the first one is out.
    const second = first.sent.then(() => turn(id, "second"));
    await Bun.sleep(30);
    release();
    expect(await (await second).done).toMatchObject({ ok: false, busy: true });
    expect(await first.done).toMatchObject({ ok: true, text: "ok" });
    expect(got).toEqual(["first"]);
  });

  it("reports PPM's error for a failed turn, such as a usage limit", async () => {
    const limited = "All accounts have hit their usage limit. Resets 1pm. Add another account in Settings → Accounts or wait for the reset.";
    // A session each: the mock provider cannot take a message while its last turn winds down.
    const id = await newSession();
    script((sid) => [{ type: "error", message: limited }, { type: "done", sessionId: sid }]);
    expect(await turn(id).done).toEqual({ ok: false, error: limited, text: "", sessionId: id });

    restores.splice(0).forEach((r) => r());
    script((sid) => [
      { type: "error", message: "Agent encountered an error during execution." },
      { type: "done", sessionId: sid, resultSubtype: "error_during_execution" },
    ]);
    expect(await turn(await newSession()).done).toMatchObject({ ok: false, error: "Agent encountered an error during execution." });

    restores.splice(0).forEach((r) => r());
    script((sid) => [{ type: "done", sessionId: sid, resultSubtype: "error_max_turns" }]);
    expect(await turn(await newSession()).done).toMatchObject({ ok: false, error: "The turn ended with error_max_turns" });

    restores.splice(0).forEach((r) => r());
    script(() => [{ type: "message_rejected", reason: "session is being deleted" }]);
    expect(await turn(await newSession()).done).toMatchObject({ ok: false, error: "session is being deleted" });
  });

  it("cancels a turn in PPM when it outlives its timeout", async () => {
    const id = await newSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    script(async function* (sid) {
      yield { type: "text", content: "thinking hard" };
      await gate;
      yield { type: "done", sessionId: sid };
    });
    const aborts = spy(chatService, "abortQuery");
    const out = await turn(id, "x", 150).done;
    expect(out).toMatchObject({ ok: false, timedOut: true, error: "No answer after 0 s" });
    expect(aborts.mock.calls).toContainEqual(["mock", id, "ws_cancel", "scheduler"]);
    release();
  });

  it("ends with an error, never a hang, when the turn stops without a result or never starts", async () => {
    script(() => [{ type: "text", content: "half an answer" }]);
    expect(await turn(await newSession()).done).toMatchObject({ ok: false, error: "The turn ended without a result", text: "half an answer" });

    // PPM refuses a message before any turn exists (here: nothing to send), so none started.
    const refused = turn(await newSession(), "   ");
    expect(await refused.sent).toBe(false);
    expect(await refused.done).toMatchObject({ ok: false, error: "Message content is required" });
  });
});
