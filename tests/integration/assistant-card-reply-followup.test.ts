/**
 * A reply to a manager's card is answered where it was typed, end to end: a fake Bot API plays the
 * phone, the real chat socket layer runs the manager chat (a scripted Claude that names its turns
 * the way real providers do), the real report tool files cards, the real bridge sends them, and the
 * card routes answer from PPM.
 *
 * The scenario is the one that prompted this: the user answers a card with a question resting on a
 * wrong assumption ("go ahead, surely it won't cost much quota, right?"); the manager answers that
 * it will cost a lot, with numbers, and asks again with a new card. The answer must reach the phone
 * under the card the user replied to — with a sound, though the user was at PPM a moment ago — and
 * sit under the card in PPM. Then the ways it can go wrong: a manager that answers first and
 * acknowledges its card after (the answer still arrives, the "Đã gửi card." does not), a turn that
 * fails halfway (only that it stopped), and a reply pushed into someone else's running turn that
 * another sender's turn follows (nothing at all — neither turn's text is known to be the answer).
 * Set `PPM_CARD_FOLLOWUP_DEMO_LOG` to write the exchange as a readable log.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionProvider, setSessionTitle, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { patchManagerChatRow } from "../../src/services/assistant-managers/manager-chats-db.ts";
import { clearMainSessionIf, setMainSession } from "../../src/services/assistant/assistant-main-session.ts";
import { sessionCollabMcpHandler } from "../../src/services/session-collab/session-collab-endpoint.ts";
import { sessionCollabMcpTokens } from "../../src/services/session-collab/session-collab-tokens.ts";
import { assistantCardRoutes } from "../../src/server/routes/assistant-cards.ts";
import { setAssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { startAssistantCards, stopAssistantCards } from "../../src/services/assistant-cards/assistant-cards-startup.ts";
import { assistantCards } from "../../src/services/assistant-cards/assistant-cards.service.ts";
import { FOLLOWUP_GRACE_MS } from "../../src/services/assistant-cards/card-reply-followup-tracker.ts";
import { assistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { TelegramSilence } from "../../src/services/assistant-telegram/assistant-telegram-silence.ts";
import { BRIDGE_STATE_ROW } from "../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { projectKey } from "../../src/services/project-name-for-path.ts";
import { decodeMessageBlocks } from "../../src/shared/chat-message-blocks.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { startFakeTelegram, type FakeSentMessage } from "../helpers/fake-telegram-bot-api.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

// ── The exchange, as a log a person can read ────────────────────────────────────
const log: string[] = [];
const logged = new Set<number>();
const PHONE = 8_600_001;
const firstLines = (text: string, n = 6) => text.split("\n").slice(0, n).map((l, i) => (i === 0 ? l : `      ${l}`)).join("\n");
/** Every bot message not logged yet, in the order Telegram numbered them. */
function logBot(): void {
  for (const m of [...fake.sent(PHONE)].sort((a, b) => a.message_id - b.message_id)) {
    if (logged.has(m.message_id)) continue;
    logged.add(m.message_id);
    const how = [`msg #${m.message_id}`, m.reply_to ? `reply_to #${m.reply_to}` : null, m.silent ? "silent" : "with sound"].filter(Boolean).join(", ");
    log.push(`Telegram  PPM bot → phone   (${how})\n      ${firstLines(m.text, 12)}`);
  }
}
const note = (line: string) => log.push(line);

