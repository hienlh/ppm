/**
 * `ppm db` connection commands with a server holding the database: each goes through the server's
 * own connection routes, so every open PPM is told (`db:connections_changed`, recorded on the
 * scratch server's `/ws/global`). A connection added here is read-only and available to the AI chat
 * (the route's defaults: nothing sends `readonly`), an import keeps the file's own flags, a file
 * that is PPM's own database is refused by the route, and from an AI chat a URL with a password
 * and an import are refused before any request.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

type Row = { id: number; name: string; type: string; readonly: number; ai_access: number; group_name: string | null; connection_config: Record<string, unknown> };

let home: string;
// Outside PPM_HOME: a file in PPM's own folder is refused as a database.
let data: string;
let server: ScratchServer;
const rows = () => server.scratch<Row[]>("connections");
const row = async (name: string) => (await rows()).find((r) => r.name === name);
const changed = async () => (await server.events()).filter((e) => e.type === "db:connections_changed").length;

function sqliteFile(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec("CREATE TABLE t (id INTEGER)");
  db.close();
  return path;
}

beforeAll(async () => {
  home = scratchHome();
  data = mkdtempSync(join(tmpdir(), "ppm-cli-db-data-"));
  server = await startScratchServer(home, null);
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe("ppm db connections through the server", () => {
  it("adds a read-only connection available to the AI, and announces it", async () => {
    const before = await changed();
    const add = await runCli(home, ["db", "add", "-n", "shop", "-t", "postgres", "-c", "postgres://app@127.0.0.1:1/shop", "-g", "work"]);
    expect({ code: add.code, err: add.stderr }).toMatchObject({ code: 0 });
    expect(add.stderr).toContain(`→ PPM default (ppm.db) at 127.0.0.1:${server.port}`);
    expect(await row("shop")).toMatchObject({ readonly: 1, ai_access: 1, group_name: "work" });
    expect(await changed()).toBe(before + 1);
  }, 60_000);

  it("edits, copies, tests and removes, each through the server", async () => {
    let n = await changed();
    expect((await runCli(home, ["db", "edit", "shop", "--name", "shop-2", "--color", "#aa00cc"])).code).toBe(0);
    expect(await row("shop-2")).toMatchObject({ color: "#aa00cc", readonly: 1 });
    expect(await changed()).toBe(++n);

    expect((await runCli(home, ["db", "duplicate", "shop-2"])).code).toBe(0);
    expect(await row("shop-2 (copy)")).toMatchObject({ readonly: 1, ai_access: 1 });
    expect(await changed()).toBe(++n);

    const file = sqliteFile(join(data, "app.db"));
    expect((await runCli(home, ["db", "add", "-n", "app", "-t", "sqlite", "-f", file])).code).toBe(0);
    expect(await changed()).toBe(++n);
    const test = await runCli(home, ["db", "test", "app"]);
    expect({ code: test.code, out: test.stdout }).toMatchObject({ code: 0, out: expect.stringContaining("Connection successful: app") });
    const closed = await runCli(home, ["db", "test", "shop-2"]);
    expect(closed.code).toBe(1);
    expect(closed.stderr).toContain("Connection failed");

    expect((await runCli(home, ["db", "remove", "shop-2 (copy)"])).code).toBe(0);
    expect(await row("shop-2 (copy)")).toBeUndefined();
    expect(await changed()).toBe(++n);
  }, 120_000);

  it("drops the saved password when an edit moves the connection, and says so", async () => {
    expect((await runCli(home, ["db", "add", "-n", "pw", "-t", "postgres", "-c", "postgres://app:s3cret@a.example.com/shop"])).code).toBe(0);
    const edit = await runCli(home, ["db", "edit", "pw", "-c", "postgres://app@b.example.com/shop"]);
    expect(edit.code).toBe(0);
    expect(edit.stdout).toContain("saved password was dropped");
    expect((await row("pw"))!.connection_config).toMatchObject({ connectionString: "postgres://app@b.example.com/shop" });
  }, 60_000);

  it("imports an export file keeping its own read-only and AI flags", async () => {
    const exported = join(home, "export.json");
    writeFileSync(exported, JSON.stringify({ ok: true, data: { version: 1, connections: [
      { type: "sqlite", name: "writable", connection_config: JSON.stringify({ type: "sqlite", path: sqliteFile(join(data, "w.db")) }), readonly: 0, ai_access: 0 },
    ] } }));
    const before = await changed();
    const r = await runCli(home, ["db", "import", exported]);
    expect({ code: r.code, out: r.stdout }).toMatchObject({ code: 0, out: expect.stringMatching(/Imported\S* 1 connection/) });
    expect(await row("writable")).toMatchObject({ readonly: 0, ai_access: 0 });
    expect(await changed()).toBe(before + 1);
  }, 60_000);

  it("is refused by the route for a file that is PPM's own database", async () => {
    const link = join(home, "repo", "app.db");
    mkdirSync(join(home, "repo"), { recursive: true });
    symlinkSync(join(home, "ppm.db"), link);
    const before = await changed();
    const r = await runCli(home, ["db", "add", "-n", "sneaky", "-t", "sqlite", "-f", link]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("protected location");
    expect(await row("sneaky")).toBeUndefined();
    expect(await changed()).toBe(before);
  }, 60_000);

  it("refuses, from an AI chat, a URL with a password, --ai on and an import, before any request", async () => {
    const before = await changed();
    const cases = [
      ["db", "add", "-n", "ai", "-t", "postgres", "-c", "postgres://app:s3cret@h/db"],
      ["db", "add", "-n", "ai", "-t", "postgres", "-c", "postgres://app@h/db", "--ai", "on"],
      ["db", "import", join(home, "export.json")],
    ];
    for (const args of cases) {
      const r = await runCli(home, args, { PPM_AI_CHAT: "1" });
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.stderr).not.toContain("→ PPM");
    }
    expect(await row("ai")).toBeUndefined();
    expect(await changed()).toBe(before);
  }, 60_000);
});
