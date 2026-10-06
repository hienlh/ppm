/**
 * Loading an installed driver into PPM's process.
 *
 * The bundle is one self-contained file because nothing else can be loaded
 * from outside a compiled PPM: measured, a `bun build --compile` binary imports
 * a file by absolute path but cannot resolve *that file's* own imports — mysql2
 * loaded from its `node_modules` failed with `Cannot find package
 * 'sql-escaper'`, with the package sitting right beside it. Bundled at install
 * time, the same code loads and runs, TLS included.
 *
 * A module can never be unloaded, so "unload" means: run the hooks that close
 * every pool built on it, and forget it, so the next use reads the manifest
 * again. A reinstall writes a file with a new name, and a new URL is a new module.
 */
import { pathToFileURL } from "node:url";
import { createLogger } from "../../logger.ts";
import { DB_DRIVERS, type DbDriverDefinition, type DbDriverId } from "./db-driver-catalog.ts";
import { installedBundlePath, readInstalledDriver } from "./db-driver-store.ts";

const log = createLogger("db");

/** Bundles already reported as not loading: a failed load is retried by every use of the driver. */
const loggedLoadFailures = new Set<string>();

/**
 * A connection needs a driver that is not installed (or no longer loads).
 * Routes answer it with 424 and `code`, which is what the browser draws its
 * Install button from.
 */
export class DbDriverMissingError extends Error {
  readonly status = 424;
  readonly code = "DB_DRIVER_MISSING";
  readonly driverId: DbDriverId;
  readonly driverName: string;

  constructor(def: DbDriverDefinition, reason?: string) {
    const how = `Install it in Settings → Database Drivers, or run: ppm db driver install ${def.id}`;
    super(reason ? `The ${def.displayName} driver cannot be loaded (${reason}). ${how}` : `The ${def.displayName} driver is not installed. ${how}`);
    this.driverId = def.id;
    this.driverName = def.displayName;
  }
}

const loaded = new Map<DbDriverId, Promise<unknown>>();
const unloadHooks = new Map<DbDriverId, Set<() => Promise<void> | void>>();

/** The driver's module, the one its catalog entry names; loaded once per install. */
export function loadDbDriver<T>(id: DbDriverId): Promise<T> {
  let pending = loaded.get(id);
  if (!pending) {
    pending = importInstalled(DB_DRIVERS[id]);
    loaded.set(id, pending);
    // A failed load is not remembered: pressing Install must be enough to fix it.
    pending.catch(() => { if (loaded.get(id) === pending) loaded.delete(id); });
  }
  return pending as Promise<T>;
}

/** Import one bundle and check it exports what its catalog entry says. */
export async function importDriverBundle(def: DbDriverDefinition, file: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  // A CommonJS entry bundled to ESM puts its `module.exports` on `default`.
  const fallback = mod.default;
  const api = (fallback !== null && (typeof fallback === "object" || typeof fallback === "function") ? fallback : mod) as Record<string, unknown>;
  const missing = def.exports.filter((name) => typeof api[name] !== "function");
  if (missing.length > 0) throw new Error(`it does not export ${missing.join(", ")}`);
  return api;
}

async function importInstalled(def: DbDriverDefinition): Promise<unknown> {
  const installed = readInstalledDriver(def.id);
  if (!installed) throw new DbDriverMissingError(def);
  try {
    return await importDriverBundle(def, installedBundlePath(installed));
  } catch (e) {
    // Answered with a 424 and an Install button, which is no record that an install broke.
    const key = `${def.id} ${String(installed.file)}`;
    if (!loggedLoadFailures.has(key)) {
      loggedLoadFailures.add(key);
      log.error(`installed DB driver ${def.id} ${installed.version} failed to load from ${String(installed.file)}: ${(e as Error).message}`);
    }
    throw new DbDriverMissingError(def, (e as Error).message);
  }
}

/** The installer has just loaded and checked this module; later uses get it without a second import. */
export function rememberLoadedDriver(id: DbDriverId, api: unknown): void {
  loaded.set(id, Promise.resolve(api));
}

/** Run `hook` when the driver is removed — a service closes the pools it built on it. */
export function onDbDriverUnload(id: DbDriverId, hook: () => Promise<void> | void): void {
  let hooks = unloadHooks.get(id);
  if (!hooks) unloadHooks.set(id, hooks = new Set());
  hooks.add(hook);
}

export async function unloadDbDriver(id: DbDriverId): Promise<void> {
  loaded.delete(id);
  for (const hook of unloadHooks.get(id) ?? []) {
    try { await hook(); } catch { /* a pool that fails to close is already as good as closed */ }
  }
}
