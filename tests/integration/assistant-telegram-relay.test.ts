/**
 * The hub end to end on Telegram: a fake Bot API plays the phones, the real chat socket layer
 * runs a watched chat and the Assistant session, the real watch service follows it, and the
 * bridge relays — a watched chat's card answered from the phone, a report reaching the phones of
 * an Assistant session no chat is bound to, `/status`, and a chat revoked from Settings.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionProvider, setSessionTitle, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { setTelegramBinding } from "../../src/services/assistant-hub/assistant-hub-db.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { AssistantWatchService } from "../../src/services/assistant-watch/assistant-watch.service.ts";
import { WATCH_OPENER } from "../../src/services/assistant-watch/watch-event-text.ts";
import { assistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { BRIDGE_STATE_ROW } from "../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { redactForTelegram } from "../../src/services/telegram/telegram-html-format.ts";
import { settingsRoutes } from "../../src/server/routes/settings.ts";
import { startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";
import type { NotificationPayload } from "../../src/services/notification.service.ts";
import type { AIProvider, ChatEvent } from "../../src/types/chat.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

// ── A scripted provider for the watched chats and the Assistant ───────────────
const P = "stub-telegram-relay";
const answers = new Map<string, (r: { approved: boolean }) => void>();
const outcomes: Array<{ sessionId: string; approved: boolean }> = [];

providerRegistry.register({
  id: P, name: "Relay stub", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: P, title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    if (message === WATCH_OPENER) {
      yield { type: "text", content: "Your deploy chat finished: all green." };
    } else if (message.startsWith("approve:")) {
      const requestId = crypto.randomUUID();
      const answer = new Promise<{ approved: boolean }>((resolve) => answers.set(requestId, resolve));
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: message.slice(8) } };
      const r = await answer;
      outcomes.push({ sessionId, approved: r.approved });
      yield { type: "text", content: r.approved ? "Deployed." : "Not deployed." };
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

// ── Fixtures ──────────────────────────────────────────────────────────────────
const PROJECT = "relayproj";
let root: string;
let savedProjects: unknown;
const savedClawbot = configService.get("clawbot");
const pushed: NotificationPayload[] = [];
let service: AssistantWatchService;
let notificationSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  // The fake bot shares its token with other test files: start from its first update, not
  // from the offset another file's bridge reached.
  getDb().query("DELETE FROM config WHERE key = ?").run(BRIDGE_STATE_ROW);
  root = mkdtempSync(join(tmpdir(), "ppm-telegram-relay-"));
  mkdirSync(join(root, PROJECT), { recursive: true });
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: PROJECT, path: join(root, PROJECT) }]);
  configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 30 });
  getDb().query("DELETE FROM clawbot_paired_chats").run();
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notificationSpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});
  service = new AssistantWatchService({ notify: (p) => pushed.push(p), retryDelayMs: 0, tickMs: 3_600_000 });
  service.start();
  await assistantTelegramBridge.start({
    token: fake.token,
    client: { editIntervalMs: 0, sleep: async () => {} },
    debounceMs: 30, pollTimeoutS: 1, scaleDelay: (ms) => ms / 1000,
    sessionLink: async (provider, id) => `http://localhost:8080/assistant?session=${provider}/${id}`,
    chatLink: async (project, provider, id) => `http://localhost:8080/project/${project}?openChat=${provider}/${id}`,
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
const until = (check: () => unknown, ms = 5000) => fake.waitFor(() => check(), ms);
const texts = (chat: number) => fake.sent(chat).map((m) => m.text);
const lastWith = (chat: number, part: string) => fake.sent(chat).findLast((m) => m.text.includes(part));
const button = (chat: number, messageId: number, text: string) =>
  fake.buttons(chat, messageId).flat().find((b) => b.text === text)?.callback_data;

let nextChat = 8_400_000;
function phone(): number {
  const id = nextChat++;
  upsertApprovedPairing(String(id), String(id), `Phone ${id}`);
  return id;
}
function assistantSession(): string {
  const id = `asst-${crypto.randomUUID()}`;
  setSessionAssistant(id);
  setSessionProvider(id, P);
  return id;
}
function targetChat(title: string): string {
  const id = `chat-${crypto.randomUUID()}`;
  setSessionProvider(id, P);
  setSessionTitle(id, title);
  return id;
}
const sendTo = (sessionId: string, text: string) =>
  ctl().sendUserMessage(sessionId, text, { origin: "telegram", projectName: PROJECT, providerId: P });
const idle = (sessionId: string) => until(() => ctl().liveState(sessionId)?.phase === "idle");
const watch = (assistant: string, target: string) =>
  service.watch({ assistantSessionId: assistant, targetSessionId: target, targetProject: PROJECT, targetProvider: P, notifyOn: ["done", "stopped"] });

describe("a watched chat, followed from Telegram", () => {
  it("reaches every connected phone when no chat is bound, is answered from one, and reports to all", async () => {
    const [one, two] = [phone(), phone()];
    const assistant = assistantSession();
    const target = targetChat("Deploy prod");
    expect(watch(assistant, target).ok).toBe(true);
    await sendTo(target, "approve:make deploy");

    const card = await until(() => lastWith(one, "make deploy"));
    await until(() => lastWith(two, "make deploy"));
    expect(card.text).toContain(`Chat “Deploy prod” in ${PROJECT} needs your decision`);
    expect(card.text).toContain(`openChat=${P}/${target}`);
    fake.pressButton(one, one, card.message_id, button(one, card.message_id, "Allow")!);
    await until(() => outcomes.some((o) => o.sessionId === target && o.approved));
    await idle(target);
    await until(() => fake.sent(one).find((m) => m.message_id === card.message_id)?.text.includes("Allowed"));
    expect(fake.buttons(one, card.message_id)).toEqual([]);
    // The other phone's copy loses its buttons too: the card is answered.
    const other = lastWith(two, "make deploy")!;
    await until(() => fake.buttons(two, other.message_id).length === 0);

    // The watch reports, and both phones hear it, named.
    await until(() => texts(one).some((t) => t.startsWith("🔔 Deploy prod")) && texts(two).some((t) => t.startsWith("🔔 Deploy prod")));
    const report = texts(one).find((t) => t.startsWith("🔔"))!;
    expect(report).toContain(`in ${PROJECT} finished.`);
    expect(report).toContain("Your deploy chat finished: all green.");
    for (const t of [...texts(one), ...texts(two)]) expect(redactForTelegram(t)).toBe(t);
  });

  it("goes only to the bound phone, and the card says so when PPM answers first", async () => {
    const [bound, other] = [phone(), phone()];
    const assistant = assistantSession();
    setTelegramBinding(String(bound), assistant, P);
    const target = targetChat("Migrate db");
    watch(assistant, target);
    await sendTo(target, "approve:db migrate");
    const card = await until(() => lastWith(bound, "db migrate"));
    const requestId = ctl().liveState(target)!.card!.requestId;
    expect(ctl().answerApproval(target, requestId, { approved: false }, "ws")).toBe("answered");
    await until(() => fake.sent(bound).find((m) => m.message_id === card.message_id)?.text.includes("Denied in PPM."));
    expect(fake.buttons(bound, card.message_id)).toEqual([]);
    await idle(target);
    await assistantTelegramBridge.settle();
    expect(texts(other).filter((t) => t.includes("db migrate"))).toEqual([]);
  });
});

describe("/status", () => {
  it("lists a waiting chat and sends its card, which answers that chat", async () => {
    const me = phone();
    const target = targetChat("Release notes");
    await sendTo(target, "approve:git push --tags");
    await until(() => ctl().liveState(target)?.card);
    fake.pushText(me, me, "/status");
    const list = await until(() => lastWith(me, "Your chats today"));
    expect(list.text).toContain("Release notes · relayproj — waiting for your decision");
    const card = await until(() => lastWith(me, "git push --tags"));
    expect(card.text).toContain("Chat “Release notes” in relayproj needs your decision");
    fake.pressButton(me, me, card.message_id, button(me, card.message_id, "Deny")!);
    await until(() => outcomes.some((o) => o.sessionId === target && !o.approved));
    await idle(target);
  });
});

describe("revoking a chat in Settings", () => {
  it("leaves it out of everything the watch sends afterwards", async () => {
    const app = new Hono().route("/api/settings", settingsRoutes);
    const [kept, revoked] = [phone(), phone()];
    const assistant = assistantSession();
    setTelegramBinding(String(revoked), assistant, P);
    const res = await app.request(`http://localhost/api/settings/clawbot/paired/${revoked}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const before = fake.calls.filter((c) => Number(c.body.chat_id) === revoked).length;

    const target = targetChat("Nightly");
    watch(assistant, target);
    await sendTo(target, "approve:make nightly");
    // Unbound now: the remaining phone gets the card, the revoked one nothing.
    const card = await until(() => lastWith(kept, "make nightly"));
    fake.pressButton(kept, kept, card.message_id, button(kept, card.message_id, "Allow")!);
    await idle(target);
    await until(() => texts(kept).some((t) => t.startsWith("🔔 Nightly")));
    await assistantTelegramBridge.settle();
    expect(fake.calls.filter((c) => Number(c.body.chat_id) === revoked).length).toBe(before);
  });
});
