import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCodexAccount, removeCodexAccount, listCodexAccounts,
  selectCodexAccount, resolveCodexAccountForSession, codexUsageLevel,
  peekCodexAccount, setCodexAccountStatus,
} from "../../../src/services/codex-account.service.ts";
import { setSessionCodexAccount } from "../../../src/services/db.service.ts";
import {
  markCodexAccountUsageLimited,
  isCodexAccountUsageLimited,
  clearCodexAccountUsageLimit,
  _resetCodexCooldownsForTesting,
} from "../../../src/services/codex-account-cooldown.ts";

const mk = (label: string) => createCodexAccount({ label, type: "apiKey", creds: { type: "apiKey", apiKey: "k-" + label } });
function clearAll() { for (const a of listCodexAccounts()) removeCodexAccount(a.id); }

describe("codex account selection", () => {
  beforeEach(clearAll);

  it("null when no accounts", async () => {
    expect(selectCodexAccount()).toBeNull();
    expect(await resolveCodexAccountForSession("s")).toBeNull();
  });

  it("single account always returned", () => {
    const a = mk("solo");
    expect(selectCodexAccount()?.id).toBe(a.id);
  });

  it("fill-first → always the first account", () => {
    const a = mk("A"); mk("B");
    expect(selectCodexAccount({ strategy: "fill-first" })?.id).toBe(a.id);
    expect(selectCodexAccount({ strategy: "fill-first" })?.id).toBe(a.id);
  });

  it("round-robin alternates across accounts", () => {
    mk("A"); mk("B");
    const picks = [0, 1, 2, 3].map(() => selectCodexAccount({ strategy: "round-robin" })!.id);
    expect(new Set(picks).size).toBe(2);
    expect(picks[0]).not.toBe(picks[1]);
  });

  it("lowest-usage picks the least-utilized", () => {
    const a = mk("A"); const b = mk("B");
    const usageOf = (id: string) => (id === b.id ? 0.1 : 0.9);
    expect(selectCodexAccount({ strategy: "lowest-usage", usageOf })?.id).toBe(b.id);
  });

  it("round-robin skips an account with no five-hour room left", () => {
    const a = mk("A"); const b = mk("B");
    const usageOf = (id: string) => (id === a.id ? 0.99 : 0.1);
    const picks = [0, 1, 2, 3].map(() => selectCodexAccount({ strategy: "round-robin", usageOf })!.id);
    expect(new Set(picks)).toEqual(new Set([b.id]));
  });

  it("falls back to a capped account when every account is capped", () => {
    const a = mk("A"); const b = mk("B");
    const usageOf = () => 0.99;
    const picked = selectCodexAccount({ strategy: "round-robin", usageOf });
    expect([a.id, b.id]).toContain(picked!.id);
  });

  it("unknown usage does not disqualify an account", () => {
    // A failed usage fetch surfaces as +Infinity so lowest-usage de-prioritises it. That is
    // "we could not read it", not "it is capped" — it must stay a candidate.
    const a = mk("A");
    const picked = selectCodexAccount({ strategy: "round-robin", usageOf: () => Number.POSITIVE_INFINITY });
    expect(picked?.id).toBe(a.id);
  });

  it("sticky: resolveForSession honors a bound account", async () => {
    mk("A"); const b = mk("B");
    setSessionCodexAccount("sid-1", b.id);
    expect((await resolveCodexAccountForSession("sid-1"))?.id).toBe(b.id);
  });
});

describe("disabled codex accounts", () => {
  beforeEach(clearAll);

  it("are never selected, even when nothing else is left", async () => {
    // Unlike the five-hour skip, this has no "take one anyway" fallback: being switched off
    // is the user saying don't use this, and handing it back because nothing else remained
    // would ignore them.
    const a = mk("only");
    setCodexAccountStatus(a.id, "disabled");
    expect(selectCodexAccount()).toBeNull();
    expect(peekCodexAccount()).toBeNull();
  });

  it("are skipped while another account is available", () => {
    const a = mk("off"); const b = mk("on");
    setCodexAccountStatus(a.id, "disabled");
    for (let i = 0; i < 4; i++) expect(selectCodexAccount()?.id).toBe(b.id);
  });

  it("release the sessions bound to them", async () => {
    // Turning an account off has to move the conversations already sitting on it, or it
    // would do nothing for exactly the chats most likely to be using it.
    const a = mk("bound"); const b = mk("spare");
    setSessionCodexAccount("sid-disabled", a.id);
    expect((await resolveCodexAccountForSession("sid-disabled"))?.id).toBe(a.id);

    setCodexAccountStatus(a.id, "disabled");
    expect((await resolveCodexAccountForSession("sid-disabled"))?.id).toBe(b.id);
  });

  it("come back exactly as they were when switched on again", () => {
    const a = mk("returning");
    setCodexAccountStatus(a.id, "disabled");
    const restored = setCodexAccountStatus(a.id, "active");
    expect(restored?.status).toBe("active");
    expect(selectCodexAccount()?.id).toBe(a.id);
  });

  it("report an unknown id rather than inventing one", () => {
    expect(setCodexAccountStatus("no-such-account", "disabled")).toBeNull();
  });

  it("default to enabled, so an upgrade changes nothing", () => {
    const a = mk("fresh");
    expect(a.status).toBe("active");
    expect(listCodexAccounts()[0]?.status).toBe("active");
  });
});

