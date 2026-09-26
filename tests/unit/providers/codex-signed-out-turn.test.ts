/**
 * A turn on a signed-out Codex account.
 *
 * Codex does not refuse such a turn up front: it opens it, then spends ~24s reconnecting
 * ("Reconnecting... N/5", twice) before a final error. The provider has to recognise the
 * first notice, report it once, stop the turn, and swallow the rest of codex's narration.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { createCodexAccount, removeCodexAccount, listCodexAccounts } from "../../../src/services/codex-account.service.ts";
import { setSessionCodexAccount } from "../../../src/services/db.service.ts";
import {
  isCodexAccountAuthFailed, markCodexAccountAuthFailed, _resetCodexAuthFailuresForTesting,
} from "../../../src/services/codex-account-auth-state.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeLive(provider: any, sessionId: string) {
  const sent: { method: string; params: any }[] = [];
  const pushed: any[] = [];
  const live: any = {
    client: {
      isClosed: false,
      close() { this.isClosed = true; },
      request(method: string, params: any) {
        sent.push({ method, params });
        if (method === "turn/start") return Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } });
        return Promise.resolve({});
      },
    },
    threadId: sessionId, cwd: "/tmp",
    channel: { push: (ev: any) => pushed.push(ev), done: () => {}, iterator: null },
    permission: {}, pendingApprovals: new Map(), answeredCodexIds: new Set(),
    history: [], transcript: [], currentAssistant: "", currentEvents: [],
    pendingTurns: [], subagentThreadIds: new Set(),
  };
  provider.live.set(sessionId, live);
  return { live, sent, pushed };
}

const retryNotice = (n: number) => ({
  method: "error",
  params: {
    error: { message: `Reconnecting... ${n}/5`, additionalDetails: "workspace routing discovery unauthorized (401)" },
    willRetry: true,
  },
});

describe("codex turn on a signed-out account", () => {
  beforeEach(() => {
    for (const a of listCodexAccounts()) removeCodexAccount(a.id);
    _resetCodexAuthFailuresForTesting();
  });

  it("reports once on the first retry notice, interrupts, and drops the rest", async () => {
    const acct = createCodexAccount({ label: "team", type: "apiKey", creds: { type: "apiKey", apiKey: "k" }, dailyGuardEnabled: false });
    const p: any = new CodexAppServerProvider();
    const { live, sent, pushed } = makeLive(p, "s-auth");
    setSessionCodexAccount("s-auth", acct.id);

    p.startTurn(live, "hello");
    await tick();
    p.handleNotification(live, { method: "turn/started", params: { threadId: "s-auth", turn: { id: "turn-1" } } });
    p.handleNotification(live, retryNotice(1));

    expect(isCodexAccountAuthFailed(acct.id)).toBe(true);
    const errors = pushed.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("team");
    expect(errors[0].message).toContain("signed out");
    expect(pushed.filter((e) => e.type === "done").length).toBe(1);
    expect(sent.find((r) => r.method === "turn/interrupt")?.params).toEqual({ threadId: "s-auth", turnId: "turn-1" });

    // Codex keeps narrating the dead turn; none of it may reach the caller again.
    p.pushMessage("s-auth", "follow-up");
    p.handleNotification(live, retryNotice(2));
    p.handleNotification(live, { method: "error", params: { error: { message: "workspace routing discovery unauthorized (401)" }, willRetry: false } });
    expect(pushed.filter((e) => e.type === "error").length).toBe(1);
    expect(sent.filter((r) => r.method === "turn/start").length).toBe(1);

    // Only codex's own turn/completed lets the queue move on — and adds no second `done`.
    p.handleNotification(live, { method: "turn/completed", params: { threadId: "s-auth", turn: { id: "turn-1", status: "interrupted" } } });
    await tick();
    expect(pushed.filter((e) => e.type === "done").length).toBe(1);
    expect(sent.filter((r) => r.method === "turn/start").length).toBe(2);
    p.cleanupAll();
  });

  it("a retry notice without an auth cause is only a status update", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, pushed } = makeLive(p, "s-net");
    p.handleNotification(live, { method: "error", params: { error: { message: "Reconnecting... 1/5", additionalDetails: "stream disconnected" }, willRetry: true } });
    expect(pushed).toEqual([{ type: "status_update", phase: "retrying", message: "Reconnecting... 1/5" }]);
    p.cleanupAll();
  });

  it("an answered turn clears the mark", async () => {
    const acct = createCodexAccount({ label: "back", type: "apiKey", creds: { type: "apiKey", apiKey: "k" }, dailyGuardEnabled: false });
    const p: any = new CodexAppServerProvider();
    const { live } = makeLive(p, "s-ok");
    setSessionCodexAccount("s-ok", acct.id);
    markCodexAccountAuthFailed(acct.id, "401");
    p.handleNotification(live, { method: "turn/completed", params: { threadId: "s-ok", turn: { id: "t", status: "completed" } } });
    expect(isCodexAccountAuthFailed(acct.id)).toBe(false);
    p.cleanupAll();
  });
});
