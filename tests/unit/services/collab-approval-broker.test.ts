import { describe, expect, it } from "bun:test";
import { createCollabApprovalBroker, type CollabApprovalChat } from "../../../src/services/session-collab/collab-approval-broker.ts";
import type { SessionCollabApprovalInput, SessionCollabApprovalRequest } from "../../../src/shared/session-collab.ts";

const createInput: SessionCollabApprovalInput = { kind: "create", title: "Docs", providerId: "claude", model: null, task: "Write docs", depth: 1 };
const pairInput: SessionCollabApprovalInput = { kind: "pair_limit", targetSessionId: "target-session", targetTitle: "T", sent: 20, limit: 20, grant: 20 };

function setup(opts: { shown?: boolean } = {}) {
  const announced: SessionCollabApprovalRequest[] = [];
  const resolved: Array<{ requestId: string; answer: string | null }> = [];
  const chat: CollabApprovalChat = {
    announce: (_s, event) => { announced.push(event); return opts.shown ?? true; },
    resolved: (_s, requestId, answer) => { resolved.push({ requestId, answer }); },
  };
  const broker = createCollabApprovalBroker({ chat: () => chat, canonical: (id) => id.replace(/^old-/, "") });
  return { broker, announced, resolved };
}

describe("session tools' approval cards", () => {
  it("shows the card in the asking session and returns the user's answer", async () => {
    const { broker, announced, resolved } = setup();
    const pending = broker.request("caller-session", createInput);
    const requestId = announced[0]!.requestId;
    expect(announced[0]!.tool).toBe("ppm:session_collab");
    expect(broker.pendingEvent("old-caller-session")?.requestId).toBe(requestId);
    expect(broker.answer(requestId, { answer: "allow_session" })).toEqual({ ok: true, answer: "allow_session" });
    expect(await pending).toEqual({ allowed: true, answer: "allow_session" });
    expect(resolved).toEqual([{ requestId, answer: "allow_session" }]);
    expect(broker.has(requestId)).toBe(false);
  });

  it("refuses an answer the card does not offer, and leaves it waiting", async () => {
    const { broker, announced } = setup();
    const pending = broker.request("caller-session", pairInput);
    const requestId = announced[0]!.requestId;
    expect(broker.answer(requestId, { answer: "allow_session" })).toMatchObject({ ok: false, status: 400 });
    expect(broker.answer(requestId, { answer: "yes" })).toMatchObject({ ok: false, status: 400 });
    expect(broker.has(requestId)).toBe(true);
    broker.answer(requestId, { answer: "deny" });
    expect(await pending).toMatchObject({ allowed: false, reason: "denied" });
    expect(broker.answer(requestId, { answer: "deny" })).toMatchObject({ ok: false, status: 404 });
  });

  it("is not allowed when nobody answers, the call is cancelled, or no chat can show it", async () => {
    const { broker } = setup();
    expect(await broker.request("caller-session", createInput, undefined, 5)).toMatchObject({ allowed: false, reason: "timeout" });

    const controller = new AbortController();
    const cancelled = broker.request("caller-session", createInput, controller.signal);
    controller.abort();
    expect(await cancelled).toMatchObject({ allowed: false, reason: "cancelled" });

    const hidden = setup({ shown: false });
    expect(await hidden.broker.request("caller-session", createInput)).toMatchObject({ allowed: false, reason: "no-chat" });
  });

  it("holds one card per session; cancelling the session settles it", async () => {
    const { broker } = setup();
    const first = broker.request("caller-session", createInput);
    expect(await broker.request("old-caller-session", createInput)).toMatchObject({ allowed: false, reason: "busy" });
    expect(broker.cancelSession("caller-session", "stopped")).toBe(true);
    expect(await first).toEqual({ allowed: false, reason: "cancelled", message: "stopped" });
    expect(broker.pendingCount()).toBe(0);
  });
});
