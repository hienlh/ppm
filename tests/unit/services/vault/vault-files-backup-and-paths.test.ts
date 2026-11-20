/**
 * The vault's files beside database snapshots, the folder's place among the paths PPM refuses,
 * the address that opens Settings → Vault on an item, and the Telegram notice for a vault card.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPpmDir } from "../../../../src/services/ppm-dir.ts";
import { getDbPath } from "../../../../src/services/db.service.ts";
import { collectVaultFiles, pruneVaultFilePool, restoreVaultFiles, backupVaultFilesDir } from "../../../../src/services/db-backup/db-backup-vault-files.ts";
import { vaultFilesDirFor } from "../../../../src/services/vault/vault-files-dir.ts";
import { isPpmDirPath, isChatUploadPath } from "../../../../src/services/fs-credential-path-guard.ts";
import { assistantPrivateRoots } from "../../../../src/services/assistant/assistant-private-paths.ts";
import { vaultLinkFromSearch, addressWithoutVaultLink } from "../../../../src/web/lib/vault-deep-link.ts";
import { vaultSettingsPath } from "../../../../src/shared/vault.ts";
import { vaultNoticeHtml, vaultNoticeItem } from "../../../../src/services/assistant-telegram/assistant-telegram-db-notices.ts";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A database file naming `ids` in `vault_attachments`, as a snapshot would. */
function dbNaming(path: string, ids: string[]): void {
  const db = new Database(path);
  db.exec("CREATE TABLE vault_attachments (id TEXT, file_id TEXT)");
  for (const id of ids) db.query("INSERT INTO vault_attachments (id, file_id) VALUES (?, ?)").run(id, id);
  db.close();
}

describe("vault files beside snapshots", () => {
  it("keeps the files a snapshot names, prunes those no snapshot names, and restores them", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-backup-"));
    const home = join(root, "home");
    const backups = join(root, "backups");
    mkdirSync(home);
    mkdirSync(backups);
    const dbPath = join(home, "ppm.db");
    const live = vaultFilesDirFor(dbPath);
    mkdirSync(live);
    writeFileSync(join(live, `${ID_A}.bin`), "cipher-a");
    // B was removed after the snapshot began: it waits in retired/.
    mkdirSync(join(live, "retired"));
    writeFileSync(join(live, "retired", `${ID_B}.bin`), "cipher-b");

    const snap = join(backups, "ppm-20261120T120000Z-hourly.db");
    dbNaming(snap, [ID_A, ID_B]);
    const kept = collectVaultFiles(snap, dbPath);
    expect(kept).toEqual({ kept: 2, missing: [] });
    const pool = backupVaultFilesDir(backups, "ppm.db");
    expect(existsSync(join(pool, `${ID_A}.bin`)) && existsSync(join(pool, `${ID_B}.bin`))).toBe(true);

    // A newer snapshot names only A; the older one goes: B is no longer kept.
    const snap2 = join(backups, "ppm-20261120T130000Z-hourly.db");
    dbNaming(snap2, [ID_A]);
    rmSync(snap);
    expect(pruneVaultFilePool(backups, "ppm.db")).toBe(1);
    expect(existsSync(join(pool, `${ID_B}.bin`))).toBe(false);

    // The live folder is lost; restoring the snapshot puts A back.
    rmSync(live, { recursive: true, force: true });
    dbNaming(dbPath, [ID_A]);
    expect(restoreVaultFiles(snap2, dbPath)).toEqual({ kept: 1, missing: [] });
    expect(existsSync(join(live, `${ID_A}.bin`))).toBe(true);
  });

  it("reports a file it cannot find instead of failing the snapshot, and ignores a snapshot from before files", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-backup-"));
    const dbPath = join(root, "ppm.db");
    const snap = join(root, "ppm-20261120T120000Z-hourly.db");
    dbNaming(snap, [ID_A]);
    expect(collectVaultFiles(snap, dbPath)).toEqual({ kept: 0, missing: [ID_A] });
    const old = join(root, "ppm-20261120T110000Z-hourly.db");
    new Database(old).close();
    expect(collectVaultFiles(old, dbPath)).toEqual({ kept: 0, missing: [] });
  });

  it("keeps a dev database's files apart from production's", () => {
    expect(vaultFilesDirFor("/x/ppm.db")).toMatch(/[\\/]vault-files$/);
    expect(vaultFilesDirFor("/x/ppm.dev.db")).toMatch(/[\\/]vault-files\.dev$/);
  });
});

