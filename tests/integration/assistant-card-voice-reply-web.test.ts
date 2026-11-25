/**
 * A voice reply to one of the PPM Assistant's cards from PPM's own screen, end to end over the real
 * routes: the recording goes up through `POST /chat/upload` (the composer's upload route), which
 * hands back a receipt; the reply then goes to `POST /api/assistant/cards/:id/reply` naming the
 * recording and that receipt, and the real card actions, `forward-verbatim.ts` and the chat socket
 * layer deliver the transcript to a scripted manager chat as a voice message inside the user-words
 * block. The Assistant gets nothing.
 *
 * The REST route may not simply claim a reply was spoken: no receipt, a receipt for another file or
 * a forged one is refused, and nothing reaches any chat. A decided or withdrawn card treats a spoken
 * reply as it treats typed words.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { setSessionAssistant, setSessionMetadata, setSessionProvider, setSessionTitle, getDb } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { clearMainSessionIf, setMainSession } from "../../src/services/assistant/assistant-main-session.ts";
import { setAssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { startAssistantCards, stopAssistantCards } from "../../src/services/assistant-cards/assistant-cards-startup.ts";
import { assistantCards } from "../../src/services/assistant-cards/assistant-cards.service.ts";
import { assistantCardRoutes } from "../../src/server/routes/assistant-cards.ts";
import { chatRoutes } from "../../src/server/routes/chat.ts";
import { decodeMessageBlocks } from "../../src/shared/chat-message-blocks.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { splitVoiceMessage, VOICE_NOTE } from "../../src/shared/voice-message.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

/** A real Ogg Opus voice note: 4.4 s of synthesized speech (not a person's voice). */
const OGG = new Uint8Array(readFileSync(join(import.meta.dir, "../fixtures/voice/card-reply-synth.ogg")));
const TRANSCRIPT = "Go ahead with option two, but run the smoke tests first.";

const received: Array<{ sessionId: string; message: string }> = [];
let original: AIProvider | undefined;
let manager = "";
let assistant = "";
const stub = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message });
    if (opts?.clientMessageId) yield { type: "turn_started", turnId: crypto.randomUUID(), clientMessageId: opts.clientMessageId };
    yield { type: "text", content: "Noted." };
    yield { type: "done", sessionId };
  },
  hasStreamingSession() { return false; },
  pushMessage() { return false; },
  resolveApproval() {},
  abortQuery() {},
} as unknown as AIProvider;

const home = process.env.PPM_HOME!;
const projectPath = join(home, "voice-web-proj");
const app = new Hono();
app.route("/chat", chatRoutes);
app.route("/api/assistant", assistantCardRoutes);
let projectsBefore: PpmConfig["projects"] = [];
let assistantBefore: unknown;
const clock = Date.UTC(2026, 10, 15, 2, 0, 0);
let notifySpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  getDb().run("DELETE FROM assistant_cards");
  mkdirSync(projectPath, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  const saved = configService.get("assistant");
  assistantBefore = saved === undefined ? undefined : structuredClone(saved);
  configService.set("assistant", { ...(saved as object ?? {}), quiet_hours: { enabled: false, start: "22:00", end: "07:00" }, timezone: "Asia/Saigon" } as never);
  setAssistantClock({ now: () => clock, setTimer: () => () => {} });
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "voiceweb", path: projectPath }]);
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notifySpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});
  manager = `c-${crypto.randomUUID()}`;
  setSessionMetadata(manager, "voiceweb", projectPath);
  setSessionProvider(manager, "claude");
  setSessionTitle(manager, "Manager");
  await managerChats.assign("voiceweb", manager, "user");
  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "assistant-work"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
  setMainSession(assistant);
  startAssistantCards();
});

afterAll(() => {
  stopAssistantCards();
  assistantWakeQueue.stop();
  clearMainSessionIf(assistant);
  configService.set("assistant", (assistantBefore ?? {}) as never);
  managerChats.unassign("voiceweb");
  configService.set("projects", projectsBefore);
  setAssistantClock(null);
  notifySpy?.mockRestore();
  if (original) providerRegistry.register(original);
});

const ctl = () => chatControl()!;
async function until<T>(check: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const idle = (id: string) => until(() => (ctl().liveState(id)?.phase ?? "idle") === "idle");
const to = (sessionId: string, from: number) => received.slice(from).filter((r) => r.sessionId === sessionId);

function newCard(title: string): string {
  return assistantCards.create({
    kind: "needs_decision", projectName: "voiceweb", projectPath, sessionId: manager, title, body: "Needs your decision.",
  }).id;
}

/** The composer's upload of a recording, as the browser sends it. */
async function upload(name = "voice-20261125T150000.ogg", type = "audio/ogg") {
  const form = new FormData();
  form.append("files", new File([OGG], name, { type }));
  const res = await app.request("/chat/upload", { method: "POST", body: form });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Array<{ path: string; voiceReceipt?: string }> }).data[0]!;
}

