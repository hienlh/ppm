/**
 * The pinned card desk, played through the real bridge against the fake Bot API: three chats wait
 * on approvals, the phone answers one on the desk, moves to another with a number, gets a
 * reminder under the desk, brings the desk down with /cards, and answers the rest. After each step
 * the phone's chat is written as a snapshot (every message the bot sent, as HTML, with its buttons
 * and what is pinned), which `telegram-card-desk-e2e.mjs` draws as a phone screen.
 *
 *   bun tests/e2e/fixtures/telegram-card-desk-scenario.ts <out.json>
 *
 * No real Telegram, no real model, no real PPM data: `test-setup.ts` gives a scratch PPM_HOME and an
 * in-memory database. Exits non-zero when a step does not happen.
 */
import "../../test-setup.ts";
import { writeFileSync } from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionProvider, setSessionTitle, upsertApprovedPairing } from "../../../src/services/db.service.ts";
import { chatControl } from "../../../src/services/chat-control/chat-control.ts";
import { AssistantWatchService } from "../../../src/services/assistant-watch/assistant-watch.service.ts";
import { WATCH_OPENER } from "../../../src/services/assistant-watch/watch-event-text.ts";
import { assistantTelegramBridge } from "../../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { memoryCardDeskStore } from "../../../src/services/assistant-telegram/assistant-telegram-cards-desk-store.ts";
import type { TelegramSilence } from "../../../src/services/assistant-telegram/assistant-telegram-silence.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../src/services/telegram/telegram-api-base.ts";
import { startFakeTelegram } from "../../helpers/fake-telegram-bot-api.ts";
import type { AIProvider, ChatEvent } from "../../../src/types/chat.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: bun telegram-card-desk-scenario.ts <out.json>");

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

const P = "stub-desk-e2e";
const answers = new Map<string, (r: { approved: boolean; data?: unknown }) => void>();
const answered: Array<{ sessionId: string; data?: unknown }> = [];
providerRegistry.register({
  id: P, name: "Desk e2e", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: P, title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    // The Assistant session is told a watched chat finished: it answers, it asks nothing.
    if (message === WATCH_OPENER) {
      yield { type: "text", content: "Noted." };
      yield { type: "done", sessionId };
      return;
    }
    const requestId = crypto.randomUUID();
    const answer = new Promise<{ approved: boolean; data?: unknown }>((resolve) => answers.set(requestId, resolve));
    if (message.startsWith("ask:")) {
      // A question that takes the user's own words, as a chat's AskUserQuestion does.
      yield {
        type: "approval_request", requestId, tool: "AskUserQuestion", input: { questions: [] },
        questions: [{ id: "q", question: message.slice(4), options: [], multiSelect: false, allowsFreeText: true }],
      } as unknown as ChatEvent;
      const r = await answer;
      answered.push({ sessionId, data: r.data });
      yield { type: "text", content: "Thanks." };
    } else {
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: message } };
      const r = await answer;
      yield { type: "text", content: r.approved ? "Ran it." : "Did not run it." };
    }
    yield { type: "done", sessionId };
  },
  resolveApproval(requestId: string, approved: boolean, data?: unknown) {
    answers.get(requestId)?.({ approved, data });
    answers.delete(requestId);
  },
} as unknown as AIProvider);

const ME = 7_300_001;
const root = mkdtempSync(join(tmpdir(), "ppm-desk-e2e-"));
for (const p of ["nxsys", "ppm"]) mkdirSync(join(root, p), { recursive: true });
configService.set("projects", [{ name: "nxsys", path: join(root, "nxsys") }, { name: "ppm", path: join(root, "ppm") }]);
configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 30, card_desk: true });
upsertApprovedPairing(String(ME), String(ME), "Phone");
getDb();
await import("../../../src/server/ws/chat.ts");
const { notificationService } = await import("../../../src/services/notification.service.ts");
notificationService.broadcast = async () => {};
const watch = new AssistantWatchService({ notify: () => {}, retryDelayMs: 0, tickMs: 3_600_000 });
watch.start();
// The user is at PPM: cards go out without a sound, so the reminder under the desk comes into play.
const silence = { enabled: () => true, inPpm: () => true, notePpmMessage: () => {} } as unknown as TelegramSilence;
await assistantTelegramBridge.start({
  token: fake.token,
  client: { editIntervalMs: 0, sleep: async () => {} },
  debounceMs: 30, pollTimeoutS: 1, scaleDelay: (ms) => ms / 1000,
  sessionLink: async (provider, id) => `https://ppm.example.com/assistant?session=${provider}/${id}`,
  chatLink: async (project, provider, id) => `https://ppm.example.com/project/${project}?openChat=${provider}/${id}`,
  desk: { store: memoryCardDeskStore(), timing: { debounceMs: 0, quietAfterUserMs: 0, minGapMs: 0, maxWaitMs: 0 } }, silence, reminders: { delayMs: 1500 },
});

const ctl = () => chatControl()!;
const until = <T>(what: string, check: () => T | undefined | null | false, ms = 10_000) =>
  fake.waitFor(() => check(), ms).catch(() => { throw new Error(`step did not happen: ${what}`); });
const sent = () => fake.sent(ME);
const desk = () => sent().find((m) => m.message_id === fake.pins(ME).at(-1));
const button = (id: number, text: string) => fake.buttons(ME, id).flat().find((b) => b.text === text)?.callback_data;

