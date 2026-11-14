/**
 * A bound Assistant turn waiting on another chat says so in its Telegram draft instead of showing a
 * bare "…" for minutes: after a delay, as an edit (never a new message), gone when the call returns.
 */
import { describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, memoryState, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import { PLACEHOLDER, TurnRenderer } from "../../../../src/services/assistant-telegram/assistant-telegram-turn-renderer.ts";
import { AssistantTelegramWaitNotes } from "../../../../src/services/assistant-telegram/assistant-telegram-wait-notes.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

function setup() {
  const chat = connectChat(freshChat());
  const queue = queueFor(client);
  const r = new TurnRenderer({ queue, state: memoryState(), chatId: chat, origin: "telegram", showToolCalls: () => false });
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  const notes = new AssistantTelegramWaitNotes({
    renderers: (sessionId) => (sessionId === "asst" && !r.isFinished ? [r] : []),
    describeChat: (id) => (id === "mgr" ? "“Manager” in Nxsys" : null),
    setTimer: (fn) => { const t = { fn, live: true }; timers.push(t); return () => { t.live = false; }; },
  });
  const fire = () => { for (const t of timers) if (t.live) { t.live = false; t.fn(); } };
  return { chat, queue, r, notes, timers, fire };
}

const send = (wait: boolean, toolUseId = "tu-1") =>
  ({ tool: "mcp__ppm-sessions__send_to_session", input: { session_id: "mgr", message: "x", wait }, toolUseId });

describe("a waiting session tool on Telegram", () => {
  it("says whom the turn waits for once the wait runs long, in the same draft, and drops it when the call returns", async () => {
    const t = setup();
    t.r.start();
    t.r.text("Asking the manager.");
    t.notes.toolStarted("asst", send(true));
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual([`Asking the manager. ${PLACEHOLDER}`]);

    t.fire();
    await t.queue.whenIdle();
    const sentBefore = fake.sent(Number(t.chat)).length;
    expect(texts(fake, t.chat)).toEqual([`Asking the manager.\n\n⏳ Waiting for the chat “Manager” in Nxsys to answer… ${PLACEHOLDER}`]);

    t.notes.toolEnded("tu-1");
    t.r.text(" It answered.");
    t.r.finish();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual(["Asking the manager. It answered."]);
    // Edits only: the note never sent a message of its own.
    expect(fake.sent(Number(t.chat)).length).toBe(sentBefore);
  });

  it("times only waiting session tools, and nothing after the turn ended", async () => {
    const t = setup();
    t.r.start();
    t.notes.toolStarted("asst", send(false, "tu-nowait"));
    t.notes.toolStarted("asst", { tool: "Bash", input: { wait: true }, toolUseId: "tu-bash" });
    t.notes.toolStarted("asst", { ...send(true), toolUseId: undefined });
    expect(t.timers).toHaveLength(0);

    t.notes.toolStarted("asst", send(true, "tu-2"));
    t.notes.turnEnded("asst");
    t.fire();
    t.r.finish();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat).join("\n")).not.toContain("Waiting for");
  });

  it("reads a Codex call, whose arguments come wrapped", async () => {
    const t = setup();
    t.r.start();
    t.notes.toolStarted("asst", {
      tool: "ppm_sessions:send_to_session", toolUseId: "tu-codex",
      input: { server: "ppm_sessions", tool: "send_to_session", arguments: { session_id: "mgr", message: "x", wait: true } },
    });
    t.fire();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)[0]).toContain("Waiting for the chat “Manager” in Nxsys to answer…");
  });

  it("keeps the line while another wait of the turn still runs", async () => {
    const t = setup();
    t.r.start();
    t.notes.toolStarted("asst", send(true, "tu-a"));
    t.notes.toolStarted("asst", { tool: "create_session", input: { title: "C", task: "x", wait: true }, toolUseId: "tu-b" });
    t.fire();
    t.notes.toolEnded("tu-b");
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)[0]).toContain("Waiting for the chat “Manager” in Nxsys");
    t.notes.toolEnded("tu-a");
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)[0]).not.toContain("Waiting for");
  });

  it("never opens a message of its own for the line: a full draft goes without it", async () => {
    const t = setup();
    t.r.start();
    t.r.text("x".repeat(3990));
    await t.queue.whenIdle();
    const before = fake.sent(Number(t.chat)).length;
    t.notes.toolStarted("asst", send(true, "tu-full"));
    t.fire();
    await t.queue.whenIdle();
    expect(fake.sent(Number(t.chat)).length).toBe(before);
    expect(texts(fake, t.chat).join("\n")).not.toContain("Waiting for");
  });

  it("names no chat it does not know", async () => {
    const t = setup();
    t.r.start();
    t.notes.toolStarted("asst", { tool: "create_session", input: { title: "Child", task: "x", wait: true }, toolUseId: "tu-3" });
    t.fire();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)[0]).toContain("⏳ Waiting for another chat to answer…");
  });
});
