/**
 * Installing a database driver from Settings.
 *
 * Against a fake runner that copies the repository's own `mysql2` into the
 * staging folder instead of downloading it (`tests/helpers/db-driver-offline-install.ts`),
 * so everything after the download is real: the bundle `Bun.build` makes, the
 * import that checks it, the manifest, the loader, the uninstall. What is pinned here is *where* an
 * install lands, *what* argv and environment `bun install` gets, that a failed
 * or bad install leaves the previous one alone, and that two presses of one
 * button run one install. A real download is exercised by
 * `tests/e2e/db-driver-install-e2e.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyingRunner as copyingRunnerFor, type InstallCall } from "../../../helpers/db-driver-offline-install.ts";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { DB_DRIVERS, driverForEngine, driverLockfile, driverManifest, isDbDriverId } from "../../../../src/services/database/drivers/db-driver-catalog.ts";
import {
  dbDriverStatus, installCommand, installDbDriver, uninstallDbDriver, type Runner,
} from "../../../../src/services/database/drivers/db-driver-install.ts";
import { DbDriverMissingError, loadDbDriver, onDbDriverUnload, unloadDbDriver } from "../../../../src/services/database/drivers/db-driver-loader.ts";
import { dbDriverDir, dbDriversDir, readInstalledDriver } from "../../../../src/services/database/drivers/db-driver-store.ts";

const originalPpmHome = process.env.PPM_HOME;
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

type Call = InstallCall;
const copyingRunner = (calls: Call[], tamper?: (modules: string) => void): Runner => copyingRunnerFor("mysql", calls, tamper);

beforeEach(async () => {
  process.env.PPM_HOME = tempDir("ppm-db-driver-");
  _resetPpmDir();
  // The loader keeps a driver for the life of the process; each test has a PPM directory of its own.
  await unloadDbDriver("mysql");
  await unloadDbDriver("ssh");
});

afterEach(async () => {
  // Nor may the next file inherit this one's: it would load a driver its own directory lacks.
  await unloadDbDriver("mysql");
  await unloadDbDriver("ssh");
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
});

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("the catalog", () => {
  it("serves MySQL and MariaDB from one driver, and nothing else needs one", () => {
    expect(driverForEngine("mysql")?.id).toBe("mysql");
    expect(driverForEngine("mariadb")?.id).toBe("mysql");
    expect(driverForEngine("postgres")).toBeNull();
    expect(driverForEngine("sqlite")).toBeNull();
    expect(isDbDriverId("mysql")).toBe(true);
    expect(isDbDriverId("../mysql")).toBe(false);
    expect(isDbDriverId("mysql2")).toBe(false);
  });

  it("lists the SSH client as a driver no engine is served by", () => {
    expect(isDbDriverId("ssh")).toBe(true);
    expect(DB_DRIVERS.ssh.engines).toEqual([]);
    // The bundler cannot resolve its native addon; left a `require`, the guard refuses it at run time.
    expect(DB_DRIVERS.ssh.external).toEqual(["cpu-features"]);
  });

  it("pins a lockfile for the exact release it names, with a digest for every tarball", () => {
    for (const def of Object.values(DB_DRIVERS)) {
      const lock = driverLockfile(def.id) as {
        workspaces: Record<string, { name: string; dependencies: Record<string, string> }>;
        packages: Record<string, [string, string, unknown, string]>;
      };
      // A version bump without re-running the generator fails here rather than at install time.
      expect(lock.workspaces[""]).toEqual({ name: driverManifest(def).name, dependencies: driverManifest(def).dependencies });
      expect(lock.packages[def.package]?.[0]).toBe(`${def.package}@${def.version}`);
      for (const [name, entry] of Object.entries(lock.packages)) {
        expect({ name, integrity: entry[3] }).toMatchObject({ integrity: expect.stringMatching(/^sha512-/) });
      }
    }
  });
});

describe("installDbDriver", () => {
  it("installs one bundled file into the PPM directory and loads it", async () => {
    const calls: Call[] = [];
    const installed = await installDbDriver("mysql", { run: copyingRunner(calls) });

    expect(installed.version).toBe(DB_DRIVERS.mysql.version);
    expect(installed.file).toMatch(/^driver-[0-9a-f]{12}\.js$/);
    expect(installed.sha256.startsWith(installed.file.slice(7, 19))).toBe(true);
    expect(readdirSync(dbDriverDir("mysql")).sort()).toEqual(["driver.json", installed.file].sort());
    // The staging folder, node_modules and all, is gone.
    expect(readdirSync(dbDriversDir())).toEqual(["mysql"]);

    const api = await loadDbDriver<{ createPool: unknown }>("mysql");
    expect(typeof api.createPool).toBe("function");
    expect(dbDriverStatus("mysql")).toMatchObject({ state: "installed", installing: false, installed: { version: DB_DRIVERS.mysql.version } });
  });

  it("never reaches a package outside the bundle, only Node's own modules", async () => {
    // mysql2 asks for `cardinal` with a require the bundler cannot see through. Planted where a
    // lookup from the driver's folder would find it, it must still not run: the same lookup with
    // no `node_modules` above is what makes Bun download it from the registry instead.
    const planted = join(process.env.PPM_HOME!, "node_modules", "cardinal");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "package.json"), JSON.stringify({ name: "cardinal", version: "2.1.1", main: "index.js" }));
    writeFileSync(join(planted, "index.js"), "globalThis.__ppmPlantedCardinal = true; exports.highlight = (s) => s;");

    await installDbDriver("mysql", { run: copyingRunner([]) });
    const api = await loadDbDriver<{ createPool: unknown }>("mysql");

    expect(typeof api.createPool).toBe("function");
    expect((globalThis as { __ppmPlantedCardinal?: boolean }).__ppmPlantedCardinal).toBeUndefined();
  });

  it("bundles the SSH client without its native addon, which it then does without", async () => {
    // ssh2 tries `cpu-features` at load to order its ciphers. Planted where a lookup would find
    // it, it must not run: the bundle leaves it out and the guard refuses the require.
    const planted = join(process.env.PPM_HOME!, "node_modules", "cpu-features");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "package.json"), JSON.stringify({ name: "cpu-features", version: "0.0.10", main: "index.js" }));
    writeFileSync(join(planted, "index.js"), "globalThis.__ppmPlantedCpuFeatures = true; module.exports = () => ({ flags: {} });");

    const installed = await installDbDriver("ssh", { run: copyingRunnerFor("ssh", []) });
    const api = await loadDbDriver<{ Client: new () => { end(): void } }>("ssh");

    expect(installed.version).toBe(DB_DRIVERS.ssh.version);
    expect(typeof api.Client).toBe("function");
    new api.Client().end();
    expect((globalThis as { __ppmPlantedCpuFeatures?: boolean }).__ppmPlantedCpuFeatures).toBeUndefined();
    expect(dbDriverStatus("ssh")).toMatchObject({ state: "installed", engines: [], usedFor: "connections through an SSH tunnel" });
  });

  it("finds and bundles the driver in a child bun, never in this process", async () => {
    // Here `Bun.build` hung for good late in a long run, and a compiled PPM's `Bun.resolveSync`
    // cannot find a package that names its entry with `main` alone — ssh2 is one.
    const build = spyOn(Bun, "build");
    const resolve = spyOn(Bun, "resolveSync");
    try {
      await installDbDriver("ssh", { run: copyingRunnerFor("ssh", []) });
      expect(build).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
      resolve.mockRestore();
    }
    expect(dbDriverStatus("ssh").state).toBe("installed");
  });

  it("fills no import from outside the staging folder, wherever a package of that name is found", async () => {
    // Without `external`, ssh2's static require of an optional package the install skipped would
    // resolve up past the staging folder, to whatever is planted there.
    const planted = join(process.env.PPM_HOME!, "node_modules", "cpu-features");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "package.json"), JSON.stringify({ name: "cpu-features", version: "0.0.10", main: "index.js" }));
    writeFileSync(join(planted, "index.js"), "globalThis.__ppmPlantedCpuFeatures = true; module.exports = () => ({ flags: {} });");
    const external = DB_DRIVERS.ssh.external;
    DB_DRIVERS.ssh.external = undefined;
    try {
      const skipOptional = (modules: string) => rmSync(join(modules, "cpu-features"), { recursive: true, force: true });
      await installDbDriver("ssh", { run: copyingRunnerFor("ssh", [], skipOptional) });
      const api = await loadDbDriver<{ Client: new () => { end(): void } }>("ssh");
      new api.Client().end();
    } finally {
      DB_DRIVERS.ssh.external = external;
    }
    expect((globalThis as { __ppmPlantedCpuFeatures?: boolean }).__ppmPlantedCpuFeatures).toBeUndefined();
  });

  it("gives bun the pinned manifest and lockfile, a frozen install, no scripts, and BUN_BE_BUN", async () => {
    const calls: Call[] = [];
    await installDbDriver("mysql", { run: copyingRunner(calls) });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.cmd).toEqual(installCommand());
    expect(call!.cmd.slice(1)).toEqual(["install", "--frozen-lockfile", "--ignore-scripts", "--omit=peer"]);
    expect(call!.cmd[0]).toBe(process.execPath);
    expect(call!.env.BUN_BE_BUN).toBe("1");
    expect(call!.cwd.startsWith(dbDriversDir())).toBe(true);
    expect(call!.manifest).toEqual(driverManifest(DB_DRIVERS.mysql));
    expect(call!.lock).toEqual(driverLockfile("mysql"));
  });

  it("joins a second press of the button instead of starting another install", async () => {
    const calls: Call[] = [];
    const run = copyingRunner(calls);
    const [a, b] = await Promise.all([installDbDriver("mysql", { run }), installDbDriver("mysql", { run })]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("reports what bun said when the download fails, and records nothing", async () => {
    const run: Runner = async () => ({ code: 1, stdout: "", stderr: "error: Integrity check failed for tarball: mysql2" });
    await expect(installDbDriver("mysql", { run })).rejects.toThrow("Integrity check failed for tarball: mysql2");
    expect(readInstalledDriver("mysql")).toBeNull();
    expect(dbDriverStatus("mysql").state).toBe("missing");
    expect(readdirSync(dbDriversDir())).toEqual([]);
  });

  it("refuses a release other than the pinned one", async () => {
    const run = copyingRunner([], (modules) => {
      const manifest = join(modules, "mysql2", "package.json");
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "3.99.0" }));
    });
    await expect(installDbDriver("mysql", { run })).rejects.toThrow(`Expected mysql2@${DB_DRIVERS.mysql.version}, got 3.99.0`);
    expect(readInstalledDriver("mysql")).toBeNull();
  });

  it("does not count a bundle that lacks the driver's functions as installed", async () => {
    const run = copyingRunner([], (modules) => writeFileSync(join(modules, "mysql2", "promise.js"), "module.exports = { version: 1 };\n"));
    await expect(installDbDriver("mysql", { run })).rejects.toThrow("does not load: it does not export createPool");
    expect(readInstalledDriver("mysql")).toBeNull();
    expect(existsSync(dbDriverDir("mysql")) ? readdirSync(dbDriverDir("mysql")) : []).toEqual([]);
  });

  it("leaves a working install in place when a later install fails", async () => {
    const first = await installDbDriver("mysql", { run: copyingRunner([]) });
    await expect(installDbDriver("mysql", { run: async () => ({ code: 1, stdout: "", stderr: "offline" }) })).rejects.toThrow("offline");
    expect(readInstalledDriver("mysql")).toEqual(first);
    expect(dbDriverStatus("mysql").state).toBe("installed");
  });

  it("sweeps a staging folder a crashed install left behind, and not one another process is filling", async () => {
    const crashed = join(dbDriversDir(), ".staging-mysql-crashed");
    mkdirSync(join(crashed, "node_modules"), { recursive: true });
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(crashed, anHourAgo, anHourAgo);
    // `ppm db driver install` is a process of its own, installing the same driver at this moment.
    mkdirSync(join(dbDriversDir(), ".staging-mysql-cli", "node_modules"), { recursive: true });
    await installDbDriver("mysql", { run: copyingRunner([]) });
    expect(readdirSync(dbDriversDir()).sort()).toEqual([".staging-mysql-cli", "mysql"]);
  });

  describe("when the bundling child crashes", () => {
    const CRASH = "panic(main thread): Segmentation fault at address 0x8\noh no: Bun has crashed. This indicates a bug in Bun, not your code.";
    /** The bundling child, run for real. */
    const realBundle: Runner = async (cmd, { cwd, env }) => {
      const proc = Bun.spawn(cmd, { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, stdout, stderr };
    };
    /** A bundling child whose first `crashes` runs die the way Bun does, and the real one after. */
    const crashing = (crashes: number, calls: string[][]): Runner => async (cmd, options) => {
      calls.push(cmd);
      return calls.length <= crashes ? { code: 132, stdout: "", stderr: CRASH } : realBundle(cmd, options);
    };

    it("bundles once more after Bun itself crashed, and installs", async () => {
      const calls: string[][] = [];
      await installDbDriver("mysql", { run: copyingRunner([]), bundle: crashing(1, calls) });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]!);
      const api = await loadDbDriver<{ createPool: unknown }>("mysql");
      expect(typeof api.createPool).toBe("function");
    });

    it("gives up when it crashes again, saying what Bun said", async () => {
      const calls: string[][] = [];
      const installing = installDbDriver("mysql", { run: copyingRunner([]), bundle: crashing(2, calls) });
      await expect(installing).rejects.toThrow("Could not bundle mysql2: panic(main thread)");
      expect(calls).toHaveLength(2);
      expect(readInstalledDriver("mysql")).toBeNull();
    });

    it("does not try again when the bundling failed for a reason of its own", async () => {
      const calls: string[][] = [];
      const bundle: Runner = async (cmd) => {
        calls.push(cmd);
        return { code: 1, stdout: "", stderr: "mysql2 was installed without promise.js" };
      };
      await expect(installDbDriver("mysql", { run: copyingRunner([]), bundle })).rejects.toThrow("Could not bundle mysql2: mysql2 was installed without promise.js");
      expect(calls).toHaveLength(1);
    });
  });
});

