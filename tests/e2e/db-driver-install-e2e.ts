/**
 * Drives the real MySQL / MariaDB driver install and real connections through it.
 *
 * Not a `bun test` file: it downloads the driver from the npm registry, which is exactly the part
 * unit tests cannot establish — `db-driver-install.test.ts` copies the repository's own `mysql2`
 * instead. Everything goes through the HTTP routes the Settings pane and the Install notice call,
 * against servers you point it at:
 *
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 \
 *   PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *   bun tests/e2e/db-driver-install-e2e.ts
 *
 * Either URL may be left out, not both. The install lands in a throwaway PPM_HOME that is deleted
 * afterwards, so a driver installed in `~/.ppm` is untouched.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-db-driver-e2e-"));
// An empty package cache, or `bun install` answers from this machine's and nothing is downloaded.
process.env.BUN_INSTALL_CACHE_DIR = join(process.env.PPM_HOME, "bun-cache");

const servers = [
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
].filter((s): s is { type: string; url: string } => !!s.url);

if (servers.length === 0) {
  console.error("Set PPM_TEST_MYSQL_URL and/or PPM_TEST_MARIADB_URL (no database in the path).");
  process.exit(2);
}

const { Hono } = await import("hono");
const { openTestDb, setDb } = await import("../../src/services/db.service.ts");
const { initAdapters } = await import("../../src/services/database/init-adapters.ts");
const { databaseRoutes } = await import("../../src/server/routes/database.ts");
const { dbDriverDir, readInstalledDriver } = await import("../../src/services/database/drivers/db-driver-store.ts");
const { DB_DRIVERS, driverLockfile } = await import("../../src/services/database/drivers/db-driver-catalog.ts");

setDb(openTestDb());
initAdapters();
const app = new Hono().route("/db", databaseRoutes);

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Every package the install and the connections made bun fetch: `<name>@<version>@@@<n>` entries. */
function cachedPackages(): string[] {
  const cache = process.env.BUN_INSTALL_CACHE_DIR!;
  if (!existsSync(cache)) return [];
  const names = readdirSync(cache).flatMap((entry) =>
    entry.startsWith("@") ? readdirSync(join(cache, entry)).map((sub) => `${entry}/${sub}`) : [entry]);
  return [...new Set(names.map((n) => /^(.+?)@[^@/]+@@@\d+$/.exec(n)?.[1]).filter((n): n is string => !!n))].sort();
}

const testRaw = (s: { type: string; url: string }) =>
  call("POST", "/db/test", { type: s.type, connectionConfig: { type: s.type, connectionString: s.url } });

try {
  console.log(`PPM_HOME=${process.env.PPM_HOME}`);
  const def = DB_DRIVERS.mysql;

  const before = await call("GET", "/db/drivers");
  check("starts with the driver missing", before.json.data?.[0]?.state === "missing", before.json);
  const refused = await testRaw(servers[0]!);
  check("a connection answers 424 before the install", refused.status === 424 && refused.json.code === "DB_DRIVER_MISSING", refused);

  console.log(`\ninstalling ${def.package}@${def.version} from the registry…`);
  const started = performance.now();
  const installed = await call("POST", "/db/drivers/mysql/install");
  console.log(`  took ${((performance.now() - started) / 1000).toFixed(1)}s`);
  check("install answered 200", installed.status === 200, installed.json);
  check("status is installed at the pinned version",
    installed.json.data?.state === "installed" && installed.json.data?.installed?.version === def.version, installed.json.data);

  const record = readInstalledDriver("mysql");
  const dir = dbDriverDir("mysql");
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  check("the driver folder holds the bundle and its record, nothing else",
    files.length === 2 && !!record && files.includes(record.file) && !files.includes("node_modules"), files);
  const leftovers = readdirSync(join(dir, "..")).filter((f) => f.startsWith(".staging-"));
  check("no staging folder is left behind", leftovers.length === 0, leftovers);
  check("the recorded digest is a SHA-256", /^[0-9a-f]{64}$/.test(record?.sha256 ?? ""), record);

  for (const s of servers) {
    console.log(`\n${s.type}…`);
    const test = await testRaw(s);
    check(`${s.type}: Test connects`, test.status === 200 && test.json.data?.ok === true, test.json);

    const added = await call("POST", "/db/connections", {
      type: s.type, name: `e2e-${s.type}`, connectionConfig: { type: s.type, connectionString: s.url },
    });
    const id = added.json.data?.id;
    check(`${s.type}: connection saved`, added.status === 201 && typeof id === "number", added.json);

    const query = await call("POST", `/db/connections/${id}/query`, { sql: "SELECT VERSION() AS v" });
    const version = String(query.json.data?.rows?.[0]?.v ?? query.json.data?.rows?.[0]?.[0] ?? "");
    check(`${s.type}: runs a query (${version})`, query.status === 200 && version.length > 0, query.json);
    check(`${s.type}: reached the engine it was pointed at`,
      s.type === "mariadb" ? /mariadb/i.test(version) : !/mariadb/i.test(version), version);

    const tables = await call("GET", `/db/connections/${id}/tables`);
    check(`${s.type}: lists tables`, tables.status === 200 && Array.isArray(tables.json.data), tables.json);
  }

  // mysql2 asks for an optional `cardinal` at load. Bun auto-installs what it cannot find only in
  // a process whose entry file has no node_modules above it, which this script has, so the bundle
  // is loaded once more from an entry in PPM_HOME.
  const loader = join(process.env.PPM_HOME!, "load-driver.ts");
  writeFileSync(loader, `await import(${JSON.stringify(pathToFileURL(join(dir, record!.file)).href)});\nconsole.log("loaded");\n`);
  const child = Bun.spawnSync([process.execPath, loader], { cwd: process.env.PPM_HOME!, env: process.env });
  check("the bundle loads from an entry Bun would auto-install for", child.stdout.toString().includes("loaded"), child.stderr.toString());
  const pinned = new Set(Object.keys((driverLockfile("mysql") as { packages: Record<string, unknown> }).packages));
  const fetched = cachedPackages();
  check("nothing but the lockfile's packages was ever fetched",
    fetched.length > 0 && fetched.every((name) => pinned.has(name)), fetched.filter((name) => !pinned.has(name)));

  console.log("\nremoving…");
  const removed = await call("DELETE", "/db/drivers/mysql");
  check("remove answered 200 with the driver missing", removed.status === 200 && removed.json.data?.state === "missing", removed.json);
  check("the driver folder is gone", !existsSync(dir), readdirSync(join(dir, "..")));
  const after = await testRaw(servers[0]!);
  check("a connection answers 424 again", after.status === 424 && after.json.code === "DB_DRIVER_MISSING", after);
} finally {
  rmSync(process.env.PPM_HOME!, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
