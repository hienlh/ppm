/**
 * The pinned card desk through the whole bridge: a fake Bot API plays the phone, the real chat
 * layer runs two watched chats that each wait on an approval, and the desk lists both. Allow
 * pressed on the desk answers the chat its card belongs to, exactly as on the card; the card's own
 * message loses its buttons and the desk moves on. `/cards` brings the desk to the bottom.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionProvider, setSessionTitle, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { AssistantWatchService } from "../../src/services/assistant-watch/assistant-watch.service.ts";
import { assistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { BRIDGE_STATE_ROW } from "../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { memoryCardDeskStore } from "../../src/services/assistant-telegram/assistant-telegram-cards-desk-store.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";
import type { AIProvider, ChatEvent } from "../../src/types/chat.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

const P = "stub-telegram-desk";
const answers = new Map<string, (r: { approved: boolean; data?: unknown }) => void>();
const outcomes: Array<{ sessionId: string; approved: boolean; data?: unknown }> = [];

providerRegistry.register({
  id: P, name: "Desk stub", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: P, title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    if (message.startsWith("ask:")) {
      // A question that takes the user's own words, as a chat's AskUserQuestion does.
      const requestId = crypto.randomUUID();
      const answer = new Promise<{ approved: boolean; data?: unknown }>((resolve) => answers.set(requestId, resolve));
      yield {
        type: "approval_request", requestId, tool: "AskUserQuestion", input: { questions: [] },
        questions: [{ id: "q", question: message.slice(4), options: [], multiSelect: false, allowsFreeText: true }],
      } as unknown as ChatEvent;
      const r = await answer;
      outcomes.push({ sessionId, approved: r.approved, data: r.data });
      yield { type: "text", content: "Thanks." };
    } else if (message.startsWith("approve:")) {
      const requestId = crypto.randomUUID();
      const answer = new Promise<{ approved: boolean }>((resolve) => answers.set(requestId, resolve));
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: message.slice(8) } };
      const r = await answer;
      outcomes.push({ sessionId, approved: r.approved });
      yield { type: "text", content: r.approved ? "Ran it." : "Did not run it." };
    } else {
      yield { type: "text", content: `Done: ${message}` };
    }
    yield { type: "done", sessionId };
  },
  resolveApproval(requestId: string, approved: boolean, data?: unknown) {
    answers.get(requestId)?.({ approved, data });
    answers.delete(requestId);
  },
} as unknown as AIProvider);

const PROJECT = "deskproj";
let root: string;
let savedProjects: unknown;
const savedClawbot = configService.get("clawbot");
let service: AssistantWatchService;
let notificationSpy: ReturnType<typeof spyOn>;
const me = 8_700_001;

beforeAll(async () => {
  getDb().query("DELETE FROM config WHERE key = ?").run(BRIDGE_STATE_ROW);
  root = mkdtempSync(join(tmpdir(), "ppm-telegram-desk-"));
  mkdirSync(join(root, PROJECT), { recursive: true });
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: PROJECT, path: join(root, PROJECT) }]);
  configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 30, card_desk: true });
  getDb().query("DELETE FROM clawbot_paired_chats").run();
  upsertApprovedPairing(String(me), String(me), "Phone");
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notificationSpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});
  service = new AssistantWatchService({ notify: () => {}, retryDelayMs: 0, tickMs: 3_600_000 });
  service.start();
  await assistantTelegramBridge.start({
    token: fake.token,
    client: { editIntervalMs: 0, sleep: async () => {} },
    debounceMs: 30, pollTimeoutS: 1, scaleDelay: (ms) => ms / 1000,
    sessionLink: async (provider, id) => `http://localhost:8080/assistant?session=${provider}/${id}`,
    chatLink: async (project, provider, id) => `http://localhost:8080/project/${project}?openChat=${provider}/${id}`,
    desk: { store: memoryCardDeskStore(), timing: { debounceMs: 0, quietAfterUserMs: 0, minGapMs: 0, maxWaitMs: 0 } },
  });
});

afterAll(async () => {
  await assistantTelegramBridge.stop();
  service.stop();
  notificationSpy?.mockRestore();
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
  configService.set("clawbot", savedClawbot!);
  configService.set("projects", savedProjects as never);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a session's handle lingers on Windows */ }
});

