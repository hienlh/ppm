/**
 * Files attached to vault items, over the real migration and the real folder under PPM_HOME:
 * encrypted on disk with nothing readable, bound to their tier, item and attachment, limited in
 * type, size and count, carried across a tier move, and retired (never deleted at once) when
 * their item, tier or row goes.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getDbPath } from "../../../../src/services/db.service.ts";
import { createVaultAttempts } from "../../../../src/services/vault/vault-attempts.ts";
import { createVaultService, VaultError } from "../../../../src/services/vault/vault.service.ts";
import { createVaultAttachments, sniffVaultFileType, cleanFileName } from "../../../../src/services/vault/vault-attachments.service.ts";
import { decryptFilePart, encryptFilePart, parseVaultFileBytes, vaultFileBytes } from "../../../../src/services/vault/vault-crypto.ts";
import { RETIRED_DIR_NAME, vaultFilesDirFor } from "../../../../src/services/vault/vault-files-dir.ts";
import { purgeRetired, RETIRED_MAX_AGE_MS } from "../../../../src/services/vault/vault-file-store.ts";
import { VAULT_FILE_MAX_BYTES, VAULT_FILES_PER_ITEM } from "../../../../src/shared/vault.ts";

const FAST = () => ({ N: 1024, r: 8, p: 1 });
const MK2 = "secure-pass-0001";
const MK3 = "sealed-password-0001";
const dir = () => vaultFilesDirFor(getDbPath());

const files = createVaultAttachments();
const svc = createVaultService({ kdfParams: FAST, attempts: createVaultAttempts(), attachments: files });

/** A JPEG-looking file: the magic bytes, then a marker the test can search ciphertext for. */
const jpeg = (marker = "CANARY-FILE-BYTES") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(marker.repeat(20))]);
const pdf = () => Buffer.from("%PDF-1.7\nCANARY-PDF-BODY\n%%EOF");

async function dekOf(tier: "secure" | "sealed", pw: string): Promise<Buffer> {
  const r = await svc.unlock(tier, pw);
  if (!r.ok) throw new Error(r.message);
  return r.dek;
}

let secureDek: Buffer;
let sealedDek: Buffer;

beforeEach(async () => {
  getDb().exec("DELETE FROM vault_attachments; DELETE FROM vault_items; DELETE FROM vault_keys;");
  rmSync(dir(), { recursive: true, force: true });
  await svc.enableTier("secure", MK2);
  await svc.enableTier("sealed", MK3);
  secureDek = await dekOf("secure", MK2);
  sealedDek = await dekOf("sealed", MK3);
});

const addItem = (tier: "secure" | "sealed" = "secure") =>
  svc.addItem({ tier, name: "Passport", kind: "passport", value: "AB1234567" }, tier === "secure" ? secureDek : sealedDek);

