import { afterAll, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, memoryState, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { chatControl, setChatControl, type ApprovalAnswer, type ChatControl, type LiveApprovalCard } from "../../../../src/services/chat-control/chat-control.ts";
import type { ChatLifecycleEvents } from "../../../../src/services/chat-control/chat-lifecycle.ts";
import { AssistantTelegramCards } from "../../../../src/services/assistant-telegram/assistant-telegram-cards.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { TOO_LONG_NOTE } from "../../../../src/services/assistant-telegram/assistant-telegram-card-format.ts";
import { normalizeCodexQuestions } from "../../../../src/shared/approval-questions.ts";
import type { TelegramCallbackQuery } from "../../../../src/services/telegram/telegram-types.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

/** A chat control that answers what it is told to and records every answer. */
const answered: Array<{ sessionId: string; requestId: string; answer: ApprovalAnswer }> = [];
let nextResult: "answered" | "stale" = "answered";
let cards!: AssistantTelegramCards;
const previous = chatControl();
setChatControl({
  answerApproval(sessionId, requestId, answer) {
    answered.push({ sessionId, requestId, answer });
    const result = nextResult;
    nextResult = "answered";
    // The real one ends the card synchronously, which reaches every surface showing it.
    if (result === "answered") cards.resolved({ sessionId, requestId, approved: answer.approved, reason: "answered", by: "telegram" });
    return result;
  },
} as Partial<ChatControl> as ChatControl);
afterAll(() => setChatControl(previous));

function setup(link = "http://localhost:8080/assistant?session=claude/s") {
  const chat = connectChat(freshChat());
  const queue = queueFor(client);
  const codes = new ButtonCodes<BridgeAction>();
  cards = new AssistantTelegramCards({ queue, state: memoryState(), codes, now: Date.now, sessionLink: async () => link });
  /** Shows a card and waits for it to be on Telegram. */
  const show = async (card: Partial<LiveApprovalCard> & { tool: string; input: unknown }) => {
    const full: LiveApprovalCard = { requestId: `req-${crypto.randomUUID()}`, isQuestion: false, ...card };
    const payload: ChatLifecycleEvents["approval_shown"] = { sessionId: "s", card: full, projectName: "__assistant__", providerId: "claude" };
    const before = fake.sent(Number(chat)).length;
    cards.shown(chat, payload);
    const message = await fake.waitFor(() => fake.sent(Number(chat))[before]);
    await queue.whenIdle();
    return { message, requestId: full.requestId };
  };
  const buttons = (messageId: number) => fake.buttons(Number(chat), messageId).flat();
  const press = (messageId: number, text: string) => {
    const data = buttons(messageId).find((b) => b.text.includes(text))?.callback_data;
    const found = codes.peek(data, chat);
    if (!found.ok || found.action.kind !== "card") return "no such button";
    return cards.press(chat, found.action, found.group, {} as TelegramCallbackQuery);
  };
  return { chat, queue, codes, show, buttons, press };
}

describe("approval cards on Telegram", () => {
  it("shows a command with > and backticks exactly, and offers Allow", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "Bash", input: { command: "echo `date` > ~/.bashrc && cat <in", cwd: "/repo" } });
    expect(message.text).toContain("echo `date` > ~/.bashrc && cat <in");
    expect(message.text).toContain("Folder: /repo");
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["Allow", "Deny"]);
  });

  it("offers no Allow on a write too long to show in full", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "Write", input: { file_path: "/repo/a.txt", content: "x".repeat(4000) } });
    expect(message.text).toContain(TOO_LONG_NOTE);
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["Deny"]);
    expect(message.text.length).toBeLessThanOrEqual(4096);
  });

  it("offers no Allow on a Codex patch, whose diff never reaches PPM", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "Edit", input: { files: ["src/a.ts"], reason: "fix" } });
    expect(message.text).toContain("src/a.ts");
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["Deny"]);
  });

  it("shows an MCP tool's whole arguments and offers Allow", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "mcp__linear__create_issue", input: { server: "linear", tool: "create_issue", arguments: { title: "Bug", priority: 1 } } });
    expect(message.text).toContain("\"title\": \"Bug\"");
    expect(t.buttons(message.message_id).map((b) => b.text)).toContain("Allow");
  });

  it("hides a secret in what it shows, says so, and still offers Allow", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "Bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x.example" } });
    expect(message.text).not.toContain("abcdefghijklmnop");
    expect(message.text).toContain("secret-looking value");
    expect(t.buttons(message.message_id).map((b) => b.text)).toContain("Allow");
  });

  it("answers once: a second press is no longer valid, and the card loses its buttons", async () => {
    const t = setup();
    const { message, requestId } = await t.show({ tool: "Bash", input: { command: "rm -rf build" } });
    const allowData = t.buttons(message.message_id).find((b) => b.text === "Allow")!.callback_data;
    expect(t.press(message.message_id, "Allow")).toBe("Allowed.");
    expect(answered.at(-1)).toMatchObject({ requestId, answer: { approved: true } });
    expect(t.codes.peek(allowData, t.chat).ok).toBe(false);
    await t.queue.whenIdle();
    const after = fake.sent(Number(t.chat)).find((m) => m.message_id === message.message_id)!;
    expect(after.reply_markup).toBeUndefined();
    expect(after.text).toContain("Allowed here.");
  });

  it("takes the buttons away when PPM answers first, or the card goes for another reason", async () => {
    const t = setup();
    const first = await t.show({ tool: "Bash", input: { command: "ls" } });
    cards.resolved({ sessionId: "s", requestId: first.requestId, approved: false, reason: "answered", by: "ws" });
    const second = await t.show({ tool: "Bash", input: { command: "pwd" } });
    cards.resolved({ sessionId: "s", requestId: second.requestId, approved: false, reason: "turn_ended" });
    await t.queue.whenIdle();
    const byId = (id: number) => fake.sent(Number(t.chat)).find((m) => m.message_id === id)!;
    expect(byId(first.message.message_id).text).toContain("Denied in PPM.");
    expect(byId(second.message.message_id).text).toContain("No longer waiting: the turn ended.");
    expect(byId(second.message.message_id).reply_markup).toBeUndefined();
  });

  it("says a card answered elsewhere is no longer waiting", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "Bash", input: { command: "ls" } });
    nextResult = "stale";
    expect(t.press(message.message_id, "Deny")).toBe("This card is no longer waiting.");
  });

  it("puts a localhost link in the text and a public one on a button", async () => {
    const local = setup();
    const a = await local.show({ tool: "Bash", input: { command: "ls" } });
    expect(a.message.text).toContain("Open in PPM: http://localhost:8080/assistant?session=claude/s");
    expect(local.buttons(a.message.message_id).some((b) => b.url)).toBe(false);
    const remote = setup("https://ppm.tail1234.ts.net/assistant?session=claude/s");
    const b = await remote.show({ tool: "Bash", input: { command: "ls" } });
    expect(remote.buttons(b.message.message_id).find((x) => x.url)?.url).toBe("https://ppm.tail1234.ts.net/assistant?session=claude/s");
  });
});

