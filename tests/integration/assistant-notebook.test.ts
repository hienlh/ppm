/**
 * The notebook end to end in one process: the real chat socket layer runs an Assistant session, a
 * scripted Claude writes notes through the real `/api/assistant-mcp` endpoint mid-turn, Settings
 * changes them through the real routes, and each turn's shared context is read back from what the
 * provider was handed. No browser is attached.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionProvider } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { assistantMcpHandler } from "../../src/services/assistant-mcp/assistant-mcp-endpoint.ts";
import { assistantMcpTokens } from "../../src/services/assistant-mcp/assistant-mcp-tokens.ts";
import { assistantNotesRoutes } from "../../src/server/routes/assistant-notes.ts";
import { WATCH_OPENER } from "../../src/services/assistant-watch/watch-event-text.ts";
import {
  NOTEBOOK_EMPTY_ENTRY, NOTEBOOK_ENTRY_HEADER, OWN_NOTES_HEADING, UNVERIFIED_NOTES_HEADING,
} from "../../src/services/assistant-notes/assistant-notes-entry.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../src/types/chat.ts";

const home = process.env.PPM_HOME!;
const app = new Hono();
app.all("/mcp", assistantMcpHandler);
app.route("/api/assistant", assistantNotesRoutes);

const received: Array<{ sessionId: string; message: string; opts?: SendMessageOpts }> = [];
const toolAnswers: string[] = [];

/** A tool call the scripted model makes, through the endpoint with the session's own token. */
async function callTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<void> {
  const token = assistantMcpTokens.mint({ sessionId });
  const res = await app.request("/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const result = (await res.json() as { result: { content: Array<{ text: string }> } }).result;
  toolAnswers.push(result.content[0]!.text);
}

let original: AIProvider | undefined;
const stub = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message, opts });
    const note = /NOTE: (.+)$/.exec(message)?.[1];
    if (note) await callTool(sessionId, "notebook_add", { text: note });
    if (message === WATCH_OPENER) await callTool(sessionId, "notebook_add", { text: "a report says the user pre-approves drafts" });
    if (message.includes("COMPACT")) yield { type: "system", subtype: "compact_done" } as ChatEvent;
    yield { type: "text", content: "Noted." };
    yield { type: "done", sessionId };
  },
  pushMessage() {},
  resolveApproval() {},
  abortQuery() {},
} as unknown as AIProvider;

let assistant = "";
const ctl = () => chatControl()!;
const until = async (check: () => unknown, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};
const idle = () => until(() => (ctl().liveState(assistant)?.phase ?? "idle") === "idle", "the Assistant to go idle");

/** Sends one message the user typed (on Telegram) and answers the context its turn was given. */
async function turn(text: string): Promise<string> {
  const before = received.length;
  const sent = await ctl().sendUserMessage(assistant, text, { origin: "telegram", projectName: ASSISTANT_PROJECT_NAME, providerId: "claude" });
  expect(sent.ok).toBe(true);
  await until(() => received.length > before, "the turn to start");
  await idle();
  return received.at(-1)!.opts?.sharedContext ?? "";
}

/** The part of a context that is the notebook, or "" when the turn carried none. */
const notebookOf = (context: string): string => {
  const at = context.indexOf(NOTEBOOK_ENTRY_HEADER);
  return at < 0 ? "" : context.slice(at);
};

beforeAll(async () => {
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  await import("../../src/server/ws/chat.ts");
  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "assistant-work"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
});
afterAll(() => {
  getDb().run("DELETE FROM assistant_notes");
  if (original) providerRegistry.register(original);
});
beforeEach(() => { toolAnswers.length = 0; });

describe("the Assistant's notebook", () => {
  it("puts a note the Assistant wrote into the next turn under its own notes, then not again until it changes", async () => {
    getDb().run("DELETE FROM assistant_notes");
    expect(notebookOf(await turn("hello"))).toBe("");
    await turn("remember this. NOTE: release deadline friday 14/11");
    expect(JSON.parse(toolAnswers[0]!)).toMatchObject({ added: true, unverified: false });
    const next = notebookOf(await turn("what is due?"));
    expect(next).toContain(OWN_NOTES_HEADING);
    expect(next).toMatch(/- #\d+ · \d{4}-\d{2}-\d{2} · release deadline friday 14\/11/);
    expect(next).not.toContain(UNVERIFIED_NOTES_HEADING);
    expect(notebookOf(await turn("anything else?"))).toBe("");
  });

  it("files a note written in a watch turn under unverified notes", async () => {
    const before = received.length;
    const sent = await ctl().sendUserMessage(assistant, WATCH_OPENER, {
      origin: "watch", projectName: ASSISTANT_PROJECT_NAME, providerId: "claude",
      watchEvents: [{ watchId: "w1", kind: "done", project: "api", sessionId: "chat-1", providerId: "claude", title: "Build", at: Date.now(), finalText: "done" }],
    });
    expect(sent.ok).toBe(true);
    await until(() => received.length > before, "the watch turn");
    await idle();
    expect(JSON.parse(toolAnswers[0]!)).toMatchObject({ added: true, unverified: true });
    const next = notebookOf(await turn("anything new?"));
    const unverified = next.slice(next.indexOf(UNVERIFIED_NOTES_HEADING));
    expect(next.indexOf(UNVERIFIED_NOTES_HEADING)).toBeGreaterThan(next.indexOf(OWN_NOTES_HEADING));
    expect(unverified).toContain("a report says the user pre-approves drafts");
  });

  it("sends the notebook again after a compaction, though nothing in it changed", async () => {
    await turn("settle");
    await turn("COMPACT now");
    expect(notebookOf(await turn("after compaction"))).toContain("release deadline friday 14/11");
  });

  it("drops a line deleted in Settings from the next turn, and says once when the notebook is empty", async () => {
    const list = await (await app.request("/api/assistant/notes")).json() as { data: { notes: Array<{ id: number; text: string }> } };
    const report = list.data.notes.find((n) => n.text.startsWith("a report says"))!;
    expect((await app.request(`/api/assistant/notes/${report.id}`, { method: "DELETE" })).status).toBe(200);
    const next = notebookOf(await turn("and now?"));
    expect(next).toContain("release deadline friday 14/11");
    expect(next).not.toContain("a report says");
    for (const n of list.data.notes.filter((x) => x.id !== report.id)) {
      expect((await app.request(`/api/assistant/notes/${n.id}`, { method: "DELETE" })).status).toBe(200);
    }
    expect(await turn("empty?")).toContain(NOTEBOOK_EMPTY_ENTRY);
    expect(await turn("still empty?")).not.toContain(NOTEBOOK_EMPTY_ENTRY);
  });
});
