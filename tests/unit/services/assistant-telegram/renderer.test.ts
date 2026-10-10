import { describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, memoryState, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import {
  LONG_TURN_MS, MOVED_BELOW, PLACEHOLDER, shortToolName, TurnRenderer,
} from "../../../../src/services/assistant-telegram/assistant-telegram-turn-renderer.ts";
import { mirroredLine, turnFooter, WATCH_NEWS_LINE } from "../../../../src/services/assistant-telegram/assistant-telegram-mirror.ts";
import { redactForTelegram } from "../../../../src/services/telegram/telegram-html-format.ts";
import type { ChatMessageOrigin } from "../../../../src/services/chat-control/chat-control.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

function turn(opts: { origin?: ChatMessageOrigin; tools?: boolean } = {}) {
  const chat = connectChat(freshChat());
  const queue = queueFor(client);
  const state = memoryState();
  let now = 1_000_000;
  let delivered = 0;
  const r = new TurnRenderer({
    queue, state, chatId: chat, origin: opts.origin ?? "telegram",
    showToolCalls: () => opts.tools ?? true, now: () => now, onDelivered: () => { delivered++; },
  });
  return { r, chat, queue, state, advance: (ms: number) => { now += ms; }, delivered: () => delivered };
}

describe("an answer streamed into Telegram", () => {
  it("opens with … and replaces it with a short turn's answer, in the same message", async () => {
    const t = turn();
    t.r.start();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual([PLACEHOLDER]);
    t.r.text("Hello **there**");
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual([`Hello there ${PLACEHOLDER}`]);
    t.r.finish();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual(["Hello there"]);
    expect(t.delivered()).toBe(1);
  });

  it("ends a long turn with its answer as a new message, so the phone is notified", async () => {
    const t = turn();
    t.r.start();
    t.r.text("Working on it");
    await t.queue.whenIdle();
    t.advance(LONG_TURN_MS + 1);
    t.r.text(" — done.");
    t.r.finish();
    await t.queue.whenIdle();
    // The draft is deleted once the answer is out: only the answer is left.
    expect(texts(fake, t.chat)).toEqual(["Working on it — done."]);
    expect(fake.deleted.at(-1)!.chat_id).toBe(Number(t.chat));
    // Its state record is cleared: nothing to mark as cut off after a restart.
    expect(t.state.takeAll()).toEqual({});
  });

  it("ends a watch's turn with a new message however quick it was", async () => {
    const t = turn({ origin: "watch" });
    t.r.start();
    await t.queue.whenIdle();
    t.r.text("Chat X finished.");
    t.r.finish();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual(["Chat X finished."]);
  });

  it("points the draft at the answer below when Telegram will not delete it", async () => {
    const t = turn({ origin: "watch" });
    t.r.start();
    await t.queue.whenIdle();
    fake.failNext("deleteMessage", { code: 400, description: "Bad Request: message can't be deleted for everyone" });
    t.r.text("Chat Y finished.");
    t.r.finish();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual([MOVED_BELOW.replace(/<\/?i>/g, ""), "Chat Y finished."]);
  });

  it("moves on to a new message before Telegram's limit, every message under it", async () => {
    const t = turn();
    t.r.start();
    const paragraph = `${"word ".repeat(150).trim()}\n\n`;
    for (let i = 0; i < 14; i++) t.r.text(paragraph);
    t.r.finish();
    await t.queue.whenIdle();
    const all = texts(fake, t.chat);
    expect(all.length).toBeGreaterThan(1);
    for (const text of all) expect(text.length).toBeLessThanOrEqual(4096);
    expect(all.join("").replace(/\s/g, "")).toBe(paragraph.repeat(14).replace(/\s/g, ""));
  });

  it("names a tool without its input, and only when the setting asks", async () => {
    expect(shortToolName("mcp__ppm-assistant__chat_search")).toBe("chat_search");
    expect(shortToolName("ppm_assistant:db_query")).toBe("db_query");
    const on = turn({ tools: true });
    on.r.start();
    on.r.tool("mcp__ppm-assistant__chat_search");
    on.r.finish();
    await on.queue.whenIdle();
    expect(texts(fake, on.chat)).toEqual(["🔧 chat_search"]);
    const off = turn({ tools: false });
    off.r.start();
    off.r.tool("Bash");
    off.r.text("ok");
    off.r.finish();
    await off.queue.whenIdle();
    expect(texts(fake, off.chat)).toEqual(["ok"]);
  });

  it("hides secrets in what it sends", async () => {
    const t = turn();
    t.r.start();
    t.r.text("The key is AKIAIOSFODNN7EXAMPLE and the token sk-ant-" + "z".repeat(30));
    t.r.finish(turnFooter({ outcome: "failed", error: "auth failed for password=hunter2" }));
    await t.queue.whenIdle();
    const [text] = texts(fake, t.chat);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("sk-ant-");
    expect(text).not.toContain("hunter2");
    expect(redactForTelegram(text!)).toBe(text!);
  });

  it("says (no answer) for a turn that said nothing", async () => {
    const t = turn();
    t.r.start();
    t.r.finish(turnFooter({ outcome: "done" }));
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual(["(no answer)"]);
  });
});

describe("lines for what did not come from Telegram", () => {
  it("quotes a message typed in PPM, shortened and escaped", () => {
    const line = mirroredLine("ws", `<b>${"x".repeat(2000)}`, 2);
    expect(line!.startsWith("🖥 <i>(PPM)</i> &lt;b&gt;")).toBe(true);
    expect(line!.length).toBeLessThan(1100);
    expect(line).toEndWith("[+2 images]");
  });

  it("names a watch report without quoting it, and says nothing for Telegram's own messages", () => {
    expect(mirroredLine("watch", "<ppm-event>…</ppm-event>", 0)).toBe(WATCH_NEWS_LINE);
    expect(mirroredLine("telegram", "hi", 0)).toBeNull();
  });

  it("closes a stopped turn with why it stopped", () => {
    expect(turnFooter({ outcome: "stopped", stop: { message: "Reached maximum number of turns (40)", subtype: "error_max_turns", at: 0 } }))
      .toBe("⏹ Stopped after 40 steps (Max Turns)");
    expect(turnFooter({ outcome: "stopped" })).toBe("⏹ Stopped.");
  });
});
