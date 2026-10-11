/**
 * The Assistant endpoint's approval broker: a card goes to the session, the first answer from
 * that session settles it, a card waits for its answer without limit unless a test sets one,
 * nothing runs once the asking HTTP call closes, an answer from another session is refused, and a
 * Codex session renamed after the question was asked is still the one that answers it.
 */
import { describe, expect, it } from "bun:test";
import {
  APPROVAL_TIMEOUT_ENV, approvalTimeoutMs, createApprovalBroker,
  type ApprovalAsk,
} from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { ASSISTANT_MCP_TIMEOUT_MS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import type { EndpointApprovalRequest } from "../../../src/shared/assistant-approval.ts";

const ASK: ApprovalAsk = {
  tool: "db_query",
  input: { connection: "main", sql: "DELETE FROM t" },
  summary: { headline: "Run 1 SQL statement that may change data on \"main\"", facts: [] },
};

/** `queued`: the card waits behind another and is not shown until the test says so. */
function setup(opts: { timeoutMs?: number | null; renamed?: Record<string, string>; reachable?: boolean; queued?: boolean } = {}) {
  const shown: Array<{ sessionId: string; request: EndpointApprovalRequest }> = [];
  const ended: Array<{ sessionId: string; requestId: string; approved: boolean }> = [];
  const canonical = (id: string) => opts.renamed?.[id] ?? id;
  const broker: ReturnType<typeof createApprovalBroker> = createApprovalBroker({
    deliver: (sessionId, request) => {
      if (opts.reachable === false) return 0;
      shown.push({ sessionId, request });
      if (!opts.queued) broker.shown(request.requestId);
      return 1;
    },
    onEnd: (sessionId, requestId, approved) => ended.push({ sessionId, requestId, approved }),
    canonical,
    timeoutMs: () => (opts.timeoutMs === undefined ? 5_000 : opts.timeoutMs),
  });
  return { broker, shown, ended };
}

describe("assistant approval broker", () => {
  it("puts an endpoint card on the session and runs only on an approval", async () => {
    const { broker, shown, ended } = setup();
    const pending = broker.request("s1", ASK);
    expect(shown).toHaveLength(1);
    const card = shown[0]!.request;
    expect(card).toMatchObject({ type: "approval_request", tool: "db_query", origin: "endpoint", summary: ASK.summary });
    expect(broker.owns(card.requestId)).toBe(true);
    expect(broker.settle("s1", card.requestId, true)).toBe(true);
    expect(await pending).toEqual({ verdict: "approved" });
    expect(ended).toEqual([{ sessionId: "s1", requestId: card.requestId, approved: true }]);
    expect(broker.owns(card.requestId)).toBe(false);
  });

  it("takes the first answer and ignores later ones", async () => {
    const { broker, shown } = setup();
    const pending = broker.request("s1", ASK);
    const { requestId } = shown[0]!.request;
    expect(broker.settle("s1", requestId, false)).toBe(true);
    expect(broker.settle("s1", requestId, true)).toBe(false);
    const verdict = await pending;
    expect(verdict.verdict).toBe("denied");
    if (verdict.verdict !== "approved") expect(verdict.reason).toContain("do not try again");
  });

  it("refuses an answer from another session", async () => {
    const { broker, shown } = setup({ timeoutMs: 50 });
    const pending = broker.request("s1", ASK);
    expect(broker.settle("s2", shown[0]!.request.requestId, true)).toBe(false);
    expect((await pending).verdict).toBe("timeout");
  });

  it("times out without running, and says so", async () => {
    const { broker, shown, ended } = setup({ timeoutMs: 40 });
    const verdict = await broker.request("s1", ASK);
    expect(verdict.verdict).toBe("timeout");
    if (verdict.verdict !== "approved") expect(verdict.reason).toContain("did not answer");
    expect(ended).toEqual([{ sessionId: "s1", requestId: shown[0]!.request.requestId, approved: false }]);
    expect(broker.pendingCount()).toBe(0);
  });

  it("withdraws the card when the asking HTTP call closes", async () => {
    const { broker, ended } = setup();
    const http = new AbortController();
    const pending = broker.request("s1", ASK, http.signal);
    http.abort();
    expect((await pending).verdict).toBe("withdrawn");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.approved).toBe(false);
    expect(broker.pendingCount()).toBe(0);
    // A call already closed is never shown.
    const { broker: b2, shown: shown2 } = setup();
    expect((await b2.request("s1", ASK, AbortSignal.abort())).verdict).toBe("withdrawn");
    expect(shown2).toHaveLength(0);
  });

  it("ends a request with the reason it is withdrawn for", async () => {
    const { broker, shown } = setup();
    const pending = broker.request("s1", ASK);
    expect(broker.withdraw(shown[0]!.request.requestId, "The user sent another message instead of answering; not run.")).toBe(true);
    expect(await pending).toEqual({ verdict: "withdrawn", reason: "The user sent another message instead of answering; not run." });
    expect(broker.withdraw(shown[0]!.request.requestId, "again")).toBe(false);
  });

  it("follows a Codex session renamed after the question was asked", async () => {
    const renamed: Record<string, string> = {};
    const { broker, shown } = setup({ renamed });
    const pending = broker.request("draft-1", ASK);
    expect(shown[0]!.sessionId).toBe("draft-1");
    renamed["draft-1"] = "thread-9";
    // The chat's sockets now answer under the thread's id.
    expect(broker.settle("thread-9", shown[0]!.request.requestId, true)).toBe(true);
    expect((await pending).verdict).toBe("approved");
    // A question asked under the old id after the rename lands on the new one.
    const later = broker.request("draft-1", ASK);
    expect(shown[1]!.sessionId).toBe("thread-9");
    expect(broker.pendingFor("draft-1")).toEqual([shown[1]!.request.requestId]);
    broker.settle("thread-9", shown[1]!.request.requestId, false);
    expect((await later).verdict).toBe("denied");
  });

  it("answers unavailable when the session cannot hold a card", async () => {
    const { broker } = setup({ reachable: false });
    expect((await broker.request("gone", ASK)).verdict).toBe("unavailable");
  });

  it("starts the answer window when the card is shown, not while it waits in the queue", async () => {
    const { broker, shown } = setup({ timeoutMs: 60, queued: true });
    let settled = false;
    const pending = broker.request("s1", ASK).then((v) => { settled = true; return v; });
    await Bun.sleep(150);
    // Queued for longer than the whole answer window, and still waiting.
    expect(settled).toBe(false);
    const started = Date.now();
    broker.shown(shown[0]!.request.requestId);
    // Shown again by a reconnecting device: the window does not restart.
    await Bun.sleep(30);
    broker.shown(shown[0]!.request.requestId);
    const verdict = await pending;
    expect(Date.now() - started).toBeLessThan(150);
    expect(verdict.verdict).toBe("timeout");
    if (verdict.verdict !== "approved") expect(verdict.reason).toContain("did not answer");
  });

  it("without a limit, a card waits shown or queued until it is answered or withdrawn", async () => {
    const { broker, shown, ended } = setup({ timeoutMs: null });
    let settled = false;
    const pending = broker.request("s1", ASK).then((v) => { settled = true; return v; });
    const queued = setup({ timeoutMs: null, queued: true });
    let queuedSettled = false;
    const waiting = queued.broker.request("s1", ASK).then((v) => { queuedSettled = true; return v; });
    await Bun.sleep(200);
    expect(settled).toBe(false);
    expect(queuedSettled).toBe(false);
    expect(broker.pendingCount()).toBe(1);
    broker.settle("s1", shown[0]!.request.requestId, true);
    expect(await pending).toEqual({ verdict: "approved" });
    expect(ended).toHaveLength(1);
    queued.broker.withdraw(queued.shown[0]!.request.requestId, "The turn ended.");
    expect(await waiting).toEqual({ verdict: "withdrawn", reason: "The turn ended." });
  });

  it("waits without limit unless the environment sets one under the providers' own timeout", () => {
    expect(approvalTimeoutMs({})).toBeNull();
    expect(approvalTimeoutMs({ [APPROVAL_TIMEOUT_ENV]: "1500" })).toBe(1_500);
    expect(approvalTimeoutMs({ [APPROVAL_TIMEOUT_ENV]: "soon" })).toBeNull();
    expect(approvalTimeoutMs({ [APPROVAL_TIMEOUT_ENV]: "50" })).toBeNull();
    expect(approvalTimeoutMs({ [APPROVAL_TIMEOUT_ENV]: String(ASSISTANT_MCP_TIMEOUT_MS) })).toBeNull();
  });
});
