import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  markCodexAccountAuthFailed, isCodexAccountAuthFailed, isCodexAccountAuthRecheckPending,
  clearCodexAccountAuthFailure, codexAuthRecheckDelayMs, _resetCodexAuthFailuresForTesting,
} from "../../../src/services/codex-account-auth-state.ts";
import { codexUsageSource } from "../../../src/providers/codex-app-server/codex-usage-source.ts";
import { AMBIENT_ACCOUNT_KEY } from "../../../src/services/provider-usage/usage-source.ts";

const MIN = 60_000;

describe("signed-out account recheck backoff", () => {
  let now = Date.parse("2026-11-14T13:00:00Z");
  let clock: { mockRestore(): void };
  beforeEach(() => {
    _resetCodexAuthFailuresForTesting();
    now = Date.parse("2026-11-14T13:00:00Z");
    clock = spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => { clock.mockRestore(); _resetCodexAuthFailuresForTesting(); });

  it("doubles the wait from five minutes up to an hour", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => codexAuthRecheckDelayMs(n) / MIN)).toEqual([5, 10, 20, 40, 60, 60]);
  });

  it("makes the sweep leave the account alone until its next read is due", async () => {
    const id = "acct-signed-out";
    const due: boolean[] = [];
    // A sweep every five minutes for two hours; each read that happens is refused again.
    for (let t = 0; t <= 120; t += 5) {
      now = Date.parse("2026-11-14T13:00:00Z") + t * MIN;
      const skip = await codexUsageSource.shouldSkip!(id);
      due.push(!skip);
      if (!skip) markCodexAccountAuthFailed(id, "401 Unauthorized");
      // Benched the whole time, so no turn is handed to it between reads.
      expect(isCodexAccountAuthFailed(id)).toBe(true);
    }
    const readsAt = due.flatMap((d, i) => (d ? [i * 5] : []));
    // Instead of 25 app-servers in two hours: reads at 0, 5, 15, 35, 75 and 135 (past the window).
    expect(readsAt).toEqual([0, 5, 15, 35, 75]);
  });

  it("does not widen the wait for refusals that arrive together", () => {
    // Three chats, a proxy turn and a one-shot on one account all hit the same transient 401.
    for (let i = 0; i < 5; i++) markCodexAccountAuthFailed("a", "401");
    now += 5 * MIN;
    // Re-read at the next sweep, as after a single refusal, not an hour later.
    expect(isCodexAccountAuthRecheckPending("a")).toBe(false);
    expect(isCodexAccountAuthFailed("a")).toBe(true);
  });

  it("reads again at once after a sign-in, and never skips the ambient login", async () => {
    markCodexAccountAuthFailed("a", "401");
    expect(isCodexAccountAuthRecheckPending("a")).toBe(true);
    clearCodexAccountAuthFailure("a");
    expect(await codexUsageSource.shouldSkip!("a")).toBe(false);
    expect(await codexUsageSource.shouldSkip!(AMBIENT_ACCOUNT_KEY)).toBe(false);
  });

  it("still lets a mark lapse when nothing renews it", () => {
    markCodexAccountAuthFailed("a", "401");
    now += 5 * MIN + 15 * MIN + 1;
    expect(isCodexAccountAuthFailed("a")).toBe(false);
    expect(isCodexAccountAuthRecheckPending("a")).toBe(false);
  });
});
