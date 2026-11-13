/**
 * A SQLite connection is opened with no further question, so its file is judged by where it really
 * is — at save time and at every open, for every caller: PPM's own database (directly or through a
 * symlink or a hard link), its snapshots and the Cloudflare login are refused, and so is a Windows
 * spelling that names no drive. The Assistant's tools are also
 * refused what it keeps private, such as a browser profile's cookie store.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir, getPpmDir } from "../../../../src/services/ppm-dir.ts";
import { getBackupsDir } from "../../../../src/services/db-backup/db-backup-paths.ts";
import {
  SqlitePathRefusedError, assertSqlitePathAllowed, sqlitePathRefusal,
} from "../../../../src/services/database/sqlite-path-guard.ts";
import { sqliteService } from "../../../../src/services/sqlite.service.ts";
import { sqliteAdapter } from "../../../../src/services/database/sqlite-adapter.ts";

const originalPpmHome = process.env.PPM_HOME;
const roots: string[] = [];
let root: string;

function sqliteFile(path: string): string {
  const db = new Database(path);
  db.exec("CREATE TABLE secrets (k TEXT)");
  db.close();
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-sqlite-guard-"));
  roots.push(root);
  process.env.PPM_HOME = join(root, "ppm");
  mkdirSync(process.env.PPM_HOME, { recursive: true });
  _resetPpmDir();
});

afterEach(() => {
  sqliteService.closeAll();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("sqlitePathRefusal", () => {
  it("refuses a Windows spelling that names no drive: a device path, a \\\\.\\ path or a share", () => {
    for (const file of ["\\\\?\\C:\\Users\\me\\.ppm\\ppm.db", "\\\\.\\C:\\Users\\me\\.ppm\\ppm.db", "\\\\localhost\\C$\\Users\\me\\.ppm\\ppm.db"]) {
      expect({ file, refusal: sqlitePathRefusal(file, { platform: "win32" }) }).toMatchObject({ file, refusal: expect.stringContaining("not a path on a local drive") });
    }
    // Elsewhere a path starting with two slashes is an ordinary local one.
    expect(sqlitePathRefusal(join(root, "app.db"), { platform: "linux" })).toBeNull();
  });

  it("refuses a hard link to ppm.db or to a snapshot, at save and at every open, by file identity", async () => {
    const ppmDb = sqliteFile(join(getPpmDir(), "ppm.db"));
    mkdirSync(getBackupsDir(), { recursive: true });
    const snapshot = sqliteFile(join(getBackupsDir(), "ppm-20260101T000000Z-hourly.db"));
    const project = join(root, "project");
    mkdirSync(project);
    for (const [target, name] of [[ppmDb, "copy.db"], [snapshot, "snap.db"]] as const) {
      const link = join(project, name);
      linkSync(target, link);
      expect({ name, refusal: sqlitePathRefusal(link) }).toMatchObject({ name, refusal: expect.stringContaining("hard link") });
      expect(() => assertSqlitePathAllowed(link)).toThrow(SqlitePathRefusedError);
      expect(() => sqliteService.getTables(link, link)).toThrow("hard link");
      expect(await sqliteAdapter.testConnection({ type: "sqlite", path: link })).toMatchObject({ ok: false, error: expect.stringContaining("hard link") });
    }
    // An ordinary file with a second name of its own is not a protected one.
    const own = sqliteFile(join(project, "own.db"));
    linkSync(own, join(project, "own-again.db"));
    expect(sqlitePathRefusal(join(project, "own-again.db"))).toBeNull();
  });

  it("refuses PPM's own database, a snapshot of it and the Cloudflare login", () => {
    const ppmDb = sqliteFile(join(getPpmDir(), "ppm.db"));
    mkdirSync(getBackupsDir(), { recursive: true });
    const snapshot = sqliteFile(join(getBackupsDir(), "ppm-20260101T000000Z-hourly.db"));
    for (const file of [ppmDb, snapshot, join(homedir(), ".cloudflared", "cert.sqlite")]) {
      expect({ file, refusal: sqlitePathRefusal(file) }).toMatchObject({ file, refusal: expect.stringContaining("protected location") });
    }
  });

  it("refuses a symlink to ppm.db by its real path, and names where it really leads", () => {
    const ppmDb = sqliteFile(join(getPpmDir(), "ppm.db"));
    const repo = join(root, "cloned-repo");
    mkdirSync(repo);
    const link = join(repo, "app.db");
    symlinkSync(ppmDb, link);
    const refusal = sqlitePathRefusal(link);
    expect(refusal).toContain("protected location");
    expect(refusal).toContain(`(really ${ppmDb})`);
    expect(() => assertSqlitePathAllowed(link)).toThrow(SqlitePathRefusedError);
  });

  it("lets an ordinary database file through, and answers its real path", () => {
    const file = sqliteFile(join(root, "work.db"));
    expect(sqlitePathRefusal(file)).toBeNull();
    expect(assertSqlitePathAllowed(file)).toBe(file);
  });

  it("refuses a browser profile's cookie store to the Assistant's tools only", () => {
    const home = join(root, "home");
    const profile = join(home, ".mozilla", "firefox", "abc.default-release");
    mkdirSync(profile, { recursive: true });
    const cookies = sqliteFile(join(profile, "cookies.sqlite"));
    expect(sqlitePathRefusal(cookies, { home })).toBeNull();
    const ai = { aiTool: { projectRoots: [], home, roots: [] }, home };
    expect(sqlitePathRefusal(cookies, ai)).toContain("where logins and keys are kept");
    // A project the user registered inside that area is theirs to open.
    expect(sqlitePathRefusal(cookies, { ...ai, aiTool: { ...ai.aiTool, projectRoots: [join(home, ".mozilla")] } })).toBeNull();
    // A file outside the home folder's application area is not private.
    expect(sqlitePathRefusal(sqliteFile(join(root, "plain.db")), ai)).toBeNull();
  });
});

describe("every open", () => {
  it("refuses a saved connection whose file became a link to ppm.db after it was saved", async () => {
    const ppmDb = sqliteFile(join(getPpmDir(), "ppm.db"));
    const file = sqliteFile(join(root, "shop.db"));
    expect(sqliteService.getTables(file, file).map((t) => t.name)).toEqual(["secrets"]);
    sqliteService.closeAll();
    rmSync(file);
    symlinkSync(ppmDb, file);
    expect(() => sqliteService.getTables(file, file)).toThrow("protected location");
    expect(await sqliteAdapter.testConnection({ type: "sqlite", path: file })).toMatchObject({ ok: false, error: expect.stringContaining("protected location") });
    await expect(sqliteAdapter.probe({ type: "sqlite", path: file })).rejects.toThrow("protected location");
  });

  it("still opens an ordinary file the way it did", async () => {
    const file = sqliteFile(join(root, "plain.db"));
    expect((await sqliteAdapter.probe({ type: "sqlite", path: file })).version).toMatch(/^SQLite /);
  });
});
