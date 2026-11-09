/**
 * Pure functions for ordering and querying accounts in the switch-account menu:
 * current first (even if out of usage), usable by most headroom, refused folded away.
 */
import { describe, expect, it } from "bun:test";
import { orderSwitchAccounts, matchesAccountQuery, usageTone, claudeSwitchAccount, codexSwitchAccount, highestPct } from "../../../src/web/lib/chat-account-switch";
import type { SwitchAccount } from "../../../src/web/lib/chat-account-switch";

describe("orderSwitchAccounts", () => {
  const accounts: SwitchAccount[] = [
    { id: "a", label: "Alice", plan: null, fiveHourPct: 50, weekPct: 60, refusal: null, signedOut: false },
    { id: "b", label: "Bob", plan: null, fiveHourPct: 80, weekPct: 70, refusal: null, signedOut: false },
    { id: "c", label: "Charlie", plan: null, fiveHourPct: 30, weekPct: 40, refusal: "5-hour limit reached", signedOut: false },
    { id: "d", label: "Diana", plan: null, fiveHourPct: 100, weekPct: 95, refusal: "5-hour limit reached", signedOut: false },
  ];

  it("puts current first, even when it is out of usage", () => {
    const { usable, outOfUsage } = orderSwitchAccounts(accounts, "c");
    // c is current (out of usage), so it comes first despite the refusal.
    expect(usable[0]?.id).toBe("c");
    expect(outOfUsage.map((a) => a.id)).toEqual(["d"]);
  });

  it("orders usable accounts by most headroom (highest pct first = most headroom)", () => {
    const { usable } = orderSwitchAccounts(accounts, null);
    // Alice (60% max), Bob (80% max), Charlie (40% max).
    expect(usable.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("puts refused accounts into outOfUsage", () => {
    const { usable, outOfUsage } = orderSwitchAccounts(accounts, null);
    expect(usable.map((a) => a.id)).toEqual(["a", "b"]);
    expect(outOfUsage.map((a) => a.id)).toEqual(["c", "d"]);
  });

  it("current account comes first even if usable ones have more headroom", () => {
    const { usable } = orderSwitchAccounts(accounts, "b");
    // Bob (80% max) is current, then Alice (60% max).
    expect(usable.map((a) => a.id)).toEqual(["b", "a"]);
  });
});

describe("claudeSwitchAccount", () => {
  it("sets refusal to 'Signed out' when reauthRequired", () => {
    const account = claudeSwitchAccount(
      { accountId: "a", accountLabel: "Alice", accountStatus: "active", usage: { session: { utilization: 0.5 } } },
      { label: "Alice", email: "alice@example.com", reauthRequired: true },
    );
    expect(account.refusal).toContain("Signed out");
    expect(account.signedOut).toBe(true);
  });

  it("sets refusal when at 5-hour limit (100%)", () => {
    const account = claudeSwitchAccount(
      { accountId: "a", accountLabel: "Alice", accountStatus: "active", usage: { session: { utilization: 1 } } },
    );
    expect(account.refusal).toContain("5-hour limit reached");
  });

  it("does not refuse at 99%", () => {
    const account = claudeSwitchAccount(
      { accountId: "a", accountLabel: "Alice", accountStatus: "active", usage: { session: { utilization: 0.99 } } },
    );
    expect(account.refusal).toBeNull();
  });
});

describe("codexSwitchAccount", () => {
  it("sets refusal when signedOut and type is 'chatgpt'", () => {
    const account = codexSwitchAccount(
      { id: "c1", label: "ChatGPT Account", type: "chatgpt", signedOut: true },
      { sevenDay: 0.5 },
      null,
    );
    expect(account.refusal).toContain("Signed out");
    expect(account.signedOut).toBe(true);
  });

  it("does not mark signedOut when type is not 'chatgpt'", () => {
    const account = codexSwitchAccount(
      { id: "c2", label: "Non-ChatGPT", type: "other", signedOut: true },
      { sevenDay: 0.5 },
      null,
    );
    expect(account.refusal).toContain("Signed out");
    expect(account.signedOut).toBe(false);
  });
});

describe("matchesAccountQuery", () => {
  const account: SwitchAccount = {
    id: "a",
    label: "Alice Pro",
    plan: "Plus",
    fiveHourPct: 50,
    weekPct: 60,
    refusal: null,
    signedOut: false,
  };

  it("matches by name case-insensitively", () => {
    expect(matchesAccountQuery(account, "alice")).toBe(true);
    expect(matchesAccountQuery(account, "ALICE")).toBe(true);
    expect(matchesAccountQuery(account, "pro")).toBe(true);
  });

  it("matches by plan", () => {
    expect(matchesAccountQuery(account, "plus")).toBe(true);
  });

  it("returns true for empty query", () => {
    expect(matchesAccountQuery(account, "")).toBe(true);
    expect(matchesAccountQuery(account, "   ")).toBe(true);
  });

  it("returns false for non-matching query", () => {
    expect(matchesAccountQuery(account, "bob")).toBe(false);
  });
});

describe("usageTone", () => {
  it("returns 'ok' below 70%", () => {
    expect(usageTone(0)).toBe("ok");
    expect(usageTone(50)).toBe("ok");
    expect(usageTone(69)).toBe("ok");
  });

  it("returns 'warn' from 70% to 89%", () => {
    expect(usageTone(70)).toBe("warn");
    expect(usageTone(75)).toBe("warn");
    expect(usageTone(89)).toBe("warn");
  });

  it("returns 'error' at 90% and above", () => {
    expect(usageTone(90)).toBe("error");
    expect(usageTone(95)).toBe("error");
    expect(usageTone(100)).toBe("error");
  });

  it("returns 'ok' for null", () => {
    expect(usageTone(null)).toBe("ok");
  });
});

describe("highestPct", () => {
  it("returns the maximum of fiveHourPct and weekPct", () => {
    expect(highestPct({ fiveHourPct: 50, weekPct: 75 })).toBe(75);
    expect(highestPct({ fiveHourPct: 90, weekPct: 50 })).toBe(90);
  });

  it("returns the one that is not null", () => {
    expect(highestPct({ fiveHourPct: 50, weekPct: null })).toBe(50);
    expect(highestPct({ fiveHourPct: null, weekPct: 75 })).toBe(75);
  });

  it("returns null when both are null", () => {
    expect(highestPct({ fiveHourPct: null, weekPct: null })).toBeNull();
  });
});