// ── A scripted manager: it names its turns, and answers a question on a wrong premise ─────
const received: Array<{ sessionId: string; message: string }> = [];
let original: AIProvider | undefined;
let manager = "";
const ANSWER = [
  "Không ạ — chạy cái này **tốn nhiều quota** đấy:",
  "- Full regression trên Opus: ~1.2M tokens ≈ **40%** quota tuần này.",
  "- Quota tuần còn lại: 55%. Chạy xong còn ~15% cho 4 ngày.",
  "Em chưa chạy gì. Em mở card mới để anh quyết lại.",
].join("\n");
const OTHER_ANSWER = "Gửi Assistant: khách Foo Ltd còn nợ 1.234 £ (ticket NX-77).";
/** How the manager answers a question in a reply: as the rule says, the other way round, or failing. */
let script: "card-then-answer" | "answer-then-card" | "fail" = "card-then-answer";
let releaseLongTurn: (() => void) | null = null;
let longTurnLive = false;
const stub = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message });
    if (opts?.clientMessageId) yield { type: "turn_started", turnId: crypto.randomUUID(), clientMessageId: opts.clientMessageId };
    const words = decodeMessageBlocks(message);
    if (sessionId === manager && words.content.includes("LONG-TASK")) {
      // A turn someone else started, still running when the user replies to a card.
      note(`PPM       manager chat ← another sender's message opens a long turn: “${words.content}”`);
      yield { type: "text", content: "Đang chạy việc A…" };
      longTurnLive = true;
      await new Promise<void>((resolve) => { releaseLongTurn = resolve; });
      longTurnLive = false;
      yield { type: "text", content: "Xong việc A: 12 file đã sửa." };
      note("PPM       manager chat → the long turn ends: “Xong việc A: 12 file đã sửa.” (it never named the pushed reply)");
    } else if (sessionId === manager && words.content.includes("OTHER-SENDER")) {
      yield { type: "text", content: OTHER_ANSWER };
      note(`PPM       manager chat → another sender's turn answers them: “${OTHER_ANSWER}”`);
    } else if (sessionId === manager && words.userWords && /nhỉ|\?/.test(words.content)) {
      note(`PPM       manager chat ← user's words (card ${words.userWords.cardId?.slice(0, 8)}, via ${words.userWords.channel}): “${words.content}”`);
      if (script === "fail") {
        yield { type: "text", content: "Để em kiểm tra quota, chạy cái này sẽ tố" };
        note("PPM       manager chat → the turn fails halfway (API error) after “Để em kiểm tra quota, chạy cái này sẽ tố”");
        throw new Error("API overloaded");
      }
      // The rule says new card first, answer last; `answer-then-card` is a model that does it the
      // other way round and then acknowledges the card.
      if (script === "answer-then-card") yield { type: "text", content: ANSWER };
      else yield { type: "text", content: "Để em kiểm tra quota trước…" };
      yield { type: "tool_use", tool: "mcp__ppm-sessions__report_to_assistant", toolUseId: "t1", input: {} };
      const cardId = await report({ kind: "needs_decision", title: "Chạy full regression trên Opus? Tốn ~40% quota tuần", body: "Còn 55% quota; chạy xong còn ~15% cho 4 ngày." });
      note(`PPM       manager chat → report_to_assistant: new needs_decision card ${cardId.slice(0, 8)}`);
      yield { type: "tool_result", toolUseId: "t1", output: `{"cardId":"${cardId}"}` };
      if (script === "answer-then-card") {
        yield { type: "text", content: "Đã gửi card." };
        note(`PPM       manager chat → it answered first:\n      ${ANSWER.replace(/\n/g, "\n      ")}\n      … then wrote after the card: “Đã gửi card.”`);
      } else {
        yield { type: "text", content: ANSWER };
        note(`PPM       manager chat → final answer of that turn:\n      ${ANSWER.replace(/\n/g, "\n      ")}`);
      }
    } else {
      yield { type: "text", content: "Noted." };
    }
    yield { type: "done", sessionId };
  },
  // Only the long turn has a live stream to push into; every other turn ends before a reply comes.
  hasStreamingSession(sessionId: string) { return longTurnLive && sessionId === manager; },
  // A real CLI folds a pushed message into the running turn and never names it.
  pushMessage(sessionId: string, message: string) { received.push({ sessionId, message }); return true; },
  resolveApproval() {},
  abortQuery() {},
} as unknown as AIProvider;

// ── Fixtures ─────────────────────────────────────────────────────────────────────
const home = process.env.PPM_HOME!;
const projectPath = join(home, "followup-proj");
const app = new Hono();
app.all("/mcp", sessionCollabMcpHandler);
app.route("/api/assistant", assistantCardRoutes);
let projectsBefore: PpmConfig["projects"] = [];
let assistantBefore: unknown;
const clawbotBefore = configService.get("clawbot");
let assistant = "";
let clock = Date.UTC(2026, 10, 15, 2, 0, 0); // 09:00 in Asia/Saigon
const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
const advance = (ms: number) => {
  clock += ms;
  for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); }
};
/** Whether the user has touched a PPM tab lately ("quiet while I'm at PPM"). */
let atPpm = true;
/** Scenario 2's card, replied to again in quiet hours. */
let ppmCardId = "";
let notifySpy: ReturnType<typeof spyOn>;

async function report(args: Record<string, unknown>): Promise<string> {
  const token = sessionCollabMcpTokens.mint({ sessionId: manager });
  const res = await app.request("/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_to_assistant", arguments: args } }),
  });
  const result = (await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  if (result.isError) throw new Error(result.content[0]!.text);
  return (JSON.parse(result.content[0]!.text) as { cardId: string }).cardId;
}

