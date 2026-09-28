/**
 * Signing an existing Codex account in again.
 *
 * The login runs in that account's own CODEX_HOME and finalises by updating its row, so the
 * id — and every session, transcript and setting keyed on it — survives. The one thing it
 * must never do is what an abandoned *new* login does: delete the home it was using.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startDeviceLogin, startBrowserLogin, getDeviceLoginStatus, cancelDeviceLogin, type LoginClient,
} from "../../../src/services/codex-account-login.ts";
import {
  createCodexAccount, getCodexAccount, listCodexAccounts, removeCodexAccount,
} from "../../../src/services/codex-account.service.ts";
import {
  isCodexAccountAuthFailed, markCodexAccountAuthFailed, _resetCodexAuthFailuresForTesting,
} from "../../../src/services/codex-account-auth-state.ts";

class FakeClient implements LoginClient {
  notif: (n: { method: string; params?: unknown }) => void = () => {};
  startedHome: string | undefined;
  start(opts?: { codexHome?: string }): void { this.startedHome = opts?.codexHome; }
  onNotification(fn: (n: { method: string; params?: unknown }) => void): void { this.notif = fn; }
  onClose(): void {}
  notify(): void {}
  close(): void {}
  async request<T>(method: string): Promise<T> {
    if (method === "account/read") return { account: { type: "chatgpt", email: "dev@example.com", planType: "team" } } as T;
    if (method === "account/login/start") return { userCode: "WXYZ-0000", verificationUrl: "https://example.com/device" } as T;
    return {} as T;
  }
  complete(success: boolean): void { this.notif({ method: "account/login/completed", params: { success } }); }
}

const settled = () => new Promise((r) => setTimeout(r, 5));

describe("codex re-login", () => {
  beforeEach(() => {
    for (const a of listCodexAccounts()) removeCodexAccount(a.id);
    _resetCodexAuthFailuresForTesting();
  });

  it("signs the same account in again inside its own home, keeping id and label", async () => {
    const acct = createCodexAccount({ label: "Work", type: "chatgpt", planType: "plus" });
    markCodexAccountAuthFailed(acct.id, "401 Unauthorized");
    const fake = new FakeClient();

    const { id: flowId } = await startDeviceLogin(undefined, () => fake, acct.id);
    expect(fake.startedHome).toBe(acct.home);
    fake.complete(true);
    await settled();

    const s = getDeviceLoginStatus(flowId);
    expect(s.state).toBe("done");
    if (s.state !== "done") throw new Error("unreachable");
    expect(s.account.id).toBe(acct.id);
    expect(listCodexAccounts().length).toBe(1);
    const after = getCodexAccount(acct.id)!;
    expect(after.label).toBe("Work");
    expect(after.planType).toBe("team");
    expect(isCodexAccountAuthFailed(acct.id)).toBe(false);
  });

  it("never deletes the account's home when the sign-in fails or is cancelled", async () => {
    const acct = createCodexAccount({ label: "Keep", type: "chatgpt" });
    writeFileSync(join(acct.home, "auth.json"), "{}");

    const failing = new FakeClient();
    const { id: failed } = await startDeviceLogin(undefined, () => failing, acct.id);
    failing.complete(false);
    await settled();
    expect(getDeviceLoginStatus(failed).state).toBe("error");
    expect(existsSync(join(acct.home, "auth.json"))).toBe(true);

    const { id: cancelled } = await startDeviceLogin(undefined, () => new FakeClient(), acct.id);
    cancelDeviceLogin(cancelled);
    expect(existsSync(join(acct.home, "auth.json"))).toBe(true);
    expect(getCodexAccount(acct.id)).not.toBeNull();
  });

  it("refuses an unknown account and an API-key account", async () => {
    await expect(startDeviceLogin(undefined, () => new FakeClient(), "no-such-id")).rejects.toThrow("Account not found");
    const key = createCodexAccount({ label: "key", type: "apiKey", creds: { type: "apiKey", apiKey: "k" } });
    await expect(startBrowserLogin(undefined, () => new FakeClient(), key.id)).rejects.toThrow("ChatGPT");
  });
});
