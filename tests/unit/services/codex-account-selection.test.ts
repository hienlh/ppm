import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCodexAccount, removeCodexAccount, listCodexAccounts,
  selectCodexAccount, resolveCodexAccountForSession,
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

  it("sticky: resolveForSession honors a bound account", async () => {
    mk("A"); const b = mk("B");
    setSessionCodexAccount("sid-1", b.id);
    expect((await resolveCodexAccountForSession("sid-1"))?.id).toBe(b.id);
  });
});
