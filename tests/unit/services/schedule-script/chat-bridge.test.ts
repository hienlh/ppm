/**
 * `ctx.ai.chat`'s bookkeeping around a turn: which chat a key talks to, when a chat is named,
 * and when a new one is deleted again. Turns run through the real chat handler on the mock
 * provider; renaming is stubbed, since the mock has no transcript the SDK could rename.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import * as admin from "../../../../src/services/chat-session-admin.ts";
import { chatService } from "../../../../src/services/chat.service.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { getSessionProvider, setSessionTitle } from "../../../../src/services/db.service.ts";
import { getSchedule, insertSchedule } from "../../../../src/services/scheduler-db.service.ts";
import { scheduleChat } from "../../../../src/services/schedule-script/chat-bridge.ts";
import { cleanupAiTurns, collectFinishedTurns, getScheduleChat, startAiTurn } from "../../../../src/services/schedule-script/schedule-chat-db.ts";
import type { Schedule } from "../../../../src/types/scheduler.ts";

const restores: Array<() => void> = [];
let projectDir = "";
let previousProjects: unknown;
let schedule: Schedule;
/** Sessions whose turn wrote a transcript; a turn that fails before writing leaves none. */
const wrote = new Set<string>();
let renames: Array<[string, string]>;
/** The session the mock provider last ran a turn in. */
let lastTurnIn = "";

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ppm-bridge-"));
  previousProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: projectDir }]);
});
afterAll(() => {
  configService.set("projects", previousProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});
beforeEach(() => {
  const id = insertSchedule({
    name: "bot", cron_expr: "0 * * * * *", provider_id: "mock", project_path: projectDir, prompt: "",
    kind: "script", mode: "tick", script: "export default async () => {}",
  });
  schedule = getSchedule(id)!;
  renames = [];
  const rename = spyOn(admin, "renameChatSession").mockImplementation(async (id: string, title: string) => { renames.push([id, title]); });
  const mock = providerRegistry.get("mock")!;
  const messages = spyOn(mock, "getMessages").mockImplementation(async (sid: string) =>
    wrote.has(sid) ? [{ id: "m1", role: "user", content: "x", timestamp: "" }] as never : []);
  restores.push(() => rename.mockRestore(), () => messages.mockRestore());
  answer();
});
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** The mock provider's next turns: write a transcript and answer `text`, or fail before writing. */
function answer(text = "Done.", opts: { fail?: string; gate?: Promise<void> } = {}) {
  const mock = providerRegistry.get("mock")!;
  const send = spyOn(mock, "sendMessage").mockImplementation(async function* (sid: string) {
    lastTurnIn = sid;
    if (opts.gate) await opts.gate;
    if (opts.fail) {
      yield { type: "error", message: opts.fail };
      yield { type: "done", sessionId: sid };
      return;
    }
    wrote.add(sid);
    yield { type: "text", content: text };
    yield { type: "done", sessionId: sid, resultSubtype: "success", costUsd: 0.5 };
  } as never);
  restores.push(() => send.mockRestore());
}

const chat = (key: string, opts: Record<string, unknown> = {}, prompt = "go") =>
  scheduleChat(schedule, key, prompt, { timeoutMs: 5000, ...opts });

describe("ctx.ai.chat", () => {
  it("names a new chat after its first turn, remembers it for the key, and renames only for a new title", async () => {
    const first = await chat("NX-1", { title: "review NX-1" });
    expect(first).toMatchObject({ ok: true, text: "Done.", costUsd: 0.5 });
    const id = first.sessionId!;
    expect(renames).toEqual([[id, "review NX-1"]]);
    expect(getScheduleChat(schedule.id, "NX-1")).toEqual({ session_id: id, title: "review NX-1" });

    expect((await chat("NX-1", { title: "review NX-1" })).sessionId).toBe(id);
    expect(renames).toHaveLength(1);

    // A name the user gave the chat in PPM since stays, while the script keeps asking for its own.
    setSessionTitle(id, "my own name");
    await chat("NX-1", { title: "review NX-1" });
    expect(renames).toHaveLength(1);

    await chat("NX-1", { title: "NX-1: payslip totals" });
    expect(renames).toEqual([[id, "review NX-1"], [id, "NX-1: payslip totals"]]);
    expect(getScheduleChat(schedule.id, "NX-1")?.title).toBe("NX-1: payslip totals");

    // With no title the key is the name.
    const other = await chat("thread-42");
    expect(renames.at(-1)).toEqual([other.sessionId!, "thread-42"]);
  });

  it("uses the chat the script names while PPM has it, then the key's chat, then a new one", async () => {
    const keyChat = (await chat("a")).sessionId!;
    const named = (await chatService.createSession("mock", { projectName: "demo", projectPath: projectDir })).id;

    expect((await chat("a", { sessionId: named })).sessionId).toBe(named);
    expect(getScheduleChat(schedule.id, "a")?.session_id).toBe(named);

    await admin.deleteChatSession("mock", named, projectDir);
    const fresh = (await chat("a", { sessionId: named })).sessionId!;
    expect([keyChat, named]).not.toContain(fresh);

    const b = (await chat("b")).sessionId;
    expect((await chat("b", { sessionId: "0f8e2a8c-gone-gone-gone-000000000000" })).sessionId).toBe(b);
  });

  it("deletes a new chat whose first turn wrote nothing, and forgets the key; an older chat stays", async () => {
    restores.splice(2).forEach((r) => r());
    answer("", { fail: "All accounts have hit their usage limit." });
    const failed = await chat("NX-2", { title: "review NX-2" });
    expect(failed).toMatchObject({ ok: false, error: "All accounts have hit their usage limit.", sessionId: null });
    expect(getScheduleChat(schedule.id, "NX-2")).toBeNull();
    expect(renames).toEqual([]);
    expect(getSessionProvider(lastTurnIn)).toBeNull();
    expect(chatService.getSession(lastTurnIn)).toBeNull();

    restores.splice(2).forEach((r) => r());
    answer();
    const kept = (await chat("NX-3")).sessionId!;
    restores.splice(2).forEach((r) => r());
    answer("", { fail: "Agent encountered an error during execution." });
    expect(await chat("NX-3")).toMatchObject({ ok: false, sessionId: kept });
    expect(getSessionProvider(kept)).toBe("mock");
    expect(getScheduleChat(schedule.id, "NX-3")?.session_id).toBe(kept);
  });

  it("starts a turn without waiting, and hands its result out once through finished()", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    restores.splice(2).forEach((r) => r());
    answer("Answer later.", { gate });
    const started = await chat("bg", { wait: false });
    expect(started).toMatchObject({ ok: true, started: true, text: "" });
    expect(collectFinishedTurns(schedule.id)).toEqual([]);

    // The chat is busy until its turn ends: a second turn sends nothing.
    expect(await chat("bg", { wait: false })).toMatchObject({ ok: false, busy: true });

    release();
    let finished: ReturnType<typeof collectFinishedTurns> = [];
    for (let i = 0; i < 200 && finished.length === 0; i++) {
      await Bun.sleep(5);
      finished = collectFinishedTurns(schedule.id);
    }
    expect(finished).toEqual([expect.objectContaining({ key: "bg", sessionId: started.sessionId, ok: true, text: "Answer later.", costUsd: 0.5 })]);
    expect(collectFinishedTurns(schedule.id)).toEqual([]);
  });

  it("reports a turn PPM's restart cut short as interrupted", () => {
    startAiTurn(schedule.id, "bg", "00000000-0000-0000-0000-000000000001");
    cleanupAiTurns();
    expect(collectFinishedTurns(schedule.id)).toEqual([
      expect.objectContaining({ key: "bg", ok: false, error: "interrupted: PPM restarted" }),
    ]);
  });

  it("refuses a project PPM does not have", async () => {
    await expect(chat("x", { projectPath: "/nowhere/at/all" })).rejects.toThrow("/nowhere/at/all is not a project in PPM");
  });
});