describe("the vault's folder among refused paths", () => {
  it("is inside the PPM directory every filesystem door refuses, and not under uploads", () => {
    const dir = vaultFilesDirFor(getDbPath());
    expect(dir.startsWith(getPpmDir())).toBe(true);
    expect(isPpmDirPath(join(dir, `${ID_A}.bin`))).toBe(true);
    expect(isChatUploadPath(join(dir, `${ID_A}.bin`))).toBe(false);
    expect(assistantPrivateRoots().some((r) => dir.toLowerCase().startsWith(r.toLowerCase()))).toBe(true);
  });
});

describe("the address that opens Settings → Vault", () => {
  const item = "3f3bc54c-543e-4f89-bba2-58693cc4507f";
  it("names an item id and nothing else, and is dropped from the address once read", () => {
    expect(vaultSettingsPath(item)).toBe(`/?openVault=${item}`);
    expect(vaultSettingsPath("../../etc")).toBe("/?openVault=all");
    expect(vaultLinkFromSearch(`?openVault=${item}`)).toEqual({ itemId: item });
    expect(vaultLinkFromSearch("?openVault=all")).toEqual({ itemId: null });
    expect(vaultLinkFromSearch("?openVault=<script>")).toEqual({ itemId: null });
    expect(vaultLinkFromSearch("?other=1")).toBeNull();
    expect(addressWithoutVaultLink(`https://h/?openVault=${item}&x=1#y`)).toBe("/?x=1#y");
  });
});

describe("the Telegram notice for a vault card", () => {
  const chat = { project: "ppm", providerId: "claude", title: "Visa" };
  const requester = { sessionTitle: "Visa", assistant: false, fromTelegram: false };
  it("names the items, the tier and what is asked, never the purpose, and lands on the item", () => {
    const secure = {
      kind: "read-secure" as const, requester, purpose: "CANARY purpose", attemptsLeft: 5, lockedUntil: 0,
      items: [{ id: "i1", name: "NI number", kind: "ni_number" as const }, { id: "i2", name: "Address", kind: "address" as const }],
      requested: ["i1"],
    };
    const html = vaultNoticeHtml(chat, secure);
    expect(html).toContain("<b>NI number</b>");
    expect(html).toContain("<b>Secure</b>");
    expect(html).not.toContain("Address");
    expect(html).not.toContain("CANARY");
    expect(vaultNoticeItem(secure)).toBe("i1");
    const propose = {
      kind: "propose" as const, requester, name: "Home <address>", itemKind: "address" as const, suggestedTier: "secure" as const,
      hasPrefill: true, enabled: { secure: true, sealed: true },
    };
    const p = vaultNoticeHtml(chat, propose);
    // The name the AI proposes is its own text: it is not sent.
    expect(p).not.toContain("Home");
    expect(p).toContain("<b>Secure</b>");
    expect(p).toContain("Save to the vault?");
    expect(vaultNoticeItem(propose)).toBeNull();
  });
});

describe("a restore", () => {
  it("keeps the files the replaced database names beside the snapshots, so undoing it loses nothing", async () => {
    const { restoreDb } = await import("../../../../src/services/db-backup/db-backup-restore.ts");
    const { getBackupsDir } = await import("../../../../src/services/db-backup/db-backup-paths.ts");
    const { archivedDatabases } = await import("../../../../src/services/db-backup/db-backup-vault-files.ts");
    const root = mkdtempSync(join(tmpdir(), "vault-restore-"));
    const dbPath = join(root, "ppm.db");
    const live = vaultFilesDirFor(dbPath);
    mkdirSync(live);
    // The live database names B, added after the snapshot (which names only A).
    writeFileSync(join(live, `${ID_A}.bin`), "a");
    writeFileSync(join(live, `${ID_B}.bin`), "b");
    dbNaming(dbPath, [ID_A, ID_B]);
    mkdirSync(getBackupsDir(), { recursive: true });
    const snap = join(getBackupsDir(), "ppm-20261120T120000Z-manual.db");
    dbNaming(snap, [ID_A]);
    collectVaultFiles(snap, dbPath);
    restoreDb(snap, { dbPath, force: true });
    const pool = backupVaultFilesDir(getBackupsDir(), "ppm.db");
    expect(existsSync(join(pool, `${ID_B}.bin`))).toBe(true);
    expect(archivedDatabases(dbPath).length).toBe(1);
    // Retention keeps B while the set-aside database names it.
    expect(pruneVaultFilePool(getBackupsDir(), "ppm.db", archivedDatabases(dbPath))).toBe(0);
    expect(existsSync(join(pool, `${ID_B}.bin`))).toBe(true);
  });
});