describe("question cards on Telegram", () => {
  it("answers a Codex question by its id with one press", async () => {
    const t = setup();
    const questions = normalizeCodexQuestions({ questions: [{ id: "deploy_target", question: "Where to?", options: [{ label: "staging" }, { label: "prod" }] }] });
    const { message, requestId } = await t.show({ tool: "AskUserQuestion", input: "{}", isQuestion: true, questions });
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["staging", "prod"]);
    expect(t.press(message.message_id, "prod")).toBe("Answer sent.");
    expect(answered.at(-1)).toEqual({ sessionId: "s", requestId, answer: { approved: true, answersById: { deploy_target: ["prod"] } } });
  });

  it("ticks several choices and sends them together", async () => {
    const t = setup();
    const questions = [{ id: "q1", question: "Which?", options: [{ label: "a" }, { label: "b" }, { label: "c" }], multiSelect: true, allowsFreeText: true }];
    const { message, requestId } = await t.show({ tool: "AskUserQuestion", input: {}, isQuestion: true, questions });
    expect(t.press(message.message_id, "Send")).toContain("missing");
    expect(t.press(message.message_id, "a")).toBe("Ticked.");
    expect(t.press(message.message_id, "c")).toBe("Ticked.");
    await t.queue.whenIdle();
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["✓ a", "b", "✓ c", "Send"]);
    expect(t.press(message.message_id, "Send")).toBe("Answer sent.");
    expect(answered.at(-1)).toEqual({ sessionId: "s", requestId, answer: { approved: true, answersById: { q1: ["a", "c"] } } });
  });

  it("sends a question that needs a typed or private answer to PPM", async () => {
    const t = setup();
    const questions = normalizeCodexQuestions({ questions: [{ id: "token", question: "API token?", isSecret: true }] });
    const { message } = await t.show({ tool: "AskUserQuestion", input: "{}", isQuestion: true, questions });
    expect(message.text).toContain("give it in PPM");
    expect(t.buttons(message.message_id)).toEqual([]);
  });
});