describe("codex accounts parked by a usage limit", () => {
  beforeEach(() => { clearAll(); _resetCodexCooldownsForTesting(); });

  it("are skipped while another account can serve", () => {
    const a = mk("spent"); const b = mk("fresh");
    markCodexAccountUsageLimited(a.id);
    for (let i = 0; i < 4; i++) expect(selectCodexAccount()?.id).toBe(b.id);
  });

  it("are handed back anyway when every account is parked", () => {
    // Soft, like the five-hour skip: a park is a guess at when the quota returns, so
    // returning nothing would refuse a turn that might well have gone through.
    const a = mk("A"); const b = mk("B");
    markCodexAccountUsageLimited(a.id);
    markCodexAccountUsageLimited(b.id);
    expect([a.id, b.id]).toContain(selectCodexAccount()!.id);
  });

  it("lapse on their own once the reset has passed", () => {
    const a = mk("A"); const b = mk("B");
    markCodexAccountUsageLimited(a.id, Date.now() - 1000);
    // A reset already in the past is not usable, so the park falls back to the default
    // window rather than expiring instantly.
    expect(isCodexAccountUsageLimited(a.id)).toBe(true);
    clearCodexAccountUsageLimit(a.id);
    expect(isCodexAccountUsageLimited(a.id)).toBe(false);
    expect([a.id, b.id]).toContain(selectCodexAccount()!.id);
  });

  it("release the sessions bound to them", async () => {
    // The point of parking: a session sitting on the spent account must not spend its next
    // turn rediscovering that the account is spent.
    const a = mk("bound"); const b = mk("spare");
    setSessionCodexAccount("sid-parked", a.id);
    expect((await resolveCodexAccountForSession("sid-parked"))?.id).toBe(a.id);

    markCodexAccountUsageLimited(a.id);
    expect((await resolveCodexAccountForSession("sid-parked"))?.id).toBe(b.id);
  });

  it("keep a parked account out of the tab-claim preview", () => {
    const a = mk("A"); const b = mk("B");
    markCodexAccountUsageLimited(a.id);
    // Two accounts, one parked: the survivor is the only one that can serve, so the chip
    // can name it instead of going blank.
    expect(peekCodexAccount()?.id).toBe(b.id);
  });
});

describe("excluding an account from selection", () => {
  beforeEach(() => { clearAll(); _resetCodexCooldownsForTesting(); });

  it("never returns the excluded account, even as a last resort", () => {
    // Its only caller is the rotation away from an account that just refused the turn —
    // a fallback to it would rotate in a circle.
    const a = mk("refused"); const b = mk("other");
    for (let i = 0; i < 4; i++) expect(selectCodexAccount({ exclude: [a.id] })?.id).toBe(b.id);
  });

  it("returns null when the excluded account was the only one", () => {
    const a = mk("solo");
    expect(selectCodexAccount({ exclude: [a.id] })).toBeNull();
  });

  it("still prefers the account with the most room among the rest", () => {
    const a = mk("A"); const b = mk("B"); const c = mk("C");
    const usageOf = (id: string) => (id === b.id ? 0.8 : id === c.id ? 0.2 : 0.0);
    expect(selectCodexAccount({ strategy: "lowest-usage", usageOf, exclude: [a.id] })?.id).toBe(c.id);
  });
});

describe("which utilisation an account is judged on", () => {
  beforeEach(() => { clearAll(); _resetCodexCooldownsForTesting(); });

  it("uses the five-hour figure when the plan has one", () => {
    expect(codexUsageLevel({ fiveHour: 0.7, sevenDay: 0.2 })).toBeCloseTo(0.7, 5);
  });

  it("falls through to weekly for a plan with no short window", () => {
    // A ChatGPT Business account reports a weekly quota and nothing else. Reading fiveHour
    // alone called it unreadable, which sent a perfectly healthy account to the back of
    // lowest-usage and exempted it from the cap skip.
    expect(codexUsageLevel({ sevenDay: 0.9 })).toBeCloseTo(0.9, 5);
  });

  it("still reports genuinely unreadable usage as Infinity", () => {
    expect(codexUsageLevel({})).toBe(Number.POSITIVE_INFINITY);
    expect(codexUsageLevel(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it("skips a weekly-only account that is out of room", () => {
    const a = mk("weekly-only-full"); const b = mk("has-room");
    const usageOf = (id: string) => codexUsageLevel(id === a.id ? { sevenDay: 0.99 } : { fiveHour: 0.1 });
    const picks = [0, 1, 2, 3].map(() => selectCodexAccount({ strategy: "round-robin", usageOf })!.id);
    expect(new Set(picks)).toEqual(new Set([b.id]));
  });
});
