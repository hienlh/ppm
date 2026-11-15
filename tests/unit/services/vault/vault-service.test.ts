/**
 * The vault service over the real migration: the three tiers stored as the plan says, the two
 * passwords kept apart (and apart from PPM's own), wrong-password counters per tier that survive
 * a reopened database, and tampering with the `tier` column failing closed.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { Database } from "bun:sqlite";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, getDb, runMigrations } from "../../../../src/services/db.service.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { createVaultAttempts, lockoutMs, ATTEMPT_POLICY } from "../../../../src/services/vault/vault-attempts.ts";
import { createVaultService, VaultError } from "../../../../src/services/vault/vault.service.ts";

const FAST = () => ({ N: 1024, r: 8, p: 1 });
const MK2 = "secure-pass-0001";
const MK3 = "sealed-password-0001";

let clock = 1_000_000;
const now = () => clock;
const make = (kdf = FAST) => createVaultService({ now, kdfParams: kdf, attempts: createVaultAttempts({ now }) });

function reset() {
  getDb().exec("DELETE FROM vault_items; DELETE FROM vault_keys;");
  clock = 1_000_000;
}

async function dekOf(svc: ReturnType<typeof make>, tier: "secure" | "sealed", pw: string): Promise<Buffer> {
  const r = await svc.unlock(tier, pw);
  if (!r.ok) throw new Error(r.message);
  return r.dek;
}

describe("migration 73", () => {
  it("creates both tables at the current schema version", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(73);
    const names = (getDb().query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["vault_keys", "vault_items"]));
  });

  it("refuses a public row with ciphertext and a locked row with plain text", () => {
    const db = getDb();
    expect(() => db.query("INSERT INTO vault_items (id,tier,name,kind,value_plain,ciphertext,nonce,created_at,updated_at) VALUES ('a','public','n','other','v',x'00',x'00',1,1)").run()).toThrow();
    expect(() => db.query("INSERT INTO vault_items (id,tier,name,kind,value_plain,ciphertext,nonce,created_at,updated_at) VALUES ('b','secure','n','other','v',x'00',x'00',1,1)").run()).toThrow();
    expect(() => db.query("INSERT INTO vault_items (id,tier,name,kind,value_plain,ciphertext,nonce,created_at,updated_at) VALUES ('c','sealed','n','other',NULL,NULL,NULL,1,1)").run()).toThrow();
    expect(() => db.query("INSERT INTO vault_keys (tier,kdf,kdf_params,salt,dek_nonce,wrapped_dek,created_at) VALUES ('public','scrypt','{}',x'00',x'00',x'00',1)").run()).toThrow();
  });

  it("upgrades a database at schema 72 without touching other rows", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    db.exec("DROP TABLE vault_items; DROP TABLE vault_keys; PRAGMA user_version = 72");
    db.query("INSERT INTO config (key, value) VALUES ('kept', '1')").run();
    runMigrations(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(73);
    expect(db.query("SELECT value FROM config WHERE key='kept'").get()).toEqual({ value: "1" });
    db.close();
  });
});

describe("vault service", () => {
  beforeEach(reset);

  it("stores the public tier as plain text and the locked tiers only as ciphertext", async () => {
    const svc = make();
    await svc.enableTier("secure", MK2);
    await svc.enableTier("sealed", MK3);
    const t1 = svc.addItem({ tier: "public", name: "Company", kind: "other", value: "CANARY-T1-acme" });
    const k2 = await dekOf(svc, "secure", MK2);
    const t2 = svc.addItem({ tier: "secure", name: "NI", kind: "ni_number", value: "CANARY-T2-ni" }, k2);
    const k3 = await dekOf(svc, "sealed", MK3);
    const t3 = svc.addItem({ tier: "sealed", name: "Passport", kind: "passport", value: "CANARY-T3-pp" }, k3);

    const raw = getDb().query("SELECT id, value_plain, ciphertext FROM vault_items").all() as { id: string; value_plain: string | null; ciphertext: Uint8Array | null }[];
    const dump = raw.map((r) => `${r.value_plain ?? ""}${r.ciphertext ? Buffer.from(r.ciphertext).toString("latin1") : ""}`).join("|");
    expect(dump).toContain("CANARY-T1-acme");
    expect(dump).not.toContain("CANARY-T2");
    expect(dump).not.toContain("CANARY-T3");

    expect(svc.readPublic([t1.id])[0]!.value).toBe("CANARY-T1-acme");
    expect(svc.readLocked("secure", [t2.id], k2)[0]!.value).toBe("CANARY-T2-ni");
    expect(svc.readLocked("sealed", [t3.id], k3)[0]!.value).toBe("CANARY-T3-pp");
    // Each tier's key opens only its own tier's items.
    expect(() => svc.readLocked("secure", [t3.id], k2)).toThrow(VaultError);
    expect(() => svc.readLocked("sealed", [t3.id], k2)).toThrow(VaultError);
    expect(svc.listItems().map((i) => i.name).sort()).toEqual(["Company", "NI", "Passport"]);
    expect(JSON.stringify(svc.listItems())).not.toContain("CANARY");
  });

  it("fails closed when the tier column of a sealed item is changed to secure", async () => {
    const svc = make();
    await svc.enableTier("secure", MK2);
    await svc.enableTier("sealed", MK3);
    const k3 = await dekOf(svc, "sealed", MK3);
    const item = svc.addItem({ tier: "sealed", name: "x", kind: "other", value: "CANARY-T3" }, k3);
    getDb().query("UPDATE vault_items SET tier = 'secure' WHERE id = ?").run(item.id);
    const k2 = await dekOf(svc, "secure", MK2);
    expect(() => svc.readLocked("secure", [item.id], k2)).toThrow(/does not open/);
  });

  it("fails closed when ciphertexts are swapped between two items", async () => {
    const svc = make();
    await svc.enableTier("secure", MK2);
    const k = await dekOf(svc, "secure", MK2);
    const a = svc.addItem({ tier: "secure", name: "a", kind: "other", value: "va" }, k);
    const b = svc.addItem({ tier: "secure", name: "b", kind: "other", value: "vb" }, k);
    const ra = getDb().query("SELECT ciphertext, nonce FROM vault_items WHERE id=?").get(a.id) as { ciphertext: Uint8Array; nonce: Uint8Array };
    getDb().query("UPDATE vault_items SET ciphertext=?, nonce=? WHERE id=?").run(ra.ciphertext, ra.nonce, b.id);
    expect(() => svc.readLocked("secure", [b.id], k)).toThrow(VaultError);
  });

  it("refuses a sealed password equal to the secure one, either way round, and PPM's own token", async () => {
    const svc = make();
    await svc.enableTier("secure", "same-password-for-both");
    await expect(svc.enableTier("sealed", "same-password-for-both")).rejects.toThrow(/differ/);
    await svc.enableTier("sealed", MK3);
    const changed = svc.changePassword("secure", "same-password-for-both", MK3);
    await expect(changed).rejects.toThrow(/differ/);

    const auth = (configService as unknown as { config: { auth: { token: string } } }).config.auth;
    const before = auth.token;
    auth.token = "token-that-is-long-enough-xx";
    try {
      getDb().exec("DELETE FROM vault_keys");
      await expect(svc.enableTier("secure", "token-that-is-long-enough-xx")).rejects.toThrow(/PPM's own password/);
    } finally {
      auth.token = before;
    }
  });

  it("enforces 12 characters for secure and 16 for sealed", async () => {
    const svc = make();
    await expect(svc.enableTier("secure", "elevenchars")).rejects.toThrow(/12/);
    await svc.enableTier("secure", "twelvechars!");
    await expect(svc.enableTier("sealed", "fifteen-chars!!")).rejects.toThrow(/16/);
    await svc.enableTier("sealed", "sixteen-chars!!!");
  });

  it("changes a password by re-wrapping the key, and old items still read", async () => {
    const svc = make();
    await svc.enableTier("secure", MK2);
    const k = await dekOf(svc, "secure", MK2);
    const item = svc.addItem({ tier: "secure", name: "a", kind: "other", value: "kept-value" }, k);
    expect((await svc.changePassword("secure", MK2, "brand-new-pass-02")).ok).toBe(true);
    expect((await svc.unlock("secure", MK2)).ok).toBe(false);
    const k2 = await dekOf(svc, "secure", "brand-new-pass-02");
    expect(svc.readLocked("secure", [item.id], k2)[0]!.value).toBe("kept-value");
  });

  it("reads the key parameters stored with the tier, not the current default", async () => {
    await make(() => ({ N: 2048, r: 8, p: 1 })).enableTier("secure", MK2);
    const later = make(() => ({ N: 1024, r: 4, p: 1 }));
    expect((await later.unlock("secure", MK2)).ok).toBe(true);
  });

  it("moves an item between tiers in one write, needing every locked tier's key", async () => {
    const svc = make();
    await svc.enableTier("secure", MK2);
    await svc.enableTier("sealed", MK3);
    const pub = svc.addItem({ tier: "public", name: "p", kind: "other", value: "public-to-sealed" });
    expect(() => svc.moveItem(pub.id, "sealed", {})).toThrow(/Unlock/);
    const k3 = await dekOf(svc, "sealed", MK3);
    expect(svc.moveItem(pub.id, "sealed", { to: k3 }).tier).toBe("sealed");
    const row = getDb().query("SELECT value_plain FROM vault_items WHERE id=?").get(pub.id) as { value_plain: string | null };
    expect(row.value_plain).toBeNull();
    const k2 = await dekOf(svc, "secure", MK2);
    expect(() => svc.moveItem(pub.id, "secure", { to: k2 })).toThrow(/Unlock/);
    svc.moveItem(pub.id, "secure", { from: k3, to: k2 });
    expect(svc.readLocked("secure", [pub.id], k2)[0]!.value).toBe("public-to-sealed");
  });

  it("deleting a tier needs its password and removes only that tier's items", async () => {
    const svc = make();
    await svc.enableTier("secure", MK2);
    svc.addItem({ tier: "public", name: "p", kind: "other", value: "v" });
    const k = await dekOf(svc, "secure", MK2);
    svc.addItem({ tier: "secure", name: "s", kind: "other", value: "v" }, k);
    expect((await svc.deleteTier("secure", "wrong-password-x")).ok).toBe(false);
    const r = await svc.deleteTier("secure", MK2);
    expect(r.ok && r.removed).toBe(1);
    expect(svc.isEnabled("secure")).toBe(false);
    expect(svc.listItems().map((i) => i.tier)).toEqual(["public"]);
  });
});

describe("wrong passwords", () => {
  beforeEach(reset);

  it("follows each tier's schedule", () => {
    expect([1, 4, 5, 6, 7].map((n) => lockoutMs(ATTEMPT_POLICY.secure, n))).toEqual([0, 0, 30_000, 60_000, 120_000]);
    expect(lockoutMs(ATTEMPT_POLICY.secure, 40)).toBe(15 * 60_000);
    expect([1, 2, 3, 4].map((n) => lockoutMs(ATTEMPT_POLICY.sealed, n))).toEqual([0, 0, 60_000, 120_000]);
    expect(lockoutMs(ATTEMPT_POLICY.sealed, 40)).toBe(60 * 60_000);
  });

  it("keeps two independent counters that survive a new service, and skips scrypt while locked out", async () => {
    let alarms: string[] = [];
    const svc = createVaultService({ now, kdfParams: FAST, attempts: createVaultAttempts({ now, onAlarm: (a) => alarms.push(`${a.tier}:${a.kind}`) }) });
    await svc.enableTier("secure", MK2);
    await svc.enableTier("sealed", MK3);
    for (let i = 0; i < 2; i++) expect((await svc.unlock("sealed", "nope-nope-nope-nope")).ok).toBe(false);
    const third = await svc.unlock("sealed", "nope-nope-nope-nope");
    expect(third.ok === false && third.reason === "wrong-password" && third.lockedForMs).toBe(60_000);
    expect(alarms).toEqual(["sealed:locked-out"]);
    // The secure tier's counter is untouched.
    expect(svc.status().tiers.secure.attemptsLeft).toBe(5);

    // A fresh service (as after a restart) still sees the lockout, and the right password is not
    // even tried: it answers locked-out at once.
    const again = make();
    const t0 = performance.now();
    const locked = await again.unlock("sealed", MK3);
    expect(locked.ok === false && locked.reason).toBe("locked-out");
    expect(performance.now() - t0).toBeLessThan(50);

    clock += 60_001;
    expect((await again.unlock("sealed", MK3)).ok).toBe(true);
    expect(again.status().tiers.sealed.attemptsLeft).toBe(3);
    alarms = [];
  });

  it("raises one alarm past 20 secure failures in an hour", async () => {
    const alarms: string[] = [];
    const svc = createVaultService({ now, kdfParams: FAST, attempts: createVaultAttempts({ now, onAlarm: (a) => alarms.push(a.kind) }) });
    await svc.enableTier("secure", MK2);
    const fail = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await svc.unlock("secure", "wrong-wrong-wrong");
        clock += 60_000;
        getDb().query("UPDATE vault_keys SET locked_until = 0 WHERE tier='secure'").run();
      }
    };
    await fail(20);
    expect(alarms).toEqual([]);
    await fail(5);
    expect(alarms).toEqual(["many-failures"]);
  });
});