const assistant = `asst-${crypto.randomUUID()}`;
setSessionAssistant(assistant);
setSessionProvider(assistant, P);
async function ask(project: string, title: string, command: string): Promise<string> {
  const id = `chat-${crypto.randomUUID()}`;
  setSessionProvider(id, P);
  setSessionTitle(id, title);
  watch.watch({ assistantSessionId: assistant, targetSessionId: id, targetProject: project, targetProvider: P, notifyOn: ["done"] });
  await ctl().sendUserMessage(id, command, { origin: "telegram", projectName: project, providerId: P });
  await until(`card for ${title}`, () => sent().some((m) => m.text.includes(command.replace(/^ask:/, "")) && !m.text.startsWith("🔔 Waiting")));
  return id;
}

type Shot = { name: string; caption: string; messages: unknown[]; pins: number[] };
const shots: Shot[] = [];
async function shot(name: string, caption: string): Promise<void> {
  await assistantTelegramBridge.settle();
  shots.push({
    name, caption, pins: fake.pins(ME),
    messages: sent().map((m) => ({ id: m.message_id, html: m.html ?? null, text: m.text, buttons: m.reply_markup?.inline_keyboard ?? [], replyTo: m.reply_to ?? null, silent: m.silent })),
  });
}

try {
  const deploy = await ask("nxsys", "NX-6318 pension fix", "bun test tests/integration/payroll/pension-auto-enrol.integration.spec.ts");
  await ask("ppm", "Release 0.26.40", "git push origin main --tags");
  await ask("nxsys", "Staging deploy", "bash scripts/deploy-staging.sh NX-6318");
  await until("desk lists three", () => desk()?.text.includes("Waiting for you (3)"));
  await shot("impl-01-desk-three-cards", "Ba thẻ chờ: bàn trả lời ghim, thẻ cũ nhất hiện đầy đủ với Allow/Deny");

  const d = desk()!.message_id;
  fake.pressButton(ME, ME, d, button(d, "Allow")!);
  await until("first answered", () => !ctl().liveState(deploy)?.card);
  // Allow on the desk is Allow on the card: the card's own message says so.
  await until("the card says it was allowed", () => sent().some((m) => m.message_id !== d && m.text.includes("pension-auto-enrol") && m.text.includes("Allowed here")));
  await until("desk moved on", () => desk()?.text.includes("Waiting for you (2)"));
  await shot("impl-02-after-allow", "Bấm Allow ngay trên bàn: thẻ gốc ghi “Allowed here”, bàn chuyển sang thẻ kế");

  fake.pressButton(ME, ME, d, button(d, "2")!);
  await until("tab 2 shown", () => desk()?.text.includes("deploy-staging.sh"));
  await shot("impl-03-tab-two", "Bấm số 2: bàn hiện thẻ thứ hai");

  await until("reminder under the desk", () => sent().some((m) => m.reply_to === d && m.text.startsWith("⏰")), 15_000);
  await shot("impl-04-reminder", "Lời nhắc có tiếng là một dòng ngắn trả lời vào danh sách ghim");

  fake.pushText(ME, ME, "/cards");
  await until("desk moved down", () => sent().find((m) => m.message_id === d)?.text.includes("moved down"));
  await until("new desk pinned", () => fake.pins(ME).at(-1) !== d && desk()?.text.includes("Waiting for you"));
  await shot("impl-05-cards-command", "/cards: danh sách cũ ghi “moved down”, danh sách mới ghim ở cuối chat");

  for (let i = 0; i < 2; i++) {
    const now = desk()!.message_id;
    fake.pressButton(ME, ME, now, button(now, "Deny")!);
    await until(`answer ${i + 1}`, () => desk()?.text.includes(i === 0 ? "Waiting for you (1)" : "Nothing is waiting"));
  }
  await shot("impl-06-all-answered", "Trả lời hết: danh sách vẫn ghim và ghi “Nothing is waiting for you”");

  // ppm/99: the list moves to another card while the user is writing an answer to it.
  const migration = await ask("nxsys", "Data migration", "ask:Which database should the NX-6318 migration run against?");
  const region = await ask("ppm", "Release region", "ask:Which region gets 0.26.42 first?");
  await until("both questions listed", () => desk()?.text.includes("Waiting for you (2)"));
  const listed = desk()!.message_id;
  const first = ctl().liveState(migration)!.card!.requestId;
  ctl().answerApproval(migration, first, { approved: false }, "ws");
  await until("list moved on by itself", () => desk()?.text.includes("Which region") && desk()?.text.includes("Waiting for you (1)"));
  fake.pushText(ME, ME, "staging first, then eu-west", "private", {
    reply_to_message: { message_id: listed, date: Math.floor(Date.now() / 1000), chat: { id: ME, type: "private" } },
  });
  const question = await until("which-card question", () => sent().find((m) => m.text.startsWith("❓ Which card is this an answer to?")));
  await shot("impl-07-which-card", "ppm/99 — danh sách đổi thẻ lúc đang gõ: giữ câu trả lời, hỏi “Which card is this an answer to?”");
  fake.pressButton(ME, ME, question.message_id, fake.buttons(ME, question.message_id)[0]![0]!.callback_data!);
  await until("answer reached the card", () => answered.some((a) => a.sessionId === region && JSON.stringify(a.data).includes("staging first")));
  await until("question closed", () => sent().find((m) => m.message_id === question.message_id)?.text.includes("Sent as an answer to"));
  await shot("impl-08-sent-to-card", "ppm/99 — bấm thẻ: câu trả lời vào đúng thẻ đó, câu hỏi ghi “Sent as an answer to …”");

  writeFileSync(out, JSON.stringify({ chat: ME, shots }, null, 2));
  console.log(`ok: ${shots.length} snapshots`);
} catch (e) {
  console.error(`FAIL: ${(e as Error).message}`);
  writeFileSync(out, JSON.stringify({ chat: ME, shots, error: (e as Error).message }, null, 2));
  process.exitCode = 1;
} finally {
  await assistantTelegramBridge.stop();
  watch.stop();
  fake.stop();
  setTimeout(() => process.exit(), 200);
}