const reply = (cardId: string, body: Record<string, unknown>) =>
  app.request(`/api/assistant/cards/${cardId}/reply`, {
    method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
  });

describe("a voice reply to a card from PPM's screen", () => {
  it("reaches the card's manager chat as a voice message in the user-words block; the Assistant gets nothing", async () => {
    const cardId = newCard("Ship option one or two for NX-7001?");
    const rec = await upload();
    expect(typeof rec.voiceReceipt).toBe("string");
    const from = received.length;
    const res = await reply(cardId, { text: TRANSCRIPT, voice: { path: rec.path, durationSec: 4.4, receipt: rec.voiceReceipt } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { to: string } }).data.to).toBe("manager");
    await until(() => to(manager, from).length > 0);
    await idle(manager);

    const toManager = to(manager, from);
    expect(toManager).toHaveLength(1);
    const blocks = decodeMessageBlocks(toManager[0]!.message);
    expect(blocks.userWords).toMatchObject({ cardId, channel: "ppm" });
    const { before, voice } = splitVoiceMessage(blocks.content);
    expect(before).toBe("");
    // The marker keeps whole seconds.
    expect(voice).toEqual({ path: rec.path, durationSec: 4, transcript: TRANSCRIPT });
    expect(blocks.content).toContain(VOICE_NOTE);
    // The audio the chat plays is the recording the browser uploaded.
    expect(Buffer.from(readFileSync(voice!.path)).equals(Buffer.from(OGG))).toBe(true);
    expect(to(assistant, from).filter((r) => r.message.includes(TRANSCRIPT))).toHaveLength(0);
    expect(assistantCards.get(cardId)!.status).toBe("answered");
  });

  it("is refused with no receipt, a receipt for another recording, or a forged one; nothing reaches a chat", async () => {
    const cardId = newCard("Rename the NX-7002 flag?");
    const rec = await upload();
    const other = await upload("voice-20261125T150500.ogg");
    const from = received.length;
    for (const voice of [
      { path: rec.path, durationSec: 4.4 },
      { path: rec.path, durationSec: 4.4, receipt: other.voiceReceipt },
      { path: rec.path, durationSec: 4.4, receipt: `${Date.now()}.${"A".repeat(43)}` },
      // A file in the uploads folder that no upload handed a receipt for in this run.
      { path: join(home, "uploads", "deadbeef-voice-old.ogg"), durationSec: 4.4, receipt: rec.voiceReceipt },
    ]) {
      const res = await reply(cardId, { text: TRANSCRIPT, voice });
      expect(res.status).toBe(400);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(to(manager, from)).toHaveLength(0);
    expect(to(assistant, from)).toHaveLength(0);
    expect(assistantCards.get(cardId)!.status).toBe("open");
  });

  it("gives no receipt for a file that is no recording", async () => {
    const res = await app.request("/chat/upload", { method: "POST", body: (() => {
      const form = new FormData();
      form.append("files", new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" }));
      return form;
    })() });
    const first = ((await res.json()) as { data: Array<{ voiceReceipt?: string }> }).data[0]!;
    expect(first.voiceReceipt).toBeUndefined();
  });

  it("gives one for Chrome's own recording, a .webm that Bun types as video", async () => {
    const rec = await upload("voice-20261125T151000.webm", "audio/webm;codecs=opus");
    expect(typeof rec.voiceReceipt).toBe("string");
  });

  it("is refused by a card already decided, and asks first on a withdrawn card, exactly as typed words are", async () => {
    const decided = newCard("Pick the NX-7003 date");
    expect(assistantCards.transition(decided, "answered", { by: "user", channel: "telegram", at: clock, ok: true }).ok).toBe(true);
    const rec = await upload();
    const from = received.length;
    const voice = { path: rec.path, durationSec: 4.4, receipt: rec.voiceReceipt };
    const refused = await reply(decided, { text: TRANSCRIPT, voice, confirmAge: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("already_answered");

    const withdrawn = newCard("Retry NX-7004 deploy?");
    expect(assistantCards.transition(withdrawn, "dismissed", {
      by: "manager", channel: "chat", at: clock, withdrawn: { sessionId: manager, reason: "Settled elsewhere" },
    }).ok).toBe(true);
    const asked = await reply(withdrawn, { text: TRANSCRIPT, voice });
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { error: string }).error).toBe("confirm");
    expect(to(manager, from)).toHaveLength(0);

    const anyway = await reply(withdrawn, { text: TRANSCRIPT, voice, force: true });
    expect(anyway.status).toBe(200);
    await until(() => to(manager, from).length > 0);
    await idle(manager);
    const blocks = decodeMessageBlocks(to(manager, from)[0]!.message);
    expect(blocks.userWords?.cardId).toBe(withdrawn);
    expect(splitVoiceMessage(blocks.content).voice?.transcript).toBe(TRANSCRIPT);
    expect(to(assistant, from).filter((r) => r.message.includes(TRANSCRIPT))).toHaveLength(0);
  });
});