const ctl = () => chatControl()!;
const until = <T>(check: () => T | undefined | null | false, ms = 8000) => fake.waitFor(() => check(), ms);
const desk = () => fake.sent(me).find((m) => m.text.startsWith("🔔 Waiting for you") || m.text.startsWith("✅ Nothing"));
const byId = (id: number) => fake.sent(me).find((m) => m.message_id === id);
const button = (id: number, text: string) => fake.buttons(me, id).flat().find((b) => b.text === text)?.callback_data;

function targetChat(title: string): string {
  const id = `chat-${crypto.randomUUID()}`;
  setSessionProvider(id, P);
  setSessionTitle(id, title);
  return id;
}

describe("the card desk on a phone", () => {
  it("lists two waiting cards, answers one from the desk, and moves to the other", async () => {
    const assistant = `asst-${crypto.randomUUID()}`;
    setSessionAssistant(assistant);
    setSessionProvider(assistant, P);
    const [first, second] = [targetChat("Deploy prod"), targetChat("Migrate db")];
    for (const t of [first, second]) {
      service.watch({ assistantSessionId: assistant, targetSessionId: t, targetProject: PROJECT, targetProvider: P, notifyOn: ["done"] });
    }
    await ctl().sendUserMessage(first, "approve:make deploy", { origin: "telegram", projectName: PROJECT, providerId: P });
    const firstCard = await until(() => fake.sent(me).find((m) => m.text.includes("make deploy") && !m.text.startsWith("🔔 Waiting")));
    await ctl().sendUserMessage(second, "approve:db migrate", { origin: "telegram", projectName: PROJECT, providerId: P });
    await until(() => desk()?.text.includes("Waiting for you (2)"));

    const d = desk()!;
    expect(d.silent).toBe(true);
    expect(fake.pins(me)).toEqual([d.message_id]);
    // The oldest card is shown whole, with the Allow its own message carries.
    expect(d.text).toContain("make deploy");
    expect(d.text).toContain(`▸ 1. 🔐 ${PROJECT}`);
    expect(button(d.message_id, "Allow")).toBe(button(firstCard.message_id, "Allow"));

    fake.pressButton(me, me, d.message_id, button(d.message_id, "Allow")!);
    await until(() => outcomes.some((o) => o.sessionId === first && o.approved));
    await until(() => byId(d.message_id)?.text.includes("Waiting for you (1)"));
    expect(byId(d.message_id)!.text).toContain("db migrate");
    // The card's own message says it was allowed and has no buttons left.
    await until(() => byId(firstCard.message_id)?.text.includes("Allowed here"));
    expect(fake.buttons(me, firstCard.message_id)).toEqual([]);

    // Answered in PPM: the desk empties, and stays pinned.
    const requestId = ctl().liveState(second)!.card!.requestId;
    expect(ctl().answerApproval(second, requestId, { approved: false }, "ws")).toBe("answered");
    await until(() => byId(d.message_id)?.text.startsWith("✅ Nothing is waiting for you."));
    expect(fake.pins(me)).toEqual([d.message_id]);
  });

  it("keeps a reply written while the list moved to another card, asks which card, and sends it there", async () => {
    // The 15:35 case: the list showed one question; it was answered in PPM and the list moved on while
    // the user was typing an answer to the list. The words must not be lost, nor go where they were not meant.
    const assistant = `asst-${crypto.randomUUID()}`;
    setSessionAssistant(assistant);
    setSessionProvider(assistant, P);
    const [db, region] = [targetChat("Pick a database"), targetChat("Pick a region")];
    for (const t of [db, region]) {
      service.watch({ assistantSessionId: assistant, targetSessionId: t, targetProject: PROJECT, targetProvider: P, notifyOn: ["done"] });
    }
    await ctl().sendUserMessage(db, "ask:Which database?", { origin: "telegram", projectName: PROJECT, providerId: P });
    await until(() => desk()?.text.includes("Which database?"));
    await ctl().sendUserMessage(region, "ask:Which region?", { origin: "telegram", projectName: PROJECT, providerId: P });
    await until(() => desk()?.text.includes("Waiting for you (2)"));
    const d = desk()!;
    // Answered in PPM: the list moves to the other question by itself.
    const dbRequest = ctl().liveState(db)!.card!.requestId;
    expect(ctl().answerApproval(db, dbRequest, { approved: false }, "ws")).toBe("answered");
    await until(() => byId(d.message_id)?.text.includes("Which region?") && byId(d.message_id)?.text.includes("Waiting for you (1)"));

    const before = fake.sent(me).length;
    const reply = fake.pushText(me, me, "use eu-west, the one we used last time", "private", {
      reply_to_message: { message_id: d.message_id, date: Math.floor(Date.now() / 1000), chat: { id: me, type: "private" } },
    });
    const question = await until(() => fake.sent(me).slice(before).find((m) => m.text.startsWith("❓ Which card is this an answer to?")));
    expect(question.reply_to).toBe(reply.message!.message_id);
    expect(question.text).toContain("“use eu-west, the one we used last time”");
    expect(question.text).toContain("Answered meanwhile:");
    expect(fake.buttons(me, question.message_id).map((r) => r.map((b) => b.text))).toEqual([
      [expect.stringContaining("1. ❓ deskproj · Pick a region")], ["💬 Send to the Assistant instead"], ["✖ Don't send"],
    ]);
    // Nothing reached a chat yet: the region question still waits.
    expect(ctl().liveState(region)?.card).toBeTruthy();

    fake.pressButton(me, me, question.message_id, fake.buttons(me, question.message_id)[0]![0]!.callback_data!);
    const answered = await until(() => outcomes.find((o) => o.sessionId === region));
    expect(JSON.stringify(answered.data)).toContain("use eu-west, the one we used last time");
    await until(() => byId(question.message_id)?.text.includes("Sent as an answer to: ❓ deskproj · Pick a region"));
    expect(fake.buttons(me, question.message_id)).toEqual([]);
  });

  it("sends a reply straight to the one card the list showed the whole time", async () => {
    const assistant = `asst-${crypto.randomUUID()}`;
    setSessionAssistant(assistant);
    setSessionProvider(assistant, P);
    const t = targetChat("Pick a size");
    service.watch({ assistantSessionId: assistant, targetSessionId: t, targetProject: PROJECT, targetProvider: P, notifyOn: ["done"] });
    // A phone connected now: its list has shown nothing but this card.
    const other = me + 1;
    upsertApprovedPairing(String(other), String(other), "Second phone");
    await ctl().sendUserMessage(t, "ask:Which size?", { origin: "telegram", projectName: PROJECT, providerId: P });
    const pinned = () => fake.sent(other).find((m) => m.message_id === fake.pins(other).at(-1));
    await until(() => pinned()?.text.includes("Which size?"));
    const d = pinned()!;
    const before = fake.sent(other).length;
    fake.pushText(other, other, "large", "private", {
      reply_to_message: { message_id: d.message_id, date: Math.floor(Date.now() / 1000), chat: { id: other, type: "private" } },
    });
    const answered = await until(() => outcomes.find((o) => o.sessionId === t));
    expect(JSON.stringify(answered.data)).toContain("large");
    expect(fake.sent(other).slice(before).some((m) => m.text.startsWith("❓ Which card"))).toBe(false);
  });

  it("/cards brings the desk to the bottom of the chat", async () => {
    const target = targetChat("Release notes");
    await ctl().sendUserMessage(target, "approve:git push --tags", { origin: "telegram", projectName: PROJECT, providerId: P });
    await until(() => ctl().liveState(target)?.card);
    fake.pushText(me, me, "/status");
    await until(() => desk()?.text.includes("git push --tags"));
    const old = desk()!.message_id;
    fake.pushText(me, me, "/cards");
    await until(() => byId(old)?.text.includes("moved down"));
    await assistantTelegramBridge.settle();
    const pinned = fake.pins(me);
    expect(pinned.length).toBe(1);
    expect(pinned[0]).toBeGreaterThan(old);
    expect(byId(pinned[0]!)!.text).toContain("git push --tags");
    fake.pressButton(me, me, pinned[0]!, button(pinned[0]!, "Deny")!);
    await until(() => outcomes.some((o) => o.sessionId === target && !o.approved));
    expect(fake.commands.some((c) => c.command === "cards")).toBe(true);
  });
});
