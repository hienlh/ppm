/**
 * An open PPM Assistant chat keeps the Edit/Write tools and the instructions it was started with,
 * so switching Full/Ask (or "act on its own") restarts its subprocess at the first idle moment —
 * the same restart an extension binding change uses. A save that changes nothing a subprocess
 * fixes at start (the database list, the persona) restarts nothing, and an ordinary chat is never
 * touched.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { configService } from "../../../src/services/config.service.ts";
import { setSessionAssistant } from "../../../src/services/db.service.ts";
import { saveAssistantSettings, startupPermissionsChanged } from "../../../src/services/assistant/assistant-settings.service.ts";
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from "../../../src/shared/assistant-settings.ts";
import { chatWebSocket, getSessionTurnState } from "../../../src/server/ws/chat.ts";
import { QueuedTurnsProvider, until } from "../../helpers/queued-turns-provider.ts";

const provider = new QueuedTurnsProvider("assistant-mode-restart");
(provider as { supportsAssistantSessions?: boolean }).supportsAssistantSessions = true;
beforeAll(() => providerRegistry.register(provider));

const sockets: any[] = [];
let savedAssistant: unknown;
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
  if (savedAssistant !== undefined) configService.set("assistant", savedAssistant as never);
  savedAssistant = undefined;
});

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId, providerHint: provider.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  return {
    say: (content: string) => chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content })),
    done: () => messages.filter((m) => m.type === "done").length,
  };
}

async function liveChat(assistant: boolean) {
  savedAssistant = configService.get("assistant");
  const session = await chatService.createSession(provider.id, {});
  if (assistant) setSessionAssistant(session.id);
  const tab = connect(session.id);
  await tab.say("one");
  await until(() => tab.done() === 1 && !getSessionTurnState(session.id).running, "the first turn");
  expect(provider.hasStreamingSession(session.id)).toBe(true);
  return { id: session.id, tab };
}

const restarts = (sessionId: string) => provider.abortReasons.filter((a) => a.sessionId === sessionId && a.reason === "assistant_permissions").length;
const save = (patch: Record<string, unknown>) => expect(saveAssistantSettings(patch, () => true).ok).toBe(true);

describe("startupPermissionsChanged", () => {
  const s = (patch: Partial<AssistantSettings>): AssistantSettings => ({ ...structuredClone(DEFAULT_ASSISTANT_SETTINGS), ...patch });
  it("is true only when Edit/Write or the mode section would change", () => {
    expect(startupPermissionsChanged(s({}), s({ permission_mode: "full" }))).toBe(true);
    expect(startupPermissionsChanged(s({ permission_mode: "full" }), s({ permission_mode: "ask" }))).toBe(true);
    expect(startupPermissionsChanged(s({}), s({ act_on_own: true }))).toBe(true);
    // Ask chosen explicitly after "not chosen yet" behaves the same.
    expect(startupPermissionsChanged(s({}), s({ permission_mode: "ask" }))).toBe(false);
    expect(startupPermissionsChanged(s({ permission_mode: "full" }), s({ permission_mode: "full", db_write_connections: [3] }))).toBe(false);
  });
});

describe("a mode change and an open Assistant chat", () => {
  it("restarts an idle Assistant subprocess at once", async () => {
    const { id } = await liveChat(true);
    save({ permission_mode: "full" });
    expect(restarts(id)).toBe(1);
    await until(() => !provider.hasStreamingSession(id), "the old subprocess to go");
  });

  it("waits for a running turn to end, then restarts", async () => {
    const { id, tab } = await liveChat(true);
    await tab.say("hold:two");
    await until(() => getSessionTurnState(id).running, "the turn to run");
    save({ permission_mode: "full" });
    expect(restarts(id)).toBe(0);
    provider.release(id);
    await until(() => restarts(id) === 1, "the restart once the turn ended");
  });

  it("does not restart for a save that changes nothing fixed at start", async () => {
    const { id } = await liveChat(true);
    save({ db_write_connections: [4] });
    expect(restarts(id)).toBe(0);
  });

  it("never restarts an ordinary chat", async () => {
    const { id } = await liveChat(false);
    save({ permission_mode: "full" });
    expect(restarts(id)).toBe(0);
  });
});
