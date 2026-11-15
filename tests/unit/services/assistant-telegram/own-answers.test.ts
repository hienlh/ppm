/**
 * The bridge remembers which bot messages are the Assistant's own answers, and whether the turn
 * that wrote them stayed clear of outside text: the reply quote counts only those as the
 * Assistant's words. A line the mirror writes for a message typed in PPM is not an answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, memoryState, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramMirror } from "../../../../src/services/assistant-telegram/assistant-telegram-mirror.ts";
import { answerMessage, clearOwnAnswers } from "../../../../src/services/assistant-telegram/assistant-telegram-own-answers.ts";
import { chatLifecycle } from "../../../../src/services/chat-control/chat-lifecycle.ts";
import { setTelegramBinding } from "../../../../src/services/assistant-hub/assistant-hub-db.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
afterEach(() => clearOwnAnswers());

function mirrorFor(untrusted: { now: boolean }) {
  const chat = connectChat(freshChat());
  const sessionId = `own-${crypto.randomUUID()}`;
  setTelegramBinding(chat, sessionId, "claude");
  const queue = queueFor(client);
  const mirror = new AssistantTelegramMirror({
    queue, state: memoryState(), showToolCalls: () => false, onTurnDelivered: () => {}, turnUntrusted: () => untrusted.now,
  });
  mirror.attach();
  return { chat, sessionId, queue, mirror };
}

const ended = (sessionId: string) => chatLifecycle.emit("turn_ended", { sessionId, outcome: "done", projectName: "__assistant__", providerId: "claude" });

describe("the Assistant's own answers on Telegram", () => {
  it("are recorded with their session, clean while the turn is", async () => {
    const t = mirrorFor({ now: false });
    try {
      chatLifecycle.emit("stream", { sessionId: t.sessionId, event: { type: "text", content: "Done." } });
      await t.queue.whenIdle();
      ended(t.sessionId);
      await t.queue.whenIdle();
      const ids = fake.sent(Number(t.chat)).map((m) => m.message_id);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(answerMessage(t.chat, id)).toEqual({ sessionId: t.sessionId, trusted: true });
    } finally {
      t.mirror.detach();
    }
  });

  it("stop counting as clean, pages already sent included, once the turn reads outside text", async () => {
    const state = { now: false };
    const t = mirrorFor(state);
    try {
      chatLifecycle.emit("stream", { sessionId: t.sessionId, event: { type: "text", content: "Let me look." } });
      await t.queue.whenIdle();
      const draft = fake.sent(Number(t.chat))[0]!.message_id;
      expect(answerMessage(t.chat, draft)?.trusted).toBe(true);
      state.now = true;
      chatLifecycle.emit("stream", { sessionId: t.sessionId, event: { type: "tool_use", tool: "Read" } });
      expect(answerMessage(t.chat, draft)?.trusted).toBe(false);
      ended(t.sessionId);
      await t.queue.whenIdle();
      for (const m of fake.sent(Number(t.chat))) expect(answerMessage(t.chat, m.message_id)?.trusted ?? false).toBe(false);
    } finally {
      t.mirror.detach();
    }
  });

  it("do not include the line a message typed in PPM gets", async () => {
    const t = mirrorFor({ now: false });
    try {
      chatLifecycle.emit("user_message", { sessionId: t.sessionId, text: "check the build", origin: "ws", imageCount: 0, projectName: "__assistant__", providerId: "claude" });
      await t.queue.whenIdle();
      const line = fake.sent(Number(t.chat)).find((m) => m.text.includes("check the build"))!;
      expect(line).toBeDefined();
      expect(answerMessage(t.chat, line.message_id)).toBeNull();
      ended(t.sessionId);
      await t.queue.whenIdle();
    } finally {
      t.mirror.detach();
    }
  });

  it("are all untrusted when nothing says how the turn stands", async () => {
    const chat = connectChat(freshChat());
    const sessionId = `own-${crypto.randomUUID()}`;
    setTelegramBinding(chat, sessionId, "claude");
    const queue = queueFor(client);
    const mirror = new AssistantTelegramMirror({ queue, state: memoryState(), showToolCalls: () => false, onTurnDelivered: () => {} });
    mirror.attach();
    try {
      chatLifecycle.emit("stream", { sessionId, event: { type: "text", content: "Hi." } });
      await queue.whenIdle();
      expect(answerMessage(chat, fake.sent(Number(chat))[0]!.message_id)?.trusted).toBe(false);
      ended(sessionId);
      await queue.whenIdle();
    } finally {
      mirror.detach();
    }
  });
});
