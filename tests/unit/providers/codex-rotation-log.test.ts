/**
 * The line a Codex account rotation leaves in ppm.log. It names the account by id: a label is
 * the account's ChatGPT email unless somebody renamed it, and a WARN line also reaches the
 * Logs window's Issues tab and the bug reports drafted from it.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import { createCodexAccount, removeCodexAccount, listCodexAccounts } from "../../../src/services/codex-account.service.ts";
import { getDb, setSessionCodexAccount } from "../../../src/services/db.service.ts";
import { _resetLoggerForTests } from "../../../src/services/logger.ts";

const SESSION = "s-rotation-log";

describe("codex account rotation log line", () => {
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    for (const a of listCodexAccounts()) removeCodexAccount(a.id);
    _resetLoggerForTests(); // console sink, default level
    // Choosing the next account reads every account's quota, which would start an app-server.
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async () => ({})));
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const a of listCodexAccounts()) removeCodexAccount(a.id);
    getDb().query("DELETE FROM session_metadata WHERE session_id = ?").run(SESSION);
  });

  it("names the account it moves to by id, never by its label", async () => {
    const signedOut = createCodexAccount({ label: "first", type: "apiKey", creds: { type: "apiKey", apiKey: "k1" }, dailyGuardEnabled: false });
    const next = createCodexAccount({ label: "someone@example.com", type: "apiKey", creds: { type: "apiKey", apiKey: "k2" }, dailyGuardEnabled: false });
    setSessionCodexAccount(SESSION, signedOut.id);

    const p: any = new CodexAppServerProvider();
    const pushed: any[] = [];
    const live: any = {
      client: { isClosed: false, close() { this.isClosed = true; }, request: async () => ({}) },
      threadId: SESSION, cwd: process.cwd(),
      channel: { push: (ev: any) => pushed.push(ev), done: () => {}, iterator: null },
      permission: {}, pendingApprovals: new Map(), answeredCodexIds: new Set(),
      history: [], transcript: [], currentAssistant: "", currentEvents: [],
      pendingTurns: [], subagentThreadIds: new Set(), rotating: true,
    };
    p.live.set(SESSION, live);
    p.respawnOn = async () => {}; // the subprocess swap is not what this test is about

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let warned: string[];
    try {
      await p.rotateAccount(live, SESSION, signedOut.id, "workspace routing discovery unauthorized (401)", "auth");
      warned = warn.mock.calls.map((args) => args.map(String).join(" "));
    } finally {
      warn.mockRestore();
      p.cleanupAll();
    }

    expect(pushed.find((e) => e.type === "account_retry")?.accountId).toBe(next.id);
    const line = warned.find((l) => l.includes("switching to"));
    expect(line).toContain(next.id);
    expect(line).not.toContain("someone@example.com");
  });
});