beforeAll(async () => {
  getDb().query("DELETE FROM config WHERE key = ?").run(BRIDGE_STATE_ROW);
  getDb().query("DELETE FROM clawbot_paired_chats").run();
  getDb().run("DELETE FROM assistant_cards");
  upsertApprovedPairing(String(PHONE), String(PHONE), "Phone");
  mkdirSync(projectPath, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  const saved = configService.get("assistant");
  assistantBefore = saved === undefined ? undefined : structuredClone(saved);
  configService.set("assistant", { ...(saved as object ?? {}), quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, timezone: "Asia/Saigon" } as never);
  configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 30 } as never);
  setAssistantClock({ now: () => clock, setTimer: (fn, ms) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } });
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "ppm", path: projectPath }]);
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notifySpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});
  manager = `c-${crypto.randomUUID()}`;
  setSessionMetadata(manager, "ppm", projectPath);
  setSessionProvider(manager, "claude");
  setSessionTitle(manager, "Manager");
  await managerChats.assign("ppm", manager, "user");
  patchManagerChatRow(projectKey(projectPath), { telegramDetail: "full" });
  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "assistant-work"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
  setMainSession(assistant);
  startAssistantCards();
  await assistantTelegramBridge.start({
    token: fake.token, client: { editIntervalMs: 0, sleep: async () => {} },
    debounceMs: 30, pollTimeoutS: 1, scaleDelay: (ms) => ms / 1000,
    sessionLink: async (p, id) => `https://ppm.example.com/assistant?session=${p}/${id}`,
    chatLink: async (project, p, id) => `https://ppm.example.com/project/${project}?openChat=${p}/${id}`,
    silence: new TelegramSilence({ enabled: () => true, idleMs: () => (atPpm ? 0 : null), now: () => clock }),
  });
});

afterAll(async () => {
  await assistantTelegramBridge.stop();
  stopAssistantCards();
  assistantWakeQueue.stop();
  clearMainSessionIf(assistant);
  configService.set("assistant", (assistantBefore ?? {}) as never);
  getDb().query("DELETE FROM clawbot_paired_chats WHERE telegram_chat_id = ?").run(String(PHONE));
  configService.set("clawbot", clawbotBefore!);
  managerChats.unassign("ppm");
  configService.set("projects", projectsBefore);
  setAssistantClock(null);
  notifySpy?.mockRestore();
  if (original) providerRegistry.register(original);
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
  const out = process.env.PPM_CARD_FOLLOWUP_DEMO_LOG;
  if (out) writeFileSync(out, `${[
    "Demo: a card reply that asks a question is answered where it was typed",
    "(server-free integration test tests/integration/assistant-card-reply-followup.test.ts;",
    " real chat socket layer, report tool, card routes and Telegram bridge; fake Telegram Bot API; scripted manager)",
    "Quiet while at PPM: ON, and the user counts as at PPM unless the step says otherwise.",
    "Bot messages are listed in Telegram's own numbering, gathered after each step, so a PPM line can sit just",
    "before a bot message sent at the same moment (the ack #3 left while the manager was answering).",
    "",
    ...log.map((l, i) => `${String(i + 1).padStart(2, "0")}. ${l}`),
  ].join("\n")}\n`);
});

const ctl = () => chatControl()!;
const until = <T>(check: () => T | undefined | null | false, ms = 5000) => fake.waitFor(check, ms);
const idle = (id: string) => until(() => (ctl().liveState(id)?.phase ?? "idle") === "idle");
const lastWith = (part: string): FakeSentMessage | undefined => fake.sent(PHONE).findLast((m) => m.text.includes(part));
const replyTo = (messageId: number, text: string) =>
  fake.pushText(PHONE, PHONE, text, "private", { reply_to_message: { message_id: messageId, chat: { id: PHONE, type: "private" }, date: 0 } });

