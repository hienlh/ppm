/**
 * "Available to the AI chat" off: `ppm db` run from a chat — which carries PPM_AI_CHAT, set by
 * every chat provider — neither lists the connection nor opens it, while a person at a terminal
 * still can. The CLI runs as a process of its own against this file's own PPM directory, on
 * SQLite connections, so no database server is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDb, getConnectionByName, insertConnection, updateConnection } from "../../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { _resetKeyPath, setKeyPath } from "../../../../src/lib/account-crypto.ts";

const REPO = resolve(import.meta.dir, "../../../..");
const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-db-ai-access-"));
// Outside the PPM directory: the SQLite service refuses any file inside it.
const data = mkdtempSync(join(tmpdir(), "ppm-db-ai-access-data-"));
const SLOW = 60_000;
let privateId = 0;

/** `ppm db …` as its own process; `chat` is whether it runs with the mark an AI chat's shell has. */
async function ppmDb(args: string[], chat: boolean): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = { ...process.env, PPM_HOME: home };
  if (chat) env.PPM_AI_CHAT = "1";
  else delete env.PPM_AI_CHAT;
  const proc = Bun.spawn([process.execPath, join(REPO, "src/index.ts"), "db", ...args], {
    cwd: REPO, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** The JSON a `--json` command printed, past the version banner every command starts with. */
const json = (out: string) => JSON.parse(out.slice(out.search(/^[[{]/m)));
const names = (out: string) => (json(out) as { name: string }[]).map((c) => c.name);

beforeAll(() => {
  process.env.PPM_HOME = home;
  _resetPpmDir();
  // The key the CLI will read, not one an earlier test file pointed this process at.
  setKeyPath(join(home, "account.key"));
  // A real file under PPM_HOME, which the CLI opens too.
  closeDb();
  const file = join(data, "shop.db");
  const shop = new Database(file);
  shop.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY); INSERT INTO orders VALUES (1), (2);");
  shop.close();
  writeFileSync(join(data, "count.sql"), "SELECT count(*) FROM orders;");
  insertConnection("sqlite", "open", { type: "sqlite", path: file });
  privateId = insertConnection("sqlite", "private", { type: "sqlite", path: file }).id;
  updateConnection(privateId, { aiAccess: 0 });
  closeDb();
});

afterAll(() => {
  closeDb();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  _resetKeyPath();
  rmSync(home, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe("ppm db list", () => {
  it("from an AI chat lists only what is available to it, and says how many are not", async () => {
    const { code, out, err } = await ppmDb(["list", "--json"], true);
    expect({ code, out, err }).toMatchObject({ code: 0 });
    expect(names(out)).toEqual(["open"]);
    expect(err).toContain("1 saved connection is not available to the AI chat.");
  }, SLOW);

  it("at a person's terminal lists every connection", async () => {
    const { out, err } = await ppmDb(["list", "--json"], false);
    expect(names(out)).toEqual(["open", "private"]);
    expect(err).not.toContain("not available to the AI chat");
  }, SLOW);
});

describe("opening a connection that is not available to the AI chat", () => {
  it("is refused to an AI chat by every command, by name or by id", async () => {
    for (const args of [
      ["query", "private", "SELECT 1"],
      ["query", String(privateId), "SELECT 1"],
      ["run", "private", join(data, "count.sql")],
      ["tables", "private"],
      ["schema", "private", "orders"],
      ["data", "private", "orders"],
      ["test", "private"],
      ["remove", "private"],
    ]) {
      const { code, out, err } = await ppmDb(args, true);
      expect({ args, code, refused: (out + err).includes('Connection "private" is not available to the AI chat') })
        .toEqual({ args, code: 1, refused: true });
    }
    expect(getConnectionByName("private")).not.toBeNull();
  }, SLOW);

  it("records a refused query in the audit log as blocked", async () => {
    await ppmDb(["query", "private", "SELECT 42"], true);
    const audit = new Database(join(home, "query-audit.db"), { readonly: true });
    try {
      const rows = audit.query("SELECT status, error FROM query_log WHERE connection_name = 'private' AND sql = 'SELECT 42'").all();
      expect(rows).toEqual([{ status: "blocked", error: expect.stringContaining("not available to the AI chat") }]);
    } finally {
      audit.close();
    }
  }, SLOW);

  it("still works for a person at a terminal", async () => {
    const { code, out } = await ppmDb(["query", "private", "SELECT count(*) AS n FROM orders", "--json"], false);
    expect(code).toBe(0);
    expect(json(out).rows).toHaveLength(1);
  }, SLOW);

  it("leaves the connections an AI chat may use alone", async () => {
    const { code } = await ppmDb(["query", "open", "SELECT count(*) AS n FROM orders"], true);
    expect(code).toBe(0);
  }, SLOW);
});