describe("file crypto", () => {
  it("opens only under the tier, item, attachment and part it was sealed for", () => {
    const body = Buffer.from("hello");
    const sealed = encryptFilePart(secureDek, "secure", "item-1", "att-1", "body", body);
    const parsed = parseVaultFileBytes(vaultFileBytes(sealed))!;
    expect(decryptFilePart(secureDek, "secure", "item-1", "att-1", "body", parsed.nonce, parsed.ciphertext)?.toString()).toBe("hello");
    expect(decryptFilePart(secureDek, "sealed", "item-1", "att-1", "body", parsed.nonce, parsed.ciphertext)).toBeNull();
    expect(decryptFilePart(secureDek, "secure", "item-2", "att-1", "body", parsed.nonce, parsed.ciphertext)).toBeNull();
    expect(decryptFilePart(secureDek, "secure", "item-1", "att-2", "body", parsed.nonce, parsed.ciphertext)).toBeNull();
    expect(decryptFilePart(secureDek, "secure", "item-1", "att-1", "meta", parsed.nonce, parsed.ciphertext)).toBeNull();
    expect(decryptFilePart(sealedDek, "secure", "item-1", "att-1", "body", parsed.nonce, parsed.ciphertext)).toBeNull();
    expect(parseVaultFileBytes(Buffer.from("not a vault file at all"))).toBeNull();
  });

  it("tells a type from its first bytes and refuses SVG, HTML and anything else", () => {
    expect(sniffVaultFileType(jpeg())).toBe("image/jpeg");
    expect(sniffVaultFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffVaultFileType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffVaultFileType(pdf())).toBe("application/pdf");
    expect(sniffVaultFileType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"))).toBeNull();
    expect(sniffVaultFileType(Buffer.from("<!doctype html><script>1</script>"))).toBeNull();
  });

  it("keeps a file name to a name: no path, no control characters, no quote", () => {
    expect(cleanFileName("C:\\secret\\..\\pass\"port\u0007.jpg", "image/jpeg")).toBe("passport.jpg");
    expect(cleanFileName("", "application/pdf")).toBe("file.pdf");
  });
});

describe("attachments", () => {
  it("writes only ciphertext under a random name, lists label, type and size, and reads back the bytes", () => {
    const item = addItem();
    const bytes = jpeg();
    const meta = files.add(item.id, { fileName: "passport-AB1234567.jpg", label: "Photo page", bytes }, secureDek);
    expect(meta).toMatchObject({ itemId: item.id, label: "Photo page", type: "image/jpeg", size: bytes.length });
    const onDisk = readdirSync(dir()).filter((n) => n.endsWith(".bin"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatch(/^[0-9a-f]{32}\.bin$/);
    const raw = readFileSync(join(dir(), onDisk[0]!));
    expect(raw.toString("latin1")).not.toContain("CANARY");
    // The original name is in the database only as ciphertext.
    const row = getDb().query("SELECT * FROM vault_attachments").get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain("AB1234567");
    expect(Buffer.from(row.meta_ciphertext as Uint8Array).toString("latin1")).not.toContain("passport");
    const listed = svc.listItems().find((i) => i.id === item.id)!;
    expect(listed.attachments).toEqual([meta]);
    const read = files.read(meta.id, secureDek);
    expect(read.bytes.equals(bytes)).toBe(true);
    expect(read.fileName).toBe("passport-AB1234567.jpg");
  });

  it("refuses the wrong key, the public tier, unknown types, an oversized file and an eleventh file", () => {
    const item = addItem();
    expect(() => files.add(item.id, { bytes: jpeg() }, sealedDek)).toThrow(VaultError);
    expect(() => files.add(item.id, { bytes: jpeg() }, null)).toThrow(VaultError);
    const pub = svc.addItem({ tier: "public", name: "Postcode", kind: "address", value: "EH6" });
    expect(() => files.add(pub.id, { bytes: jpeg() }, secureDek)).toThrow(/Secure and Sealed/);
    expect(() => files.add(item.id, { bytes: Buffer.from("<svg/>") }, secureDek)).toThrow(/JPEG, PNG/);
    const big = Buffer.concat([jpeg(), Buffer.alloc(VAULT_FILE_MAX_BYTES)]);
    expect(() => files.add(item.id, { bytes: big }, secureDek)).toThrow(/at most/);
    for (let i = 0; i < VAULT_FILES_PER_ITEM; i++) files.add(item.id, { bytes: jpeg(`n${i}`) }, secureDek);
    expect(() => files.add(item.id, { bytes: jpeg() }, secureDek)).toThrow(/at most 10 files/);
    // Nothing a refusal touched was left on disk.
    expect(readdirSync(dir()).filter((n) => n.endsWith(".bin"))).toHaveLength(VAULT_FILES_PER_ITEM);
  });

  it("does not open a file whose bytes were swapped for another attachment's", () => {
    const item = addItem();
    const a = files.add(item.id, { bytes: jpeg("A") }, secureDek);
    const b = files.add(item.id, { bytes: jpeg("B") }, secureDek);
    const rows = getDb().query("SELECT id, file_id FROM vault_attachments").all() as { id: string; file_id: string }[];
    const fa = rows.find((r) => r.id === a.id)!.file_id;
    const fb = rows.find((r) => r.id === b.id)!.file_id;
    const bytesB = readFileSync(join(dir(), `${fb}.bin`));
    writeFileSync(join(dir(), `${fa}.bin`), bytesB);
    expect(() => files.read(a.id, secureDek)).toThrow(/tampered/);
  });

  it("moves an item's files to the other locked tier, re-encrypted, and retires the old ones", () => {
    const item = addItem();
    const meta = files.add(item.id, { bytes: jpeg() }, secureDek);
    const before = (getDb().query("SELECT file_id FROM vault_attachments").get() as { file_id: string }).file_id;
    svc.moveItem(item.id, "sealed", { from: secureDek, to: sealedDek });
    const after = getDb().query("SELECT tier, file_id FROM vault_attachments").get() as { tier: string; file_id: string };
    expect(after.tier).toBe("sealed");
    expect(after.file_id).not.toBe(before);
    expect(files.read(meta.id, sealedDek).bytes.equals(jpeg())).toBe(true);
    expect(() => files.read(meta.id, secureDek)).toThrow();
    expect(existsSync(join(dir(), `${before}.bin`))).toBe(false);
    expect(existsSync(join(dir(), RETIRED_DIR_NAME, `${before}.bin`))).toBe(true);
  });

  it("refuses to move an item with files to the public tier", () => {
    const item = addItem();
    files.add(item.id, { bytes: jpeg() }, secureDek);
    expect(() => svc.moveItem(item.id, "public", { from: secureDek })).toThrow(/Public tier cannot hold files/);
  });

  it("retires an item's files with the item, and a tier's with the tier", async () => {
    const a = addItem("secure");
    const b = addItem("sealed");
    files.add(a.id, { bytes: jpeg() }, secureDek);
    files.add(b.id, { bytes: pdf() }, sealedDek);
    svc.deleteItem(a.id, secureDek);
    expect((getDb().query("SELECT COUNT(*) AS n FROM vault_attachments").get() as { n: number }).n).toBe(1);
    const r = await svc.deleteTier("sealed", MK3);
    expect(r.ok).toBe(true);
    expect((getDb().query("SELECT COUNT(*) AS n FROM vault_attachments").get() as { n: number }).n).toBe(0);
    expect(readdirSync(dir()).filter((n) => n.endsWith(".bin"))).toHaveLength(0);
    expect(readdirSync(join(dir(), RETIRED_DIR_NAME)).filter((n) => n.endsWith(".bin"))).toHaveLength(2);
  });

  it("renames by label and removes one file, proving the key first", () => {
    const item = addItem();
    const meta = files.add(item.id, { bytes: jpeg() }, secureDek);
    expect(() => files.rename(meta.id, "x", sealedDek)).toThrow();
    expect(files.rename(meta.id, "Front", secureDek).label).toBe("Front");
    expect(() => files.remove(meta.id, sealedDek)).toThrow();
    files.remove(meta.id, secureDek);
    expect(files.list(item.id)).toEqual([]);
  });

  it("sweeps files no row names into retired/, and purges retired files a snapshot no longer needs", () => {
    const item = addItem();
    files.add(item.id, { bytes: jpeg() }, secureDek);
    const stray = "0123456789abcdef0123456789abcdef";
    writeFileSync(join(dir(), `${stray}.bin`), "x");
    expect(files.sweep()).toBe(1);
    expect(existsSync(join(dir(), RETIRED_DIR_NAME, `${stray}.bin`))).toBe(true);
    // Retired after the snapshot began: still needed.
    expect(purgeRetired(Date.now() - 60_000, dir())).toBe(0);
    expect(purgeRetired(Date.now() + 1, dir())).toBe(1);
    expect(existsSync(join(dir(), RETIRED_DIR_NAME, `${stray}.bin`))).toBe(false);
    expect(RETIRED_MAX_AGE_MS).toBeGreaterThan(0);
  });
});

describe("tampering with the record", () => {
  it("refuses to answer a file whose stored type was changed, and still deletes a damaged one", () => {
    const item = addItem();
    const meta = files.add(item.id, { bytes: pdf() }, secureDek);
    getDb().query("UPDATE vault_attachments SET mime = 'image/png' WHERE id = ?").run(meta.id);
    expect(() => files.read(meta.id, secureDek)).toThrow(/type does not match/);
    getDb().query("UPDATE vault_attachments SET meta_ciphertext = x'00' WHERE id = ?").run(meta.id);
    files.remove(meta.id, secureDek);
    expect(files.list(item.id)).toEqual([]);
  });
});