describe("the manager's answer to a card reply", () => {
  it("reaches Telegram under the replied-to card, with a sound, after the new card it opened — and sits under the card in PPM", async () => {
    note("── Scenario 1: the user replies on Telegram with a question resting on a wrong assumption ──");
    const cardId = await report({ kind: "needs_decision", title: "Chạy full regression suite trên Opus cho PR #1312?", body: "Cần anh OK trước khi chạy." });
    note(`PPM       manager chat → report_to_assistant: needs_decision card ${cardId.slice(0, 8)}`);
    const card = await until(() => lastWith("Chạy full regression suite"));
    logBot();
    const question = "dùng đi chắc ko tốn nhiều quota đâu nhỉ";
    // The user is on the phone now, but was at PPM a moment ago: quiet mode would hush other messages.
    const typed = replyTo(card.message_id, question);
    note(`Telegram  phone → PPM bot   (msg #${typed.message?.message_id}, reply_to #${card.message_id}): “${question}”`);
    const followUp = await until(() => fake.sent(PHONE).find((m) => m.text.includes("The manager's answer to your reply")));
    await idle(manager);
    await assistantTelegramBridge.settle();
    logBot();

    expect(followUp.reply_to).toBe(card.message_id);
    expect(followUp.silent).toBe(false);
    expect(followUp.text).toContain("tốn nhiều quota");
    expect(followUp.text).toContain("~1.2M tokens ≈ 40%");
    expect(followUp.text).not.toContain("Để em kiểm tra quota trước");
    expect(followUp.text).toContain("It also opened a new card: Chạy full regression trên Opus? Tốn ~40% quota tuần");
    expect(fake.buttons(PHONE, followUp.message_id).flat()[0]).toMatchObject({ text: "Open in PPM" });
    const ack = lastWith("word for word")!;
    expect(ack.text).toContain("If the manager answers, it will come here, under the card.");
    const newCard = fake.sent(PHONE).find((m) => m.text.startsWith("🔔 Needs your decision") && m.text.includes("Tốn ~40% quota tuần"))!;
    expect(newCard.silent).toBe(true);
    // The new decision went out at once (silently: the user was at PPM); the answer followed it.
    expect(newCard.message_id).toBeLessThan(followUp.message_id);
    expect(fake.sent(PHONE).filter((m) => m.text.includes("The manager's answer to your reply"))).toHaveLength(1);
    const stored = assistantCards.get(cardId)!;
    expect(stored.status).toBe("answered");
    expect(stored.followUp).toMatchObject({ text: ANSWER, truncated: false });
    note(`PPM       card ${cardId.slice(0, 8)} in the Assistant window: answered, with “The manager's answer to your reply” under it (${stored.followUp!.text.length} chars)`);
  });

  it("goes under the card's Telegram copy, silently, when the reply was typed in PPM while the user is there", async () => {
    note("");
    note("── Scenario 2: the user replies from PPM (and is at PPM) ──");
    atPpm = true;
    const cardId = await report({ kind: "needs_decision", title: "Bật Codex proxy cho máy NAS?", body: "Cần anh OK." });
    const card = await until(() => lastWith("Bật Codex proxy"));
    logBot();
    const question = "Bật thì có tốn quota không?";
    note(`PPM       Assistant window → reply on card ${cardId.slice(0, 8)}: “${question}”`);
    const res = await app.request(`/api/assistant/cards/${cardId}/reply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: question }),
    });
    expect(res.status).toBe(200);
    const followUp = await until(() => fake.sent(PHONE).find((m) => m.reply_to === card.message_id && m.text.includes("The manager's answer")));
    await idle(manager);
    await assistantTelegramBridge.settle();
    logBot();
    expect(followUp.silent).toBe(true);
    expect(assistantCards.get(cardId)!.followUp?.text).toContain("tốn nhiều quota");
    ppmCardId = cardId;
  });

  it("stays in PPM when the reply was typed in PPM during quiet hours, though the card is on Telegram", async () => {
    note("");
    note("── Scenario 3: the same, at 23:00 (quiet hours) ──");
    advance(14 * 60 * 60_000); // 23:00 Asia/Saigon
    const before = fake.sent(PHONE).length;
    const firstAnswerAt = assistantCards.get(ppmCardId)!.followUp!.at;
    const question = "Thế tắt đi thì đỡ bao nhiêu?";
    note(`PPM       Assistant window → another reply on card ${ppmCardId.slice(0, 8)} (Send anyway): “${question}”`);
    const res = await app.request(`/api/assistant/cards/${ppmCardId}/reply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: question, force: true }),
    });
    expect(res.status).toBe(200);
    await until(() => (assistantCards.get(ppmCardId)!.followUp?.at ?? 0) > firstAnswerAt);
    await idle(manager);
    await assistantTelegramBridge.settle();
    expect(fake.sent(PHONE).length).toBe(before);
    note("PPM       the manager's new answer replaced the old one under the card in PPM; nothing went to Telegram (quiet hours; its new card is held for 07:00 as every card is)");
  });

  it("still reaches the phone when the manager answers first and opens its card after, without its 'Đã gửi card.'", async () => {
    note("");
    note("── Scenario 4: next morning 08:30; the manager answers first, then opens the card and says so ──");
    advance(9.5 * 60 * 60_000); // 08:30 Asia/Saigon: the held cards went out at 07:00
    await assistantTelegramBridge.settle();
    logBot();
    script = "answer-then-card";
    const cardId = await report({ kind: "needs_decision", title: "Bật cache cho CI?", body: "Cần anh OK." });
    const card = await until(() => lastWith("Bật cache cho CI"));
    logBot();
    const question = "bật thì chắc ko tốn gì nhỉ";
    const typed = replyTo(card.message_id, question);
    note(`Telegram  phone → PPM bot   (msg #${typed.message?.message_id}, reply_to #${card.message_id}): “${question}”`);
    const followUp = await until(() => fake.sent(PHONE).find((m) => m.reply_to === card.message_id && m.text.includes("The manager's answer")));
    await idle(manager);
    await assistantTelegramBridge.settle();
    logBot();
    script = "card-then-answer";
    expect(followUp.silent).toBe(false);
    expect(followUp.text).toContain("~1.2M tokens ≈ 40%");
    expect(followUp.text).not.toContain("Đã gửi card");
    expect(assistantCards.get(cardId)!.followUp?.text).toBe(ANSWER);
  });

  it("tells the phone only that the turn stopped when it fails halfway, and keeps nothing on the card", async () => {
    note("");
    note("── Scenario 5: the manager's turn fails halfway through its answer ──");
    script = "fail";
    const cardId = await report({ kind: "needs_decision", title: "Xoá các nhánh cũ trên origin?", body: "Cần anh OK." });
    const card = await until(() => lastWith("Xoá các nhánh cũ"));
    logBot();
    const question = "xoá hết luôn được không?";
    const typed = replyTo(card.message_id, question);
    note(`Telegram  phone → PPM bot   (msg #${typed.message?.message_id}, reply_to #${card.message_id}): “${question}”`);
    const notice = await until(() => fake.sent(PHONE).find((m) => m.reply_to === card.message_id && m.text.includes("stopped before it answered")));
    await idle(manager);
    await assistantTelegramBridge.settle();
    logBot();
    script = "card-then-answer";
    expect(notice.silent).toBe(false);
    expect(notice.text).not.toContain("sẽ tố");
    expect(notice.text).not.toContain("The manager's answer to your reply");
    expect(assistantCards.get(cardId)!.followUp).toBeUndefined();
    note(`PPM       card ${cardId.slice(0, 8)}: nothing kept under it (a half sentence is not an answer)`);
  });

  it("sends nothing when a reply pushed into a running turn is followed by another sender's turn", async () => {
    note("");
    note("── Scenario 6: the user replies while the manager runs someone else's turn, and another turn follows it ──");
    const cardId = await report({ kind: "needs_decision", title: "Gộp PR #1400 vào main?", body: "Cần anh OK." });
    const card = await until(() => lastWith("Gộp PR #1400"));
    logBot();
    void ctl().sendUserMessage(manager, "LONG-TASK: sửa 12 file", {
      origin: "telegram", projectName: "ppm", providerId: "claude", clientMessageId: `long-${crypto.randomUUID()}`,
    });
    await until(() => releaseLongTurn !== null && ctl().liveState(manager)?.running);
    const question = "gộp luôn được không?";
    const typed = replyTo(card.message_id, question);
    note(`Telegram  phone → PPM bot   (msg #${typed.message?.message_id}, reply_to #${card.message_id}): “${question}”`);
    await until(() => received.some((r) => decodeMessageBlocks(r.message).userWords?.cardId === cardId));
    note("PPM       the reply is pushed into the running turn (inserted); no turn is named with its id");
    releaseLongTurn!();
    releaseLongTurn = null;
    await idle(manager);
    // Within the grace, another sender's message opens a turn of its own.
    await ctl().sendUserMessage(manager, "OTHER-SENDER: số dư Foo Ltd?", {
      origin: "telegram", projectName: "ppm", providerId: "claude", clientMessageId: `other-${crypto.randomUUID()}`,
    });
    await until(() => received.some((r) => r.message.includes("OTHER-SENDER")));
    await idle(manager);
    advance(FOLLOWUP_GRACE_MS + 1);
    await assistantTelegramBridge.settle();
    logBot();
    expect(fake.sent(PHONE).filter((m) => m.reply_to === card.message_id && m.text.includes("The manager's answer"))).toHaveLength(0);
    expect(fake.sent(PHONE).some((m) => m.text.includes("Foo Ltd"))).toBe(false);
    expect(assistantCards.get(cardId)!.followUp).toBeUndefined();
    note("PPM       nothing sent for that reply: the turn it went into was followed by another sender's turn, so which text answers it is not known");
  });
});
