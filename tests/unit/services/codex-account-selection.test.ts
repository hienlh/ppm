import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCodexAccount, removeCodexAccount, listCodexAccounts,
  selectCodexAccount, resolveCodexAccountForSession,
  peekCodexAccount, setCodexAccountStatus,
} from "../../../src/services/codex-account.service.ts";
import { setSessionCodexAccount } from "../../../src/services/db.service.ts";

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
