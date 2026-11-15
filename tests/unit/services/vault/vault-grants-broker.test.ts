/**
 * Unlocking: the secure tier's window is for one chat and the ticked items only and ends on the
 * clock; the sealed tier never stays open; the cards follow the turn's origin (no secure card from
 * Telegram, a sealed value only shown to the user there, nothing for an unattended turn), keep
 * waiting on a wrong password, and allow one card per chat.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { createVaultAttempts } from "../../../../src/services/vault/vault-attempts.ts";
import { createVaultGrants, SETTINGS_HOLDER } from "../../../../src/services/vault/vault-grants.ts";
import { createVaultService } from "../../../../src/services/vault/vault.service.ts";
import { createVaultUnlockBroker, type VaultCardEvent } from "../../../../src/services/vault/vault-unlock-broker.ts";
import { newDek } from "../../../../src/services/vault/vault-crypto.ts";

const MK2 = "secure-pass-0001";
const MK3 = "sealed-password-0001";
let clock = 1_000_000;
const now = () => clock;

function setup() {
  getDb().exec("DELETE FROM vault_items; DELETE FROM vault_keys;");
  clock = 1_000_000;
  const service = createVaultService({ now, kdfParams: () => ({ N: 1024, r: 8, p: 1 }), attempts: createVaultAttempts({ now }) });
  const grants = createVaultGrants({ now, canonical: (id) => (id === "old-id" ? "new-id" : id) });
  const shown: VaultCardEvent[] = [];
  const resolved: string[] = [];
  let chatOpen = true;
  const broker = createVaultUnlockBroker({
    service, grants, now,
    canonical: (id) => (id === "old-id" ? "new-id" : id),
    chat: () => ({ announce: (_s, e) => { if (chatOpen) shown.push(e); return chatOpen; }, resolved: (_s, id) => { resolved.push(id); } }),
  });
  return { service, grants, broker, shown, resolved, closeChat: () => { chatOpen = false; } };
}

const ws = { origin: "ws", sessionTitle: "My chat", assistant: false };
const tg = { origin: "telegram", sessionTitle: "My chat", assistant: true };

async function seed(s: ReturnType<typeof setup>) {
  await s.service.enableTier("secure", MK2);
  await s.service.enableTier("sealed", MK3);
  const u2 = await s.service.unlock("secure", MK2);
  const u3 = await s.service.unlock("sealed", MK3);
  if (!u2.ok || !u3.ok) throw new Error("seed");
  const a = s.service.addItem({ tier: "secure", name: "NI", kind: "ni_number", value: "CANARY-T2-a" }, u2.dek);
  const b = s.service.addItem({ tier: "secure", name: "Address", kind: "address", value: "CANARY-T2-b" }, u2.dek);
  const c = s.service.addItem({ tier: "secure", name: "Other", kind: "other", value: "CANARY-T2-c" }, u2.dek);
  const p = s.service.addItem({ tier: "sealed", name: "Passport", kind: "passport", value: "CANARY-T3-p" }, u3.dek);
  u2.dek.fill(0); u3.dek.fill(0);
  return { a, b, c, p };
}

describe("grants", () => {
  it("takes the key (zeroing the caller's buffer), covers one chat and the ticked items, and ends on the clock", () => {
    const g = createVaultGrants({ now });
    const dek = newDek();
    const copy = Buffer.from(dek);
    g.openWindow("secure", "s1", ["a", "b"], 5, dek);
    expect(dek.every((x) => x === 0)).toBe(true);
    expect(g.keyFor("secure", "s1", ["a"])?.equals(copy)).toBe(true);
    expect(g.keyFor("secure", "s1", ["a", "c"])).toBeNull();
    expect(g.keyFor("secure", "s2", ["a"])).toBeNull();
    expect(g.keyFor("secure", SETTINGS_HOLDER, null)).toBeNull();
    clock += 5 * 60_000;
    expect(g.keyFor("secure", "s1", ["a"])).toBeNull();
    expect(g.list()).toEqual([]);
  });

  it("never opens the sealed tier, nor a window of another length", () => {
    const g = createVaultGrants({ now });
    expect(() => g.openWindow("sealed", "s1", ["a"], 5, newDek())).toThrow();
    expect(() => g.openSettings("sealed", newDek())).toThrow();
    expect(() => g.openWindow("secure", "s1", ["a"], 30, newDek())).toThrow();
    expect(g.list()).toEqual([]);
  });

  it("lock and lockSession end grants", () => {
    const g = createVaultGrants({ now });
    g.openWindow("secure", "s1", ["a"], 15, newDek());
    g.openSettings("secure", newDek());
    expect(g.settingsOpenUntil("secure")).toBe(clock + 5 * 60_000);
    g.lockSession("s1");
    expect(g.keyFor("secure", "s1", ["a"])).toBeNull();
    expect(g.lock()).toBe(1);
    expect(g.settingsOpenUntil("secure")).toBe(0);
  });
});

describe("vault cards", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("lists every secure item with the requested ones ticked, and gives the ticked ones once", async () => {
    const { a, b, c } = await seed(s);
    const outcome = s.broker.requestSecure("s1", [a.id], "fill the form", ws);
    const card = s.shown[0]!;
    expect(card.input.kind).toBe("read-secure");
    if (card.input.kind !== "read-secure") throw new Error();
    expect(card.input.items.map((i) => i.name).sort()).toEqual(["Address", "NI", "Other"]);
    expect(card.input.requested).toEqual([a.id]);
    expect(JSON.stringify(card)).not.toContain("CANARY");

    // A second card in the same chat waits its turn.
    expect((await s.broker.requestSealed("s1", "x", "p", ws)).ok).toBe(false);

    const wrong = await s.broker.answer(card.requestId, { approved: true, password: "nope-nope-nope", itemIds: [a.id, b.id] });
    expect(wrong.ok === false && wrong.status).toBe(403);
    expect(wrong.ok === false && wrong.attemptsLeft).toBe(4);
    expect(s.broker.has(card.requestId)).toBe(true);
    // An item outside the card (or of another tier) is refused.
    const outside = await s.broker.answer(card.requestId, { approved: true, password: MK2, itemIds: ["nope"] });
    expect(outside.ok === false && outside.status).toBe(400);

    expect((await s.broker.answer(card.requestId, { approved: true, password: MK2, itemIds: [a.id, b.id] })).ok).toBe(true);
    const r = await outcome;
    expect(r.ok && "items" in r && r.items.map((i) => i.value).sort()).toEqual(["CANARY-T2-a", "CANARY-T2-b"]);
    expect(s.grants.list()).toEqual([]);
    void c;
  });

  it("a window covers this chat's ticked items only", async () => {
    const { a, b, c } = await seed(s);
    const outcome = s.broker.requestSecure("old-id", [a.id], "p", ws);
    await s.broker.answer(s.shown[0]!.requestId, { approved: true, password: MK2, itemIds: [a.id, b.id], mode: "window", minutes: 10 });
    expect((await outcome).ok).toBe(true);
    // Codex renamed the chat: the window follows it.
    expect(s.grants.keyFor("secure", "new-id", [a.id, b.id])).not.toBeNull();
    expect(s.grants.keyFor("secure", "new-id", [c.id])).toBeNull();
    expect(s.grants.keyFor("secure", "other", [a.id])).toBeNull();
  });

  it("refuses the secure tier from Telegram without a card, and unattended turns entirely", async () => {
    const { a, p } = await seed(s);
    const r = await s.broker.requestSecure("s1", [a.id], "p", tg);
    expect(r.ok === false && r.reason).toBe("refused");
    expect((await s.broker.requestSealed("s1", p.id, "p", { ...ws, origin: "watch" })).ok).toBe(false);
    expect((await s.broker.requestPropose("s1", { name: "x", kind: "other", tier: "public", value: null }, { ...ws, origin: "schedule" })).ok).toBe(false);
    expect(s.shown).toEqual([]);
  });

  it("a sealed item is shown to the user by default, and from Telegram can only be shown", async () => {
    const { p } = await seed(s);
    const outcome = s.broker.requestSealed("s1", p.id, "check passport", ws);
    const card = s.shown[0]!;
    const answered = await s.broker.answer(card.requestId, { approved: true, password: MK3 });
    expect(answered.ok && answered.result.shown?.value).toBe("CANARY-T3-p");
    const r = await outcome;
    expect(JSON.stringify(r)).not.toContain("CANARY");
    expect(r.ok && "shownToUser" in r).toBe(true);
    expect(s.grants.list()).toEqual([]);

    const fromTg = s.broker.requestSealed("s1", p.id, "p", tg);
    const tgCard = s.shown[1]!;
    expect(tgCard.input.kind === "read-sealed" && tgCard.input.allowGiveToAi).toBe(false);
    const refused = await s.broker.answer(tgCard.requestId, { approved: true, password: MK3, giveToAi: true });
    expect(refused.ok === false && refused.status).toBe(400);
    await s.broker.answer(tgCard.requestId, { approved: false });
    expect((await fromTg).ok).toBe(false);
  });

  it("gives a sealed value to the AI only when the user says so", async () => {
    const { p } = await seed(s);
    const outcome = s.broker.requestSealed("s1", p.id, "p", ws);
    await s.broker.answer(s.shown[0]!.requestId, { approved: true, password: MK3, giveToAi: true });
    const r = await outcome;
    expect(r.ok && "items" in r && r.items[0]!.value).toBe("CANARY-T3-p");
  });

  it("caps cards per chat and hour, and ends a card the user moved past", async () => {
    const { p } = await seed(s);
    for (let i = 0; i < 3; i++) {
      const o = s.broker.requestSealed("s1", p.id, "p", ws);
      expect(s.broker.cancelSession("s1", "user typed")).toBe(true);
      expect((await o).ok).toBe(false);
    }
    const fourth = await s.broker.requestSealed("s1", p.id, "p", ws);
    expect(fourth.ok === false && fourth.reason).toBe("rate-limited");
    clock += 3_600_001;
    const o = s.broker.requestSealed("s1", p.id, "p", ws);
    expect(s.broker.pendingEvent("s1")).not.toBeNull();
    await s.broker.answer(s.broker.pendingEvent("s1")!.requestId, { approved: false });
    expect((await o).ok).toBe(false);
  });

  it("a proposal keeps its prefilled value off the card and saves into the tier the user picked", async () => {
    await seed(s);
    const outcome = s.broker.requestPropose("s1", { name: "Bank", kind: "other", tier: "secure", value: "CANARY-T2-prefill" }, ws);
    const card = s.shown[0]!;
    expect(JSON.stringify(card)).not.toContain("CANARY");
    expect(s.broker.prefill(card.requestId)).toBe("CANARY-T2-prefill");
    const r = await s.broker.answer(card.requestId, { approved: true, tier: "sealed", password: MK3 });
    expect(r.ok).toBe(true);
    const saved = await outcome;
    expect(saved.ok && "saved" in saved && saved.saved.tier).toBe("sealed");
  });

  it("settles as no-chat when the chat is not open in PPM", async () => {
    const { a } = await seed(s);
    s.closeChat();
    const r = await s.broker.requestSecure("s1", [a.id], "p", ws);
    expect(r.ok === false && r.reason).toBe("no-chat");
  });
});
