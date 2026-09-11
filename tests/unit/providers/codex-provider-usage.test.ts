import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import { createCodexAccount, removeCodexAccount } from "../../../src/services/codex-account.service.ts";
import { setSessionCodexAccount } from "../../../src/services/db.service.ts";

describe("Codex provider usage account", () => {
  const accountIds: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const id of accountIds.splice(0)) removeCodexAccount(id);
  });

  function account(label: string) {
    const value = createCodexAccount({ label, type: "chatgpt" });
    accountIds.push(value.id);
    return value;
  }

  it("uses the bound managed home and label instead of the ambient login", async () => {
    account("Other account");
    const bound = account("Session account");
    setSessionCodexAccount("usage-bound", bound.id);
    const start = spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {});
    spies.push(start);
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method) => {
      if (method === "account/rateLimits/read") {
        return { rateLimits: { primary: { usedPercent: 17 }, planType: "plus" } };
      }
      return {};
    }));

    const usage = await new CodexAppServerProvider().getUsage("usage-bound");
    expect(start).toHaveBeenCalledWith({ cwd: process.cwd(), codexHome: bound.home });
    expect(usage).toMatchObject({ fiveHour: 0.17, activeAccountId: bound.id, activeAccountLabel: bound.label });
  });

  it("does not query an unrelated login before a managed session is bound", async () => {
    const available = account("Available account");
    const start = spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {});
    spies.push(start);

    // The account that WILL serve the session is named, so the chat toolbar has
    // something to show for a tab that has not sent its first message yet…
    expect(await new CodexAppServerProvider().getUsage("usage-unbound")).toEqual({
      activeAccountId: available.id,
      activeAccountLabel: available.label,
    });
    // …but its quota is deliberately NOT read: that would spawn an app-server
    // against a login the session does not own yet. No numbers, no spawn.
    expect(start).not.toHaveBeenCalled();
  });

  it("names nothing when the session is bound to an account that no longer exists", async () => {
    account("Still present");
    setSessionCodexAccount("usage-dangling", "deleted-account-id");
    const start = spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {});
    spies.push(start);

    // A dangling binding must not be papered over with whichever account
    // happens to remain — that would misreport which login is in play.
    expect(await new CodexAppServerProvider().getUsage("usage-dangling")).toEqual({});
    expect(start).not.toHaveBeenCalled();
  });

  it("names nothing to preview when several accounts are in round-robin", async () => {
    account("First");
    account("Second");
    const start = spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {});
    spies.push(start);

    // Which one gets the next turn is genuinely undecided, and asking would
    // advance the cursor and change that answer. Better blank than wrong.
    expect(await new CodexAppServerProvider().getUsage("usage-ambiguous")).toEqual({});
    expect(start).not.toHaveBeenCalled();
  });
});
