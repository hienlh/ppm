/**
 * What a watch sends to Telegram on its own: a watched chat's card — to the chats bound to the
 * Assistant session that set the watch, or to every connected chat when none is — and, for a
 * session no chat is bound to, its report.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clientFor, connectChat, disconnectChat, freshChat, memoryState, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramCards } from "../../../../src/services/assistant-telegram/assistant-telegram-cards.ts";
import { AssistantTelegramRelay } from "../../../../src/services/assistant-telegram/assistant-telegram-relay.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { watchEvents, type WatchEvents } from "../../../../src/services/assistant-watch/watch-events.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import type { LiveApprovalCard } from "../../../../src/services/chat-control/chat-control.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

let relays: AssistantTelegramRelay[] = [];
// "Every connected chat" means this test's chats only.
beforeEach(() => { getDb().query("DELETE FROM clawbot_paired_chats").run(); });
afterEach(() => { for (const r of relays) r.detach(); relays = []; });

function setup(bound: Record<string, string[]> = {}) {
  const queue = queueFor(client);
  const codes = new ButtonCodes<BridgeAction>();
  const links = {
    sessionLink: async () => "http://localhost:8080/assistant",
    chatLink: async (project: string, provider: string | null, id: string) => `http://localhost:8080/project/${project}?openChat=${provider}/${id}`,
  };
  const cards = new AssistantTelegramCards({ queue, state: memoryState(), codes, now: Date.now, ...links });
  const relay = new AssistantTelegramRelay({
    queue, chatLink: links.chatLink, relayCard: (chatId, card) => cards.relayed(chatId, card),
    boundChats: (id) => bound[id] ?? [], providerOf: () => "claude",
  });
  relay.attach();
  relays.push(relay);
  return { queue, cards, codes, relay };
}

const card = (command: string): LiveApprovalCard => ({ requestId: `r-${crypto.randomUUID()}`, tool: "Bash", input: { command }, isQuestion: false });
const decision = (assistantSessionId: string, c: LiveApprovalCard): WatchEvents["watch_decision"] => ({
  watchId: "w1", assistantSessionId, targetSessionId: "target-1", targetProject: "api", targetProvider: "claude", targetTitle: "Deploy <prod>", card: c,
});

describe("a watched chat's card", () => {
  it("goes only to the chats bound to the session that set the watch", async () => {
    const bound = connectChat(freshChat());
    const other = connectChat(freshChat());
    const t = setup({ "asst-bound": [bound] });
    watchEvents.emit("watch_decision", decision("asst-bound", card("make deploy")));
    await fake.waitFor(() => texts(fake, bound).length === 1);
    await t.queue.whenIdle();
    expect(texts(fake, other)).toEqual([]);
    const [message] = fake.sent(Number(bound));
    expect(message!.text).toContain("Chat “Deploy <prod>” in api needs your decision");
    expect(message!.text).toContain("make deploy");
    expect(message!.text).toContain("Open in PPM: http://localhost:8080/project/api?openChat=claude/target-1");
    expect(fake.buttons(Number(bound), message!.message_id).flat().map((b) => b.text)).toEqual(["Allow", "Deny"]);
  });

  it("goes to every connected chat when no chat is bound to that session", async () => {
    const a = connectChat(freshChat());
    const b = connectChat(freshChat());
    const revoked = connectChat(freshChat());
    disconnectChat(revoked);
    const t = setup();
    watchEvents.emit("watch_decision", decision("asst-unbound", card("npm publish")));
    await fake.waitFor(() => texts(fake, a).length === 1 && texts(fake, b).length === 1);
    await t.queue.whenIdle();
    expect(texts(fake, revoked)).toEqual([]);
  });

  it("offers no Allow on a write too long to read on the phone", async () => {
    const chat = connectChat(freshChat());
    const t = setup({ "asst-w": [chat] });
    const write: LiveApprovalCard = { requestId: "r-long", tool: "Write", input: { file_path: "/repo/big.txt", content: "x".repeat(4000) }, isQuestion: false };
    watchEvents.emit("watch_decision", decision("asst-w", write));
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    const [message] = fake.sent(Number(chat));
    expect(fake.buttons(Number(chat), message!.message_id).flat().map((b) => b.text)).toEqual(["Deny"]);
  });

  it("is shown once per chat, however many watches or /status ask for it", async () => {
    const chat = connectChat(freshChat());
    const t = setup({ "asst-a": [chat], "asst-b": [chat] });
    const c = card("make test");
    watchEvents.emit("watch_decision", decision("asst-a", c));
    watchEvents.emit("watch_decision", { ...decision("asst-b", c), watchId: "w2" });
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    await Bun.sleep(20);
    expect(texts(fake, chat)).toHaveLength(1);
    expect(t.cards.isShowing(chat, c.requestId)).toBe(true);
  });
});

describe("a watch report", () => {
  const report = (assistantSessionId: string, text: string): WatchEvents["watch_reported"] => ({
    watchId: "w1", assistantSessionId, targetSessionId: "target-9", targetProject: "web", targetTitle: "Nightly build", kind: "done", text,
  });

  it("from a session no chat is bound to reaches every connected chat, redacted", async () => {
    const a = connectChat(freshChat());
    const b = connectChat(freshChat());
    const t = setup();
    watchEvents.emit("watch_reported", report("asst-unbound", "Build green. Token sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB rotated."));
    await fake.waitFor(() => texts(fake, a).length === 1 && texts(fake, b).length === 1);
    await t.queue.whenIdle();
    const text = texts(fake, a)[0]!;
    expect(text).toStartWith("🔔 Nightly build in web finished.");
    expect(text).toContain("Build green.");
    expect(text).not.toContain("sk-ant-api03-BBBB");
    expect(text).toContain("Open in PPM: http://localhost:8080/project/web?openChat=claude/target-9");
  });

  it("from a bound session is left to that session's own conversation", async () => {
    const chat = connectChat(freshChat());
    const t = setup({ "asst-bound": [chat] });
    watchEvents.emit("watch_reported", report("asst-bound", "Done."));
    await Bun.sleep(30);
    await t.queue.whenIdle();
    expect(texts(fake, chat)).toEqual([]);
  });

  it("stops reaching a chat once it is disconnected", async () => {
    const kept = connectChat(freshChat());
    const cut = connectChat(freshChat());
    disconnectChat(cut);
    const t = setup();
    watchEvents.emit("watch_reported", report("asst-x", "Done."));
    await fake.waitFor(() => texts(fake, kept).length === 1);
    await t.queue.whenIdle();
    expect(texts(fake, cut)).toEqual([]);
  });
});
