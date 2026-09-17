/**
 * A session that changes its id must take its account binding with it.
 *
 * `sendMessage()` re-keys a session to a fresh UUID when the id it was handed is not one
 * (short ids leak in from tab derivation and URL parsing). That block moves the provider's
 * in-memory maps, and the account lookup runs *after* it — so a binding left behind under
 * the old id is simply not found, and the session is silently re-routed to whatever the
 * strategy picks next. That costs a full prompt-cache write, and when the binding came from
 * the user picking an account it overrides them without saying so.
 *
 * The generator suspends at its first `yield`, which is the migration event itself, so this
 * observes the re-key without ever reaching the SDK.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb, getSessionAccount, setSessionAccount } from "../../../src/services/db.service.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { ClaudeAgentSdkProvider } from "../../../src/providers/claude-agent-sdk.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

setKeyPath(resolve(tmpdir(), `ppm-test-migration-${Date.now()}.key`));

function addAccount(email: string) {
  return accountService.add({
    email,
    accessToken: `access-${email}`,
    refreshToken: `refresh-${email}`,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    label: email,
  });
}

describe("session id migration carries the account binding", () => {
  beforeEach(() => {
    setDb(openTestDb());
  });

  it("moves the binding to the new id", async () => {
    const acc = addAccount("bound@test.com");
    const shortId = "not-a-uuid";
    setSessionAccount(shortId, acc.id);

    const provider = new ClaudeAgentSdkProvider();
    const stream = provider.sendMessage(shortId, "hello");
    const first = await stream.next();
    // Stop before the SDK is reached — the migration is all this test is about.
    await stream.return?.(undefined);

    expect((first.value as { type: string }).type).toBe("session_migrated");
    const newId = (first.value as { newSessionId: string }).newSessionId;
    expect(newId).not.toBe(shortId);
    expect(getSessionAccount(newId)).toBe(acc.id);
  });

  it("does not invent a binding for a session that never had one", async () => {
    const provider = new ClaudeAgentSdkProvider();
    const stream = provider.sendMessage("also-not-a-uuid", "hello");
    const first = await stream.next();
    await stream.return?.(undefined);

    const newId = (first.value as { newSessionId: string }).newSessionId;
    expect(getSessionAccount(newId)).toBeNull();
  });
});
