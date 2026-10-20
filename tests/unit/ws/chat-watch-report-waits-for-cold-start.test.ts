/**
 * A watch report goes into a chat only while it is quiet. A user's first message to a cold
 * session (after a restart) spends a while resuming the provider's session with the phase still
 * idle; a watch report arriving then must be refused as busy, not take the user's turn over —
 * which would mark the turn as a watch turn, refuse the user's approvals and start a second turn.
 */
import { afterEach, expect, it } from "bun:test";
import "../../test-setup.ts";
import "../../../src/server/ws/chat.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { CHAT_BUSY, chatControl, type ChatControl } from "../../../src/services/chat-control/chat-control.ts";
import { setSessionAssistant, setSessionProvider } from "../../../src/services/db.service.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../src/shared/assistant-project.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); };

const ctl = (): ChatControl => {
  const c = chatControl();
  if (!c) throw new Error("the chat socket layer registered no chat control");
  return c;
};

const SLOW = "stub-slow-resume";
const RESUME_MS = 40;

/** A provider whose resume reads for a while (as Claude's cold resume reads transcripts) and whose turns wait to be released. */
function slowResumeProvider() {
  const turns: string[] = [];
  let release!: () => void;
  let gate = new Promise<void>((resolve) => { release = resolve; });
  providerRegistry.register({
    id: SLOW, name: SLOW, supportsAssistantSessions: true, supportsSharedContext: true,
    async createSession() { return { id: "unused", providerId: SLOW, title: "", createdAt: "" }; },
    async resumeSession(id: string) {
      await Bun.sleep(RESUME_MS);
      return { id, providerId: SLOW, title: "", createdAt: "" };
    },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage(sessionId: string, content: string) {
      turns.push(content);
      yield { type: "text", content: "working" };
      await gate;
      yield { type: "done", sessionId };
    },
    pushMessage() {},
  } as AIProvider);
  const open = () => { release(); };
  cleanups.push(open);
  return { turns, release: () => { open(); gate = new Promise<void>((resolve) => { release = resolve; }); } };
}

it("refuses a watch report as busy while the user's first message is still resuming the session", async () => {
  const provider = slowResumeProvider();
  const id = `cold-${crypto.randomUUID()}`;
  setSessionAssistant(id);
  setSessionProvider(id, SLOW);
  const user = { origin: "telegram", channel: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: SLOW } as const;
  const report = { origin: "watch", projectName: ASSISTANT_PROJECT_NAME, providerId: SLOW } as const;

  const first = ctl().sendUserMessage(id, "run the tests", user);
  // Inside the resume: the chat is still idle, and the user's message has not started its turn yet.
  await Bun.sleep(RESUME_MS / 4);
  expect(ctl().liveState(id)?.phase).toBe("idle");
  expect(await ctl().sendUserMessage(id, "<ppm-event>chat X finished</ppm-event>", report)).toEqual({ ok: false, error: CHAT_BUSY });

  expect(await first).toEqual({ ok: true, sessionId: id });
  await until(() => provider.turns.length > 0);
  // The turn is the user's: one turn, started from their message, not a watch turn.
  expect(ctl().liveState(id)?.turnOrigin).toBe("telegram");
  await Bun.sleep(20);
  expect(provider.turns).toHaveLength(1);
  expect(provider.turns[0]).toContain("run the tests");

  // Once the chat is quiet again, the report goes in.
  provider.release();
  await until(() => ctl().liveState(id)?.phase === "idle");
  expect((await ctl().sendUserMessage(id, "<ppm-event>chat X finished</ppm-event>", report)).ok).toBe(true);
  provider.release();
});
