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
const answers = new Map<string, (r: { approved: boolean }) => void>();
const outcomes: Array<{ sessionId: string; approved: boolean }> = [];

providerRegistry.register({
  id: P, name: "Desk stub", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: P, title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    if (message.startsWith("approve:")) {
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
  resolveApproval(requestId: string, approved: boolean) {
    answers.get(requestId)?.({ approved });
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
    desk: { store: memoryCardDeskStore() },
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

  it("refuses a reply to the desk written right after it moved to a card by itself", async () => {
    const assistant = `asst-${crypto.randomUUID()}`;
    setSessionAssistant(assistant);
    setSessionProvider(assistant, P);
    const target = targetChat("Rotate keys");
    service.watch({ assistantSessionId: assistant, targetSessionId: target, targetProject: PROJECT, targetProvider: P, notifyOn: ["done"] });
    await ctl().sendUserMessage(target, "approve:rotate-keys.sh", { origin: "telegram", projectName: PROJECT, providerId: P });
    await until(() => desk()?.text.includes("rotate-keys.sh"));
    const d = desk()!;
    const before = fake.sent(me).length;
    fake.pushText(me, me, "yes do it", "private", { reply_to_message: { message_id: d.message_id, date: Math.floor(Date.now() / 1000), chat: { id: me, type: "private" } } });
    await until(() => fake.sent(me).slice(before).find((m) => m.text.startsWith("Not sent: the pinned list changed")));
    // Nothing reached the chat the card belongs to: its card still waits.
    expect(ctl().liveState(target)?.card).toBeTruthy();
    fake.pressButton(me, me, d.message_id, button(d.message_id, "Deny")!);
    await until(() => outcomes.some((o) => o.sessionId === target && !o.approved));
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
