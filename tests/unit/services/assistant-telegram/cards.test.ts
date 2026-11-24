import { afterAll, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, memoryState, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { chatControl, setChatControl, type ApprovalAnswer, type ChatControl, type LiveApprovalCard } from "../../../../src/services/chat-control/chat-control.ts";
import type { ChatLifecycleEvents } from "../../../../src/services/chat-control/chat-lifecycle.ts";
import { AssistantTelegramCards, expiryLine } from "../../../../src/services/assistant-telegram/assistant-telegram-cards.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { HIDDEN_NOTE, TOO_LONG_NOTE } from "../../../../src/services/assistant-telegram/assistant-telegram-card-format.ts";
import { normalizeCodexQuestions } from "../../../../src/shared/approval-questions.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { DEFAULT_ASSISTANT_SETTINGS } from "../../../../src/shared/assistant-settings.ts";
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

  it("heads the card with the Assistant's name when it has one, else \"PPM Assistant\"", async () => {
    const t = setup();
    const before = await t.show({ tool: "Bash", input: { command: "ls" } });
    expect(before.message.text).toStartWith("🔐 PPM Assistant wants to");
    configService.set("assistant", { ...structuredClone(DEFAULT_ASSISTANT_SETTINGS), persona: { name: "Mi", address_forms: [], soul: "" } });
    try {
      const named = await t.show({ tool: "Bash", input: { command: "ls" } });
      expect(named.message.text).toStartWith("🔐 Mi wants to");
      const asked = await t.show({ tool: "AskUserQuestion", isQuestion: true, input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] } });
      expect(asked.message.text).toStartWith("❓ Mi asks");
    } finally {
      configService.set("assistant", structuredClone(DEFAULT_ASSISTANT_SETTINGS));
    }
  });

  it("offers Allow & remember where the card has something to remember, and says what", async () => {
    const t = setup();
    const { message, requestId } = await t.show({ tool: "Bash", input: { command: "git status" }, remember: { label: "Run `git status`", suggest: true } });
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["Allow", "Deny", "Allow & remember"]);
    expect(message.text).toContain("Run `git status`");
    expect(message.text).toContain("You have allowed this 3 times");
    answered.length = 0;
    expect(t.press(message.message_id, "Allow & remember")).toContain("approve this kind by itself");
    expect(answered).toEqual([{ sessionId: "s", requestId, answer: { approved: true, remember: true } }]);
  });

  it("offers no Allow & remember where it offers no Allow", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "Write", input: { file_path: "/repo/a.txt", content: "x".repeat(4000) }, remember: { label: "Edit files at the project's top level", suggest: false } });
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["Deny"]);
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

  it("heads an Assistant card's verbatim body with its label", async () => {
    const t = setup();
    const { message } = await t.show({
      tool: "schedule_create", input: {},
      summary: { headline: "Create the schedule", facts: [{ label: "Enabled", value: "On" }], body: { label: "Prompt", text: "Trả lời đúng một chữ: ok", format: "text" } },
    });
    // The label sits on its own line between the last fact and the block it names.
    expect(message.text).toContain("Enabled: On\nPrompt:\nTrả lời đúng một chữ: ok");
    expect(t.buttons(message.message_id).map((b) => b.text)).toContain("Allow");
  });

  it("hides a secret in a command, says so, and offers no Allow on what it cannot show", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "Bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x.example" } });
    expect(message.text).not.toContain("abcdefghijklmnop");
    expect(message.text).toContain("secret-looking value");
    expect(message.text).toContain(HIDDEN_NOTE);
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["Deny"]);
  });

  it("hides a secret in an MCP tool's arguments, and offers no Allow there either", async () => {
    const t = setup();
    const { message } = await t.show({ tool: "mcp__api__call", input: { server: "api", tool: "call", arguments: { url: "https://x.example", headers: { authorization: "Bearer abcdefghijklmnop" } } } });
    expect(message.text).not.toContain("abcdefghijklmnop");
    expect(message.text).toContain("secret-looking value");
    expect(t.buttons(message.message_id).map((b) => b.text)).toEqual(["Deny"]);
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

  it("says a request that ended on its own was not answered, rather than denied", async () => {
    const t = setup();
    const { message, requestId } = await t.show({ tool: "Bash", input: { command: "ls" } });
    cards.resolved({ sessionId: "s", requestId, approved: false, reason: "request_ended" });
    await t.queue.whenIdle();
    const after = fake.sent(Number(t.chat)).find((m) => m.message_id === message.message_id)!;
    expect(after.text).toContain("No longer waiting: the request ended without an answer.");
    expect(after.text).not.toContain("Denied");
    expect(after.reply_markup).toBeUndefined();
  });

  it("says how long a card that gives up by itself has, and says once, under it, that it expired", async () => {
    const t = setup();
    const expiresAt = Date.now() + 9.6 * 60_000;
    const { message, requestId } = await t.show({
      tool: "ppm:session_collab", expiresAt,
      input: { kind: "create", title: "Design kho", providerId: "claude", model: null, task: "Make the design", depth: 1 },
    });
    expect(message.text).toContain("Expires in 10 minutes (at ");
    expect(message.text).toContain("If nobody answers by then, nothing is done.");
    const before = fake.sent(Number(t.chat)).length;
    cards.resolved({ sessionId: "s", requestId, approved: false, reason: "expired" });
    await t.queue.whenIdle();
    const all = fake.sent(Number(t.chat));
    const card = all.find((m) => m.message_id === message.message_id)!;
    expect(card.text).toContain("No longer waiting: it expired — nobody answered in time, so nothing was done.");
    expect(card.reply_markup).toBeUndefined();
    const notice = all.slice(before);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).toStartWith("⌛ This card expired: PPM Assistant wants to.");
    expect(notice[0]!.reply_to).toBe(message.message_id);
  });

  it("reads the deadline on the clock of the Assistant's time zone, not the server's", () => {
    const at = Date.UTC(2026, 10, 15, 14, 19);
    expect(expiryLine(at, at - 10 * 60_000, "Asia/Ho_Chi_Minh")).toContain("Expires in 10 minutes (at 21:19)");
    expect(expiryLine(at, at - 30_000, "UTC")).toContain("Expires in 1 minute (at 14:19)");
  });

  it("says nothing more when a card without a deadline ends", async () => {
    const t = setup();
    const { message, requestId } = await t.show({ tool: "Bash", input: { command: "ls" } });
    expect(message.text).not.toContain("Expires in");
    const before = fake.sent(Number(t.chat)).length;
    cards.resolved({ sessionId: "s", requestId, approved: false, reason: "turn_ended" });
    await t.queue.whenIdle();
    expect(fake.sent(Number(t.chat)).length).toBe(before);
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

  it("sends a question that needs a typed or private answer to PPM", async () => {
    const t = setup();
    const questions = normalizeCodexQuestions({ questions: [{ id: "token", question: "API token?", isSecret: true }] });
    const { message } = await t.show({ tool: "AskUserQuestion", input: "{}", isQuestion: true, questions });
    expect(message.text).toContain("give it in PPM");
    expect(t.buttons(message.message_id)).toEqual([]);
  });
});