describe("loading and removing", () => {
  it("answers a missing driver with a 424 that names it and says how to install it", async () => {
    const error = await loadDbDriver("mysql").then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DbDriverMissingError);
    const missing = error as DbDriverMissingError;
    expect(missing.status).toBe(424);
    expect(missing.code).toBe("DB_DRIVER_MISSING");
    expect(missing.driverId).toBe("mysql");
    expect(missing.message).toContain("MySQL / MariaDB driver is not installed");
    expect(missing.message).toContain("ppm db driver install mysql");
  });

  it("ignores a manifest that names a file outside the driver's folder", async () => {
    await installDbDriver("mysql", { run: copyingRunner([]) });
    // The file exists, so only the name check can be what refuses it.
    writeFileSync(join(dbDriversDir(), "evil.js"), "export const createPool = () => {};\n");
    const manifest = join(dbDriverDir("mysql"), "driver.json");
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), file: "../evil.js" }));
    expect(readInstalledDriver("mysql")).toBeNull();
  });

  it("closes what was built on the driver, then deletes it", async () => {
    await installDbDriver("mysql", { run: copyingRunner([]) });
    let closed = 0;
    onDbDriverUnload("mysql", () => { closed++; });

    await uninstallDbDriver("mysql");

    expect(closed).toBe(1);
    expect(existsSync(dbDriverDir("mysql"))).toBe(false);
    expect(dbDriverStatus("mysql")).toMatchObject({ state: "missing", installed: null });
    await expect(loadDbDriver("mysql")).rejects.toBeInstanceOf(DbDriverMissingError);
  });
});
