import { describe, expect, it } from "bun:test";
import { clientFor, connectChat, disconnectChat, freshChat, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import { sendMessageTask } from "../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

describe("the send queue", () => {
  it("waits out a 60-second rate limit in that chat only, and still delivers the final message", async () => {
    const slow = connectChat(freshChat());
    const other = connectChat(freshChat());
    const queue = queueFor(client);
    // Over the client's 30 s ceiling: the client gives up at once and the lane waits instead.
    fake.failNext("sendMessage", { code: 429, retryAfter: 60 });
    queue.enqueue(slow, sendMessageTask(queue, slow, { html: "the answer" }, { label: "answer" }));
    queue.enqueue(other, sendMessageTask(queue, other, { html: "unblocked" }, { label: "reply" }));
    await fake.waitFor(() => texts(fake, other).length === 1);
    expect(texts(fake, slow)).toEqual([]);
    await queue.whenIdle();
    expect(texts(fake, slow)).toEqual(["the answer"]);
    expect(queue.lastSentAt(slow)).toBeNumber();
  });

  it("keeps the order of one chat's messages across a retry", async () => {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    fake.failNext("sendMessage", { code: 500 });
    for (const html of ["one", "two", "three"]) queue.enqueue(chat, sendMessageTask(queue, chat, { html }, { label: "reply" }));
    await queue.whenIdle();
    expect(texts(fake, chat)).toEqual(["one", "two", "three"]);
  });

  it("sends nothing more to a chat revoked while its messages were queued", async () => {
    const id = freshChat();
    const chat = connectChat(id);
    const queue = queueFor(client);
    fake.failNext("sendMessage", { code: 429, retryAfter: 60 });
    const dropped: string[] = [];
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "first" }, { label: "reply", onDropped: (why) => dropped.push(why) }));
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "second" }, { label: "reply", onDropped: (why) => dropped.push(why) }));
    disconnectChat(id);
    await queue.whenIdle();
    expect(texts(fake, chat)).toEqual([]);
    expect(dropped).toHaveLength(2);
  });

  it("replaces a waiting task queued under the same key, keeping it final if either was", async () => {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    fake.failNext("sendMessage", { code: 429, retryAfter: 1 });
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "head" }, { label: "reply" }));
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "stale draft" }, { label: "draft", final: false, key: "k" }));
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "newest" }, { label: "draft", final: false, key: "k" }));
    await queue.whenIdle();
    expect(texts(fake, chat)).toEqual(["head", "newest"]);
  });

  it("gives up on a refused message without holding the ones behind it", async () => {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    fake.failNext("sendMessage", { code: 403, description: "Forbidden: bot was blocked by the user" });
    const dropped: string[] = [];
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "refused" }, { label: "reply", onDropped: (why) => dropped.push(why) }));
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "next" }, { label: "reply" }));
    await queue.whenIdle();
    expect(dropped[0]).toContain("403");
    expect(texts(fake, chat)).toEqual(["next"]);
  });

  it("sends a message again without its link button when Telegram refuses the button's URL", async () => {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: BUTTON_URL_INVALID" });
    const markup = { inline_keyboard: [[{ text: "Deny", callback_data: "a:x" }], [{ text: "Open in PPM", url: "https://ppm.example.ts.net/x" }]] };
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "card", markup, fallbackHtml: "card\n\nOpen in PPM: https://ppm.example.ts.net/x" }, { label: "card" }));
    await queue.whenIdle();
    const [sent] = fake.sent(Number(chat));
    expect(sent?.text).toBe("card\n\nOpen in PPM: https://ppm.example.ts.net/x");
    expect(sent?.reply_markup?.inline_keyboard).toEqual([[{ text: "Deny", callback_data: "a:x" }]]);
  });
});
