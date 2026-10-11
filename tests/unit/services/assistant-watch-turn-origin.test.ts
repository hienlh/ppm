/**
 * A turn PPM starts to report on a watched chat belongs to nobody: the Assistant's endpoint asks
 * the user nothing in it, its news rides in the shared context rather than in the message, and
 * the channel entries keep telling the model where the user is. Also here: a secret answer is
 * never written to the session trace.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService, BACK_ON_PPM_CONTEXT_ENTRY, TELEGRAM_CHANNEL_CONTEXT_ENTRY } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { getDb, setSessionAssistant } from "../../../src/services/db.service.ts";
import { approvalAskerFor, createApprovalBroker } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { WATCH_TURN_REFUSAL } from "../../../src/services/chat-control/chat-control.ts";
import { WATCH_ENTRY_HEADING } from "../../../src/services/assistant-watch/watch-event-text.ts";
import { HIDDEN_ANSWER, toProviderAnswers, withSecretAnswersHidden, type NormalizedQuestion } from "../../../src/shared/approval-questions.ts";
import { traceWriter } from "../../../src/services/session-trace/trace-writer.ts";
import { readEvents } from "../../../src/services/session-trace/session-trace-store.ts";
import type { AIProvider, SendMessageOpts, WatchEventNotice } from "../../../src/types/chat.ts";

const P = "stub-watch-origin";
const resolved: Array<[string, boolean, unknown]> = [];
providerRegistry.register({
  id: P, name: P, supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: "x", providerId: P, title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(_s: string, _m: string, _o?: SendMessageOpts) {},
  resolveApproval(requestId: string, approved: boolean, data?: unknown) { resolved.push([requestId, approved, data]); },
} as AIProvider);

const event: WatchEventNotice = {
  watchId: "w1", kind: "done", project: "api", sessionId: "target-1", providerId: "claude", title: "Build", at: 0, finalText: "Built.",
};

describe("approvals in a watch turn", () => {
  it("are refused without a card, naming why", async () => {
    let delivered = 0;
    const broker = createApprovalBroker({ deliver: () => { delivered++; return 1; } });
    const ask = approvalAskerFor("asst", undefined, broker, () => true);
    const verdict = await ask({ tool: "db_query", input: {}, summary: { title: "x" } as never });
    expect(verdict).toEqual({ verdict: "unavailable", reason: WATCH_TURN_REFUSAL });
    expect(delivered).toBe(0);
  });

  it("are asked as usual once the turn is the user's", async () => {
    let delivered = 0;
    const broker = createApprovalBroker({ deliver: () => { delivered++; return 0; } });
    const verdict = await approvalAskerFor("asst", undefined, broker, () => false)({ tool: "db_query", input: {}, summary: { title: "x" } as never });
    expect(verdict.verdict).toBe("unavailable");
    expect(delivered).toBe(1);
  });
});

describe("the shared context of an Assistant session's turns", () => {
  beforeEach(() => { getDb().run("DELETE FROM session_metadata"); });

  it("carries watch news on every watch turn, never compared with the last one", async () => {
    setSessionAssistant("asst-a");
    for (let i = 0; i < 2; i++) {
      const opts = await chatService.prepareSendOptions(P, "asst-a", "[PPM] news", { watchEvents: [event] });
      expect(opts.sharedContext).toContain(WATCH_ENTRY_HEADING);
      expect(opts.sharedContext).toContain('"Built."');
      expect(opts).not.toHaveProperty("watchEvents");
    }
  });

  it("ignores watch news for a session that is not an Assistant session", async () => {
    const opts = await chatService.prepareSendOptions(P, "plain-chat", "hi", { watchEvents: [event] });
    expect(opts.sharedContext ?? "").not.toContain(WATCH_ENTRY_HEADING);
    expect(opts).not.toHaveProperty("watchEvents");
  });

  it("says Telegram on every Telegram message, and once that the screen is back", async () => {
    setSessionAssistant("asst-b");
    const fromPhone = () => chatService.prepareSendOptions(P, "asst-b", "hi", { channel: "telegram" });
    const fromPpm = () => chatService.prepareSendOptions(P, "asst-b", "hi", {});
    expect((await fromPpm()).sharedContext ?? "").not.toContain(BACK_ON_PPM_CONTEXT_ENTRY);
    expect((await fromPhone()).sharedContext).toContain(TELEGRAM_CHANNEL_CONTEXT_ENTRY);
    expect((await fromPhone()).sharedContext).toContain(TELEGRAM_CHANNEL_CONTEXT_ENTRY);
    // A watch turn in between does not move the user.
    expect((await chatService.prepareSendOptions(P, "asst-b", "news", { watchEvents: [event] })).sharedContext ?? "").not.toContain(BACK_ON_PPM_CONTEXT_ENTRY);
    expect((await fromPpm()).sharedContext).toContain(BACK_ON_PPM_CONTEXT_ENTRY);
    expect((await fromPpm()).sharedContext ?? "").not.toContain(BACK_ON_PPM_CONTEXT_ENTRY);
  });
});

describe("a secret answer and the session trace", () => {
  const questions: NormalizedQuestion[] = [
    { id: "token", question: "API token?", options: [], multiSelect: false, allowsFreeText: true, secret: true },
    { id: "env", question: "Which env?", options: [{ label: "prod" }, { label: "dev" }], multiSelect: false, allowsFreeText: false },
  ];
  afterEach(() => { resolved.length = 0; });

  it("keeps that a secret question was answered, never the answer", () => {
    const byId = { token: ["sk-live-123"], env: ["dev"] };
    expect(withSecretAnswersHidden(questions, byId)).toEqual({ token: [HIDDEN_ANSWER], env: ["dev"] });
    expect(withSecretAnswersHidden(questions, { env: ["dev"] })).toEqual({ env: ["dev"] });
    expect(byId.token).toEqual(["sk-live-123"]);
  });

  it("gives the provider the answer and the trace only its hidden form", () => {
    const sessionId = crypto.randomUUID();
    const byId = { token: ["sk-live-123"], env: ["dev"] };
    chatService.resolveApproval(P, sessionId, "req-1", true, toProviderAnswers("codex", questions, byId), {
      origin: "telegram", traceData: toProviderAnswers("codex", questions, withSecretAnswersHidden(questions, byId)),
    });
    traceWriter.flush();
    expect(resolved).toEqual([["req-1", true, { token: ["sk-live-123"], env: ["dev"] }]]);
    const rows = readEvents(sessionId);
    expect(rows.map((r) => r.type)).toEqual(["approval_resolved"]);
    expect(rows[0]!.payload).toEqual({ type: "approval_resolved", requestId: "req-1", approved: true, data: { token: [HIDDEN_ANSWER], env: ["dev"] } });
    expect(JSON.stringify(rows)).not.toContain("sk-live-123");
  });
});
