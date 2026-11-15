/**
 * The AI's vault tools: list never carries a value, a public read answers at once, a secure read
 * shows a card unless this chat's window covers the items, a sealed read takes one item, and the
 * tools are off by default for an ordinary chat.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { createVaultAttempts } from "../../../../src/services/vault/vault-attempts.ts";
import { createVaultGrants } from "../../../../src/services/vault/vault-grants.ts";
import { createVaultService } from "../../../../src/services/vault/vault.service.ts";
import { createVaultUnlockBroker, type VaultCardEvent } from "../../../../src/services/vault/vault-unlock-broker.ts";
import { createVaultTools } from "../../../../src/services/vault/vault-tools.ts";
import { ppmToolOn } from "../../../../src/shared/ppm-tools.ts";

const MK2 = "secure-pass-0001";
const MK3 = "sealed-password-0001";
const signal = new AbortController().signal;
const text = (r: Record<string, unknown>) => ((r.content as { text: string }[])[0]!.text);

let origin: string | undefined = "ws";
function setup() {
  getDb().exec("DELETE FROM vault_items; DELETE FROM vault_keys;");
  const service = createVaultService({ kdfParams: () => ({ N: 1024, r: 8, p: 1 }), attempts: createVaultAttempts() });
  const grants = createVaultGrants();
  const shown: VaultCardEvent[] = [];
  const broker = createVaultUnlockBroker({ service, grants, chat: () => ({ announce: (_s, e) => { shown.push(e); return true; }, resolved: () => {} }) });
  const held: string[] = [];
  const tools = createVaultTools({ service, grants, broker, turnOrigin: () => origin, hold: (_s, items) => held.push(...items.map((i) => i.value)) });
  return { service, grants, broker, shown, held, tools };
}

const caller = { sessionId: "s1", title: "Chat", assistant: false };

describe("vault tools", () => {
  let s: ReturnType<typeof setup>;
  let ids: Record<string, string>;
  beforeEach(async () => {
    origin = "ws";
    s = setup();
    await s.service.enableTier("secure", MK2);
    await s.service.enableTier("sealed", MK3);
    const u2 = await s.service.unlock("secure", MK2);
    const u3 = await s.service.unlock("sealed", MK3);
    if (!u2.ok || !u3.ok) throw new Error("seed");
    ids = {
      pub: s.service.addItem({ tier: "public", name: "Company", kind: "other", value: "CANARY-T1-co" }).id,
      ni: s.service.addItem({ tier: "secure", name: "NI", kind: "ni_number", value: "CANARY-T2-ni" }, u2.dek).id,
      addr: s.service.addItem({ tier: "secure", name: "Address", kind: "address", value: "CANARY-T2-addr" }, u2.dek).id,
      pp: s.service.addItem({ tier: "sealed", name: "Passport", kind: "passport", value: "CANARY-T3-pp" }, u3.dek).id,
    };
    u2.dek.fill(0); u3.dek.fill(0);
  });

  it("lists names, kinds and tiers, never a value of any tier", async () => {
    const r = text(await s.tools.call(caller, "vault_list", {}, signal));
    expect(r).toContain("Passport");
    expect(r).not.toContain("CANARY");
  });

  it("reads the public tier at once by id or by name, without holding it", async () => {
    const r = text(await s.tools.call(caller, "vault_read", { items: ["company"], purpose: "letter head" }, signal));
    expect(r).toContain("CANARY-T1-co");
    expect(s.shown).toEqual([]);
    expect(s.held).toEqual([]);
  });

  it("refuses a read across tiers and more than one sealed item", async () => {
    expect(text(await s.tools.call(caller, "vault_read", { items: [ids.pub!, ids.ni!], purpose: "x" }, signal))).toContain("one tier");
    expect(text(await s.tools.call(caller, "vault_read", { items: ["nope"], purpose: "x" }, signal))).toContain("vault_list");
  });

  it("a secure read shows a card, holds what it gave, and a window then answers without one", async () => {
    const pending = s.tools.call(caller, "vault_read", { items: [ids.ni!], purpose: "form" }, signal);
    await Bun.sleep(5);
    const card = s.shown[0]!;
    await s.broker.answer(card.requestId, { approved: true, password: MK2, itemIds: [ids.ni!, ids.addr!], mode: "window", minutes: 5 });
    expect(text(await pending)).toContain("CANARY-T2-ni");
    expect(s.held).toContain("CANARY-T2-ni");
    const again = text(await s.tools.call(caller, "vault_read", { items: [ids.addr!], purpose: "form" }, signal));
    expect(again).toContain("CANARY-T2-addr");
    expect(s.shown.length).toBe(1);
    // Another chat gets a card of its own.
    void s.tools.call({ ...caller, sessionId: "s2" }, "vault_read", { items: [ids.addr!], purpose: "x" }, signal);
    await Bun.sleep(5);
    expect(s.shown.length).toBe(2);
    s.broker.cancelSession("s2", "done");
  });

  it("from a Telegram turn a secure read is refused and the window is not used", async () => {
    s.grants.openWindow("secure", "s1", [ids.ni!], 5, (await s.service.unlock("secure", MK2) as { dek: Buffer }).dek);
    origin = "telegram";
    const r = text(await s.tools.call(caller, "vault_read", { items: [ids.ni!], purpose: "x" }, signal));
    expect(r).not.toContain("CANARY");
    expect(r).toContain("PPM");
  });

  it("a sealed read shown only to the user gives the AI no value", async () => {
    const pending = s.tools.call(caller, "vault_read", { items: [ids.pp!], purpose: "check" }, signal);
    await Bun.sleep(5);
    const answered = await s.broker.answer(s.shown[0]!.requestId, { approved: true, password: MK3 });
    expect(answered.ok && answered.result.shown?.value).toBe("CANARY-T3-pp");
    const r = text(await pending);
    expect(r).not.toContain("CANARY");
    expect(s.held).toEqual([]);
  });

  it("is off by default for an ordinary chat", () => {
    expect(ppmToolOn({}, "vault_read")).toBe(false);
    expect(ppmToolOn({ ppm_tools: { vault_read: true } }, "vault_read")).toBe(true);
  });
});
