import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";
import {
  QUIET_REFRESH_WINDOW_S,
  accountsToRenewNow,
  dropStaleIdle,
  registerTokenRotation,
  staleIdleSessions,
  sweepTokenRotation,
  type LiveSubprocess,
  type TokenRotationDeps,
} from "../../../src/server/ws/chat-token-rotation.ts";

const testKeyPath = resolve(tmpdir(), `ppm-test-token-rotation-${Date.now()}.key`);
setKeyPath(testKeyPath);

const NOW = 1_800_000_000;

function live(sessionId: string, accountId: string | null, oauthToken: string, busy = false): LiveSubprocess {
  return { sessionId, credential: { accountId, oauthToken }, busy };
}

describe("accountsToRenewNow", () => {
  const due = { id: "a", expiresAt: NOW + 1800, renewable: true };

  it("renews an account in use, near expiry, with nothing running on it", () => {
    expect(accountsToRenewNow([due], [live("s1", "a", "tok")], NOW)).toEqual(["a"]);
  });

  it("waits while any subprocess on the account is busy", () => {
    expect(accountsToRenewNow([due], [live("s1", "a", "tok"), live("s2", "a", "tok", true)], NOW)).toEqual([]);
  });

  it("leaves accounts no subprocess holds to the point-of-use renewal", () => {
    expect(accountsToRenewNow([due], [live("s1", "b", "tok")], NOW)).toEqual([]);
  });

  it("does nothing outside the window or inside the point-of-use buffer", () => {
    const early = { ...due, expiresAt: NOW + QUIET_REFRESH_WINDOW_S + 60 };
    const late = { ...due, expiresAt: NOW + 120 };
    expect(accountsToRenewNow([early, late], [live("s1", "a", "tok")], NOW)).toEqual([]);
  });

  it("skips accounts that cannot be renewed", () => {
    expect(accountsToRenewNow([{ ...due, renewable: false }], [live("s1", "a", "tok")], NOW)).toEqual([]);
  });
});

describe("staleIdleSessions", () => {
  const current = (id: string) => (id === "a" ? "new" : null);

  it("drops idle subprocesses whose token was replaced, never busy or current ones", () => {
    const procs = [
      live("idle-stale", "a", "old"),
      live("busy-stale", "a", "old", true),
      live("idle-current", "a", "new"),
      live("no-account", null, "old"),
      live("api-key", "b", "old"),
    ];
    expect(staleIdleSessions(procs, current)).toEqual(["idle-stale"]);
  });
});

describe("token rotation against the account store", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  beforeEach(() => {
    setDb(openTestDb());
    fetchCalls = 0;
    globalThis.fetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response(
        JSON.stringify({ access_token: "sk-ant-oat-renewed", refresh_token: "rotated", expires_in: 28800 }),
        { status: 200 },
      ));
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setDb(openTestDb());
    if (existsSync(testKeyPath)) unlinkSync(testKeyPath);
  });

  function addDueAccount() {
    return accountService.add({
      email: "rotation@test.com",
      accessToken: "sk-ant-oat-old",
      refreshToken: "refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
    });
  }

  function depsFor(procs: LiveSubprocess[]): TokenRotationDeps & { dropped: string[] } {
    const dropped: string[] = [];
    return {
      dropped,
      liveSubprocesses: () => procs.filter((p) => !dropped.includes(p.sessionId)),
      dropIdle: (sessionId) => { dropped.push(sessionId); },
    };
  }

  it("renews a quiet account early and moves its idle chats onto the new token", async () => {
    const acc = addDueAccount();
    const deps = depsFor([live("s1", acc.id, "sk-ant-oat-old"), live("s2", acc.id, "sk-ant-oat-old")]);

    await sweepTokenRotation(deps);

    expect(fetchCalls).toBe(1);
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("sk-ant-oat-renewed");
    expect(deps.dropped.sort()).toEqual(["s1", "s2"]);
  });

  it("does not renew while a turn runs on the account", async () => {
    const acc = addDueAccount();
    const deps = depsFor([live("s1", acc.id, "sk-ant-oat-old"), live("s2", acc.id, "sk-ant-oat-old", true)]);

    await sweepTokenRotation(deps);

    expect(fetchCalls).toBe(0);
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("sk-ant-oat-old");
    expect(deps.dropped).toEqual([]);
  });

  it("restarts idle chats on any renewal and the busy one once its turn ends", async () => {
    const acc = addDueAccount();
    const procs = [live("idle", acc.id, "sk-ant-oat-old"), live("busy", acc.id, "sk-ant-oat-old", true)];
    const deps = depsFor(procs);
    const stop = registerTokenRotation(deps);
    try {
      // A renewal from elsewhere — a turn's pre-flight, the usage poller — not the sweep.
      await accountService.refreshAccessToken(acc.id, false, true);
      expect(deps.dropped).toEqual(["idle"]);

      procs[1]!.busy = false; // the turn ended
      dropStaleIdle(deps);
      expect(deps.dropped).toEqual(["idle", "busy"]);
    } finally {
      stop();
    }
  });
});
