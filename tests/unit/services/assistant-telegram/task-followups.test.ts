/**
 * The chat's answer to task words on Telegram, as the sink sends it: as a reply to the user's own
 * message, with the project's detail level read when it goes (a project switched to titles only
 * during the turn shows no content), and with nothing said for a card that already went under it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramTaskFollowups } from "../../../../src/services/assistant-telegram/assistant-telegram-task-followups.ts";
import type { TaskFollowupDelivery } from "../../../../src/services/assistant-cards/task-words-followup.ts";
import { getDb } from "../../../../src/services/db.service.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
beforeEach(() => { getDb().query("DELETE FROM clawbot_paired_chats").run(); });

function delivery(chatId: string, extra: Partial<TaskFollowupDelivery> & { kind: TaskFollowupDelivery["kind"] }): TaskFollowupDelivery {
  return {
    sessionId: "mgr", repliedAt: 1_000, text: "The ACME payroll is fixed.", overflow: false,
    context: {
      origin: { channel: "telegram", chatId, messageId: 4242 },
      taskRef: { taskId: "0f1e2d3c-4b5a-4968-8776-655443322110", ref: "alpha/12", title: "Fix the login timeout" },
      chat: { kind: "child", chatTitle: "Client ACME fix", detail: "full", projectKey: "k-alpha", projectName: "alpha", providerId: "claude" },
    },
    ...extra,
  } as TaskFollowupDelivery;
}

describe("the task-words sink", () => {
  it("answers as a reply to the user's message, and remembers it for the task", async () => {
    const chat = freshChat();
    const chatId = connectChat(chat);
    const remembered: Array<[string, number, string]> = [];
    const queue = queueFor(client);
    const s = new AssistantTelegramTaskFollowups({
      queue, chatLink: async () => "http://localhost:8080/chat", detailOf: () => "full", now: () => 1_000,
      remember: (c, m, t) => remembered.push([c, m, t]),
    });
    s.send(delivery(chatId, { kind: "answer" }));
    const msg = await fake.waitFor(() => fake.sent(chat)[0]);
    await queue.whenIdle();
    expect(msg.reply_to).toBe(4242);
    expect(msg.text).toContain("The chat “Client ACME fix” working on it answered, about alpha/12 · Fix the login timeout:");
    expect(msg.text).toContain("The ACME payroll is fixed.");
    expect(remembered).toEqual([[chatId, msg.message_id, "0f1e2d3c-4b5a-4968-8776-655443322110"]]);
  });

  it("reads the detail level when it sends: a project now titles-only shows no content", async () => {
    const chat = freshChat();
    const chatId = connectChat(chat);
    const queue = queueFor(client);
    const s = new AssistantTelegramTaskFollowups({ queue, chatLink: async () => "", detailOf: () => "title", now: () => 1_000 });
    s.send(delivery(chatId, { kind: "answer" }));
    s.send(delivery(chatId, { kind: "failed", error: "ACME crashed" } as Partial<TaskFollowupDelivery> & { kind: "failed" }));
    await fake.waitFor(() => fake.sent(chat).length === 2);
    await queue.whenIdle();
    for (const m of fake.sent(chat)) {
      expect(m.text).not.toContain("ACME");
      expect(m.reply_to).toBe(4242);
    }
  });

  it("says nothing for a card that already went under the user's message", async () => {
    const chat = freshChat();
    const chatId = connectChat(chat);
    const queue = queueFor(client);
    const s = new AssistantTelegramTaskFollowups({
      queue, chatLink: async () => "", detailOf: () => "full", now: () => 1_000,
      threadedIn: (cardId) => cardId === "c-threaded",
    });
    s.send(delivery(chatId, { kind: "cards", cards: [{ id: "c-threaded", title: "Needs your decision" }] } as Partial<TaskFollowupDelivery> & { kind: "cards" }));
    s.send(delivery(chatId, { kind: "cards", cards: [{ id: "c-held", title: "Held for the morning" }] } as Partial<TaskFollowupDelivery> & { kind: "cards" }));
    await fake.waitFor(() => fake.sent(chat).length === 1);
    await queue.whenIdle();
    expect(fake.sent(chat).map((m) => m.text.split("\n")[0])).toEqual([
      "↩ The chat “Client ACME fix” working on it answered about alpha/12 · Fix the login timeout with a card: Held for the morning",
    ]);
  });
});
