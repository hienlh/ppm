/**
 * Installing a database driver, when someone presses Install.
 *
 * Nothing here runs because a connection was opened: a connection whose driver
 * is missing answers `DB_DRIVER_MISSING` and the browser offers the button.
 * Pressing it is the consent. The route takes a driver **id** and nothing else,
 * so no request can name a package, a version or a registry.
 *
 * One install is five steps, each checked:
 *
 * 1. A fresh staging folder gets the catalog's `package.json` and pinned
 *    lockfile — its own manifest, because `bun add` in a folder without one
 *    installs into the nearest parent that has one.
 * 2. `bun install --frozen-lockfile --ignore-scripts --omit=peer` downloads
 *    exactly the pinned tree, every tarball against its recorded SHA-512, and
 *    runs no package's install script. It is carried out by the binary running
 *    PPM: bun itself from source, and a compiled PPM — which *is* bun — with
 *    `BUN_BE_BUN=1`, measured to install on a host with no bun at all.
 * 3. `Bun.build` bundles the entry into one file, because a compiled PPM
 *    cannot resolve the dependencies of a file it loads from outside itself —
 *    from the staging folder alone, and in a child bun (`BUNDLE_SCRIPT`).
 * 4. The bundle is imported and must export what the catalog says, or it does
 *    not count as installed.
 * 5. `driver.json` is written last, by rename. Anything failing before that
 *    leaves the previous install — if there was one — exactly as it was.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DbDriverStatus } from "../../../shared/db-drivers.ts";
import { createLogger } from "../../logger.ts";
import { DB_DRIVERS, DB_DRIVER_IDS, driverLockfile, driverManifest, type DbDriverDefinition, type DbDriverId } from "./db-driver-catalog.ts";
import { importDriverBundle, rememberLoadedDriver, unloadDbDriver } from "./db-driver-loader.ts";
import {
  bundleFileName, dbDriverDir, dbDriversDir, readInstalledDriver, writeInstalledDriver, type InstalledDbDriver,
} from "./db-driver-store.ts";

const log = createLogger("db");

/** A cold download of a driver and its dependencies; generous for a slow link. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How a command is run — one seam, so a test can install without the network. */
export type Runner = (
  cmd: string[],
  options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<RunResult>;

const runCommand: Runner = async (cmd, { cwd, env, timeoutMs }) => {
  const proc = Bun.spawn(cmd, { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    log.warn(`DB driver ${path.basename(cmd[0] ?? "")} ${cmd[1] ?? ""} timed out after ${Math.round(timeoutMs / 1000)}s; killed pid=${proc.pid}`);
    proc.kill();
  }, timeoutMs);
  // Drained while it runs: a full pipe blocks the child instead of failing it.
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

export function installCommand(): string[] {
  return [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--omit=peer"];
}

/** One at a time: installs share the network, the bun cache and the drivers folder. */
let queue: Promise<unknown> = Promise.resolve();
/** Keyed by operation and id, so a second click joins the running install instead of starting another. */
const inFlight = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const started = queue.then(work);
  queue = started.catch(() => {}); // a failure must not poison the queue behind it
  const tracked = started.finally(() => inFlight.delete(key));
  inFlight.set(key, tracked);
  return tracked;
}

export function installDbDriver(
  id: DbDriverId,
  /** `run` downloads, `bundle` runs the child that bundles: seams for a test, the real commands otherwise. */
  options: { run?: Runner; bundle?: Runner } = {},
): Promise<InstalledDbDriver> {
  return enqueue(`install:${id}`, async () => {
    // A failure needs no line here: the route answers it with a 500 (the CLI prints it).
    const startedAt = performance.now();
    const installed = await install(DB_DRIVERS[id], options.run ?? runCommand, options.bundle ?? runCommand);
    log.info(
      `installed DB driver ${id} ${installed.package}@${installed.version} ` +
      `(${installed.bytes} B, sha256 ${installed.sha256.slice(0, 12)}) in ${Math.round(performance.now() - startedAt)}ms`,
    );
    return installed;
  });
}

/** Remove a driver: close every pool built on it, then delete its folder. */
export function uninstallDbDriver(id: DbDriverId): Promise<void> {
  return enqueue(`uninstall:${id}`, async () => {
    await unloadDbDriver(id);
    rmSync(dbDriverDir(id), { recursive: true, force: true });
    log.info(`removed DB driver ${id}`);
  });
}

export function dbDriverStatus(id: DbDriverId): DbDriverStatus {
  const def = DB_DRIVERS[id];
  const installed = readInstalledDriver(id);
  return {
    id,
    displayName: def.displayName,
    engines: [...def.engines],
    usedFor: def.usedFor,
    package: def.package,
    version: def.version,
    license: def.license,
    homepage: def.homepage,
    state: !installed ? "missing" : installed.version === def.version ? "installed" : "outdated",
    installed: installed
      ? { version: installed.version, installedAt: installed.installedAt, bytes: installed.bytes, sha256: installed.sha256 }
      : null,
    installing: inFlight.has(`install:${id}`),
    removing: inFlight.has(`uninstall:${id}`),
  };
}

export function listDbDrivers(): DbDriverStatus[] {
  return DB_DRIVER_IDS.map(dbDriverStatus);
}

async function install(def: DbDriverDefinition, run: Runner, runBundle: Runner): Promise<InstalledDbDriver> {
  const root = dbDriversDir();
  mkdirSync(root, { recursive: true });
  sweepStaging(root, def.id);
  const staging = mkdtempSync(path.join(root, `.staging-${def.id}-`));
  try {
    writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(driverManifest(def), null, 2)}\n`);
    writeFileSync(path.join(staging, "bun.lock"), `${JSON.stringify(driverLockfile(def.id), null, 2)}\n`);
    const result = await run(installCommand(), {
      cwd: staging,
      env: { ...process.env, BUN_BE_BUN: "1" },
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (result.code !== 0) throw new Error(`Could not download ${def.package}@${def.version}: ${output(result)}`);
    const version = installedVersion(staging, def);

    const bundle = await bundleEntry(staging, def, runBundle);
    const sha256 = new Bun.CryptoHasher("sha256").update(bundle).digest("hex");
    const file = bundleFileName(sha256);
    const dir = dbDriverDir(def.id);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, file);
    writeFileSync(`${target}.tmp`, bundle);
    renameSync(`${target}.tmp`, target);

    let api: unknown;
    try {
      api = await importDriverBundle(def, target);
    } catch (e) {
      // Only a file this install created goes; the same bytes may already be the live install.
      if (readInstalledDriver(def.id)?.file !== file) rmSync(target, { force: true });
      throw new Error(`The ${def.displayName} driver was built but does not load: ${(e as Error).message}`);
    }

    const installed: InstalledDbDriver = {
      id: def.id, package: def.package, version, file, sha256, bytes: bundle.byteLength, installedAt: new Date().toISOString(),
    };
    writeInstalledDriver(installed);
    removeStaleBundles(dir, file);
    rememberLoadedDriver(def.id, api);
    return installed;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The version that actually landed, which must be the pinned one. */
function installedVersion(staging: string, def: DbDriverDefinition): string {
  let version: unknown;
  try {
    version = JSON.parse(readFileSync(path.join(staging, "node_modules", def.package, "package.json"), "utf8")).version;
  } catch {
    throw new Error(`bun reported success, but ${def.package} is not in the install folder`);
  }
  if (version !== def.version) throw new Error(`Expected ${def.package}@${def.version}, got ${String(version)}`);
  return version;
}

/**
 * Put at the top of every bundle: its `require` answers Node's own modules and nothing else.
 *
 * The bundler leaves a `require` it cannot resolve for runtime, and mysql2 has one on purpose,
 * `require(\`cardinal${REQUIRE_TERMINATOR}\`)` for an optional debug highlighter. At runtime that
 * lookup walks up from the bundle's folder, so it loads any `cardinal` above the PPM directory (a
 * `~/node_modules` someone once ran `npm i` in), and in a process whose entry file has no
 * `node_modules` above it Bun *auto-installs* the latest one from the registry instead. Either way
 * it is code no digest covered, running inside PPM. Measured with an empty package cache and such
 * an entry, the plain bundle downloaded cardinal, redeyed, esprima and ansicolors on its first
 * import; with this, nothing, and mysql2 took its own fallback. A compiled PPM never auto-installs
 * but walks up just the same. Assigning `import.meta.require` throws if a later Bun makes it
 * read-only, which fails the install's load check rather than letting an unguarded bundle in.
 */
const BUILTINS_ONLY_REQUIRE = `import { isBuiltin as __ppmIsBuiltin } from "node:module";
{
  const builtin = import.meta.require;
  import.meta.require = (id) => {
    if (__ppmIsBuiltin(id)) return builtin(id);
    const e = new Error("Cannot find module '" + id + "'");
    e.code = "MODULE_NOT_FOUND";
    throw e;
  };
}`;

/** A bundle that takes this long is stuck, not slow: one takes well under a second. */
const BUNDLE_TIMEOUT_MS = 60_000;

/**
 * Step 3, carried out by a child bun with `--eval`, which reads its job from `PPM_DRIVER_BUNDLE`.
 *
 * A child, because `Bun.build` with a JS plugin does not always come back in a process that has
 * been running for a while. Measured in the full unit suite: the plugin answered its last resolve
 * and the build never settled — that install waited forever, and every install queued behind it —
 * and in two runs out of four Bun segfaulted at that point instead. A child that hangs is killed
 * by the timeout and one that crashes fails this install; neither takes PPM down with it.
 *
 * The child also finds the entry, and every package the plugin looks up. A compiled PPM's
 * `Bun.resolveSync` cannot find a package that names its entry with `main` alone — ssh2, and most
 * of what ssh2 and mysql2 depend on: measured, `Cannot find package 'ssh2'` with the package right
 * there in the staging folder, so the SSH driver could not be installed by a release at all, and
 * the plugin let every such lookup through to the bundler unchecked. The child runs as bun
 * (`BUN_BE_BUN`), whose resolver reads `main`.
 *
 * The plugin keeps a bundle to what the pinned install put in the staging folder. The bundler
 * resolves a package the way a runtime does, walking up past the folder it was given, so an import
 * the install did not satisfy — an optional dependency it skipped — would otherwise be filled from
 * any `node_modules` above the PPM directory, into a file that is then loaded as the driver.
 * Measured with ssh2: a `cpu-features` planted in the PPM directory's parent ended up inside the
 * bundle. Such an import is left for run time instead, where the builtins-only guard refuses it.
 *
 * A string rather than a function's `toString()`: a function's source names what it closes over —
 * the module's `path` import here — and none of that exists in the child.
 */
const BUNDLE_SCRIPT = `
const path = require("node:path");
const { writeFileSync } = require("node:fs");
const job = JSON.parse(process.env.PPM_DRIVER_BUNDLE);
let entry;
try {
  entry = Bun.resolveSync(job.entry, job.staging);
} catch {
  console.error(job.package + " was installed without " + job.entry);
  process.exit(1);
}
const stagingOnly = {
  name: "ppm-staging-only",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      let resolved;
      try {
        resolved = Bun.resolveSync(args.path, path.dirname(args.importer));
      } catch {
        return undefined; // the bundler reports what it cannot find
      }
      const inside = path.relative(job.staging, resolved);
      return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? undefined : { path: args.path, external: true };
    });
  },
};
const result = await Bun.build({
  entrypoints: [entry], target: "bun", format: "esm", banner: job.banner, external: job.external, plugins: [stagingOnly],
});
if (!result.success || result.outputs.length !== 1) {
  console.error(result.logs.map(String).join("; ") || "no output");
  process.exit(1);
}
writeFileSync(job.out, new Uint8Array(await result.outputs[0].arrayBuffer()));
`;

/**
 * What Bun prints when it panics. The bundling child did, once in six runs of the whole unit suite
 * (a segfault inside `Bun.build`), and never in 200 bundles of the same driver on their own.
 */
const BUN_CRASHED = /Bun has crashed/;

/** The entry and everything it imports, as one ESM file that needs nothing beside it and can reach nothing but Node. */
async function bundleEntry(staging: string, def: DbDriverDefinition, runBundle: Runner): Promise<Uint8Array> {
  const out = path.join(staging, ".ppm-bundle.js");
  const job = {
    package: def.package, entry: def.entry, staging, out, banner: BUILTINS_ONLY_REQUIRE, external: [...(def.external ?? [])],
  };
  const bundle = () => runBundle([process.execPath, "--eval", BUNDLE_SCRIPT], {
    cwd: staging,
    env: { ...process.env, BUN_BE_BUN: "1", PPM_DRIVER_BUNDLE: JSON.stringify(job) },
    timeoutMs: BUNDLE_TIMEOUT_MS,
  });
  let result = await bundle();
  // A crash of Bun's own says nothing about the driver, and did not come back: it gets one more go.
  if (result.code !== 0 && BUN_CRASHED.test(result.stderr)) result = await bundle();
  if (result.code !== 0) throw new Error(`Could not bundle ${def.package}: ${output(result)}`);
  return new Uint8Array(readFileSync(out));
}

/** Earlier builds of this driver: still on disk only because the new one had to load first. */
function removeStaleBundles(dir: string, keep: string): void {
  for (const name of readdirSync(dir)) {
    if (name !== keep && /^driver-[0-9a-f]{12}\.js(\.tmp)?$/.test(name)) rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * How long a staging folder can go unchanged while an install is still using it. Every step of an
 * install writes into the folder and is killed at its timeout, so no live install leaves it alone
 * for longer than the download's timeout plus two bundles' (a crashed one is run once more); the
 * extra minute is the steps in between.
 */
const STALE_STAGING_MS = INSTALL_TIMEOUT_MS + 2 * BUNDLE_TIMEOUT_MS + 60_000;

/**
 * A staging folder left by a crash. Installs are serialised within one process only: `ppm db
 * driver install` is a process of its own and may be filling a folder right now, so only one that
 * has not changed for longer than any install takes is swept.
 */
function sweepStaging(root: string, id: DbDriverId): void {
  for (const name of readdirSync(root)) {
    if (!name.startsWith(`.staging-${id}-`)) continue;
    const dir = path.join(root, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs < STALE_STAGING_MS) continue;
    } catch {
      continue; // gone: the install that made it has finished
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What a failed command said, bounded — the last 400 characters hold the reason. */
function output(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-400) || `exit ${result.code}`;
}
