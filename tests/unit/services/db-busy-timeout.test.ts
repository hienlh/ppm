import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDbPragmas } from "../../../src/services/db.service.ts";
import { resolveTunnelConfig } from "../../../src/services/named-tunnel/named-tunnel-config.ts";

describe("database lock contention", () => {
  const dirs: string[] = [];
  const open: Database[] = [];

  afterEach(() => {
    for (const db of open.splice(0)) { try { db.close(); } catch { /* already closed */ } }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function seeded(): string {
    const dir = mkdtempSync(join(tmpdir(), "ppm-lock-"));
    dirs.push(dir);
    const path = join(dir, "ppm.db");
    const db = new Database(path);
    applyDbPragmas(db);
    db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO config VALUES ('tunnel', '{\"enabled\":false}')");
    db.close();
    return path;
  }

  function connect(path: string, pragmas: boolean): Database {
    const db = new Database(path);
    if (pragmas) applyDbPragmas(db);
    else db.exec("PRAGMA journal_mode = WAL");
    open.push(db);
    return db;
  }

  /** Read the row the supervisor's startup reads, reporting how long it took. */
  function read(db: Database): { ok: boolean; ms: number; error?: string } {
    const started = Date.now();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.query("SELECT value FROM config WHERE key = 'tunnel'").get();
      db.exec("COMMIT");
      return { ok: true, ms: Date.now() - started };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: (e as Error).message };
    }
  }

  // The holder has to be another process: SQLite's wait blocks the thread, so a
  // same-process writer could never reach the commit the waiter is waiting for
  // — which is also exactly the real shape, two PPM processes overlapping.
  it("survives the overlap a restart creates, where the default fails instantly", async () => {
    const path = seeded();
    const holder = Bun.spawn(["bun", "-e", `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(path)});
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("UPDATE config SET value = '{}' WHERE key = 'tunnel'");
      console.log("held");
      await Bun.sleep(400);
      db.exec("COMMIT");
    `], { stdout: "pipe" });
    for await (const chunk of holder.stdout) {
      if (new TextDecoder().decode(chunk).includes("held")) break;
    }

    // SQLite's default: no wait at all. This is the failure that left PPM
    // running with a dark public port.
    const bare = read(connect(path, false));
    expect(bare.ok).toBe(false);
    expect(bare.error).toContain("locked");
    expect(bare.ms).toBeLessThan(100);

    // A connection PPM opens waits the writer out and gets its row.
    const ppm = read(connect(path, true));
    expect(ppm.ok).toBe(true);
    expect(ppm.ms).toBeGreaterThanOrEqual(200);

    await holder.exited;
  });

  it("asks for five seconds on every connection PPM opens", () => {
    const db = connect(seeded(), true);
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });
});

describe("unreadable tunnel config", () => {
  // The supervisor falls back to this when the config read throws, and it must
  // never be the resolver's own default: an absent row means "on", so
  // defaulting would publish a tunnel for someone who had sharing switched off
  // and whose config merely could not be read.
  it("falls back to sharing off, not to the default-on config", () => {
    expect(resolveTunnelConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveTunnelConfig(null).enabled).toBe(true);
  });
});
