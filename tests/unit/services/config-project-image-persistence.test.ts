/**
 * A project's custom avatar is stored with the project row. It used to be held only in the
 * server's memory, so every restart dropped it while the file stayed on disk — and another
 * process saving the list could not carry it either.
 *
 * `other` is a second connection to the same file, standing in for a separate `ppm` process.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, openTestDb, runMigrations, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import type { ProjectConfig } from "../../../src/types/config.ts";

let dir: string;
let file: string;
let other: Database;

const imageOf = (name: string) => configService.get("projects").find((p) => p.name === name)?.image;
const storedImage = (name: string) =>
  (other.query("SELECT image FROM projects WHERE name = ?").get(name) as { image: string | null } | null)?.image;
const withImage = (name: string, image: string | undefined): ProjectConfig[] =>
  configService.get("projects").map((p) => {
    if (p.name !== name) return p;
    const next = { ...p };
    if (image) next.image = image;
    else delete next.image;
    return next;
  });

/** Open the file on a fresh connection and load from it, as a restarted server does. */
function restart(): void {
  const db = new Database(file);
  applyDbPragmas(db);
  runMigrations(db);
  setDb(db);
  configService.load();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-project-image-"));
  file = join(dir, "ppm.db");
  restart();
  configService.set("projects", [{ path: "/p/alpha", name: "alpha" }, { path: "/p/beta", name: "beta" }]);
  other = new Database(file);
  applyDbPragmas(other);
});

afterEach(() => {
  other.close();
  setDb(openTestDb());
  configService.load();
  // Other test files share this process and expect the preload's auth-off config.
  (configService as unknown as { config: { auth: unknown } }).config.auth = { enabled: false, token: "" };
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
});

describe("the projects.image migration", () => {
  it("adds the column to a database at the previous version and keeps its rows", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    db.query("INSERT INTO projects (path, name, color, sort_order) VALUES ('/p/old', 'old', '#abcdef', 0)").run();
    db.exec("ALTER TABLE projects DROP COLUMN image; PRAGMA user_version = 58");
    expect((db.query("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name)).not.toContain("image");

    runMigrations(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(db.query("SELECT name, color, image FROM projects").all()).toEqual([{ name: "old", color: "#abcdef", image: null }]);
    db.close();
  });
});

describe("a project's avatar", () => {
  it("survives a restart", () => {
    configService.set("projects", withImage("alpha", "abc.webp"));
    restart();
    expect(imageOf("alpha")).toBe("abc.webp");
    expect(imageOf("beta")).toBeUndefined();
  });

  it("is written by a change that touches nothing but the avatar", () => {
    configService.set("projects", withImage("beta", "def.webp"));
    expect(storedImage("beta")).toBe("def.webp");
    expect(storedImage("alpha")).toBeNull();
  });

  it("set from a stale list leaves another process's edit to a different project alone", () => {
    const stale = configService.get("projects").map((p) => ({ ...p }));
    other.query("UPDATE projects SET color = '#123456', image = 'theirs.webp' WHERE name = 'beta'").run();
    configService.set("projects", stale.map((p) => (p.name === "alpha" ? { ...p, image: "mine.webp" } : p)));
    expect(storedImage("alpha")).toBe("mine.webp");
    expect(storedImage("beta")).toBe("theirs.webp");
    expect(imageOf("beta")).toBe("theirs.webp");
  });

  it("set by another process is picked up on the next read", () => {
    other.query("UPDATE projects SET image = 'elsewhere.webp' WHERE name = 'alpha'").run();
    expect(imageOf("alpha")).toBe("elsewhere.webp");
  });

  it("removed by another process is gone on the next read", () => {
    configService.set("projects", withImage("alpha", "abc.webp"));
    other.query("UPDATE projects SET image = NULL WHERE name = 'alpha'").run();
    expect(imageOf("alpha")).toBeUndefined();
  });

  it("removed here is cleared in the table and stays cleared after a restart", () => {
    configService.set("projects", withImage("alpha", "abc.webp"));
    configService.set("projects", withImage("alpha", undefined));
    expect(storedImage("alpha")).toBeNull();
    restart();
    expect(imageOf("alpha")).toBeUndefined();
  });

  it("follows a project moved to another path", () => {
    configService.set("projects", withImage("alpha", "abc.webp"));
    configService.set("projects", configService.get("projects").map((p) => (p.name === "alpha" ? { ...p, path: "/p/alpha-2" } : p)));
    restart();
    const alpha = configService.get("projects").find((p) => p.name === "alpha")!;
    expect(alpha.path).toBe("/p/alpha-2");
    expect(alpha.image).toBe("abc.webp");
  });
});
