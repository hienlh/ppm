import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  createCodexAccount, removeCodexAccount, listCodexAccounts, setCodexAccountStatus,
  codexLoginForListing, selectCodexAccount, setCodexStrategy, setCodexDailyGuard,
} from "../../../src/services/codex-account.service.ts";
import { setCachedUsage, _clearUsageCache } from "../../../src/services/provider-usage/usage-memory-cache.ts";
import { markCodexAccountAuthFailed, isCodexAccountAuthFailed, _resetCodexAuthFailuresForTesting } from "../../../src/services/codex-account-auth-state.ts";
import { markCodexAccountUsageLimited, _resetCodexCooldownsForTesting } from "../../../src/services/codex-account-cooldown.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";

/**
 * The model list is read on the same login a new chat would run on, and never falls through
 * to the machine's own ~/.codex while PPM manages accounts that a chat would refuse.
 *
 * Daily guard off: a guarded account makes the pick read usage, which is not under test here.
 */
const mk = (label: string) => createCodexAccount({
  label, type: "apiKey", creds: { type: "apiKey", apiKey: "k-" + label }, dailyGuardEnabled: false,
});

function reset(): void {
  for (const a of listCodexAccounts()) removeCodexAccount(a.id);
  _resetCodexAuthFailuresForTesting();
  _resetCodexCooldownsForTesting();
}

describe("codexLoginForListing", () => {
  beforeEach(reset);
  afterEach(reset);

  it("uses ~/.codex when PPM has no Codex account, as a chat does", async () => {
    expect(await codexLoginForListing()).toEqual({ kind: "ambient" });
  });

  it("uses ~/.codex when every account is switched off, as a chat does", async () => {
    const a = mk("A");
    setCodexAccountStatus(a.id, "disabled");
    expect(await codexLoginForListing()).toEqual({ kind: "ambient" });
  });

  it("reads nothing when every enabled account is signed out", async () => {
    const a = mk("A"); const b = mk("B");
    markCodexAccountAuthFailed(a.id, "401"); markCodexAccountAuthFailed(b.id, "401");
    expect((await codexLoginForListing()).kind).toBe("none");
  });

  it("skips a signed-out or switched-off account for one a chat could get", async () => {
    const a = mk("A"); const b = mk("B"); const c = mk("C");
    markCodexAccountAuthFailed(a.id, "401");
    setCodexAccountStatus(b.id, "disabled");
    const login = await codexLoginForListing();
    expect(login.kind === "account" && login.account.id).toBe(c.id);
  });

  it("prefers an account with quota left, and still answers when all are out", async () => {
    const a = mk("A"); const b = mk("B");
    markCodexAccountUsageLimited(a.id);
    let login = await codexLoginForListing();
    expect(login.kind === "account" && login.account.id).toBe(b.id);
    markCodexAccountUsageLimited(b.id);
    login = await codexLoginForListing();
    expect(login.kind).toBe("account");
  });

  it("reads nothing when the daily guard holds back every account, and skips a held one", async () => {
    // A weekly bucket at 100% is past the guard's cap on any day of the week.
    const spent = { weekly: { utilization: 1, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      resetsInMinutes: null, resetsInHours: null, windowHours: 168 } };
    const a = createCodexAccount({ label: "A", type: "apiKey", creds: { type: "apiKey", apiKey: "k-A" } });
    const b = createCodexAccount({ label: "B", type: "apiKey", creds: { type: "apiKey", apiKey: "k-B" } });
    setCachedUsage("codex", a.id, spent); setCachedUsage("codex", b.id, spent);
    try {
      // The old path fell through to ~/.codex here.
      expect((await codexLoginForListing()).kind).toBe("none");
      setCachedUsage("codex", b.id, { weekly: { ...spent.weekly, utilization: 0 } });
      setCodexDailyGuard(b.id, false);
      const login = await codexLoginForListing();
      expect(login.kind === "account" && login.account.id).toBe(b.id);
    } finally {
      _clearUsageCache();
    }
  });

  it("does not advance the round-robin cursor that real turns use", async () => {
    setCodexStrategy("round-robin");
    mk("A"); mk("B");
    const before = selectCodexAccount()!.id;
    for (let i = 0; i < 3; i++) await codexLoginForListing();
    // Two accounts: the next pick alternates exactly as if no listing had happened.
    expect(selectCodexAccount()!.id).not.toBe(before);
  });
});

describe("listModels login", () => {
  const spies: { mockRestore(): void }[] = [];
  beforeEach(reset);
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); reset(); });

  function fakeClient() {
    const start = spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {});
    spies.push(start,
      spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}),
      spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}),
      spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation((async (method: string) =>
        method === "model/list"
          ? { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test" }], nextCursor: null }
          : {}) as CodexJsonRpcClient["request"]));
    return start;
  }

  it("spawns no app-server while every enabled account is signed out", async () => {
    const start = fakeClient();
    const a = mk("A");
    markCodexAccountAuthFailed(a.id, "401");
    expect(await new CodexAppServerProvider().listModels()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps the last list when the accounts become unusable", async () => {
    const start = fakeClient();
    const a = mk("A");
    const provider = new CodexAppServerProvider();
    const models = await provider.listModels();
    expect(models.length).toBe(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ codexHome: a.home });

    markCodexAccountAuthFailed(a.id, "401");
    const now = Date.now();
    spies.push(spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000));
    expect(await provider.listModels()).toEqual(models);
    await new Promise((r) => setTimeout(r, 0));
    expect(await provider.listModels()).toEqual(models);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("benches an account whose login the model list was refused on", async () => {
    spies.push(
      spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {}),
      spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}),
      spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}),
      spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation((async () => {
        throw new Error("unexpected status 401 Unauthorized: workspace routing discovery unauthorized (401)");
      }) as CodexJsonRpcClient["request"]));
    const a = mk("A");
    expect(await new CodexAppServerProvider().listModels()).toEqual([]);
    expect(isCodexAccountAuthFailed(a.id)).toBe(true);
  });

  it("reads ~/.codex only when no account is configured", async () => {
    const start = fakeClient();
    await new CodexAppServerProvider().listModels();
    expect(start).toHaveBeenCalledTimes(1);
    expect((start.mock.calls[0]![0] as { codexHome?: string }).codexHome).toBeUndefined();
  });
});
