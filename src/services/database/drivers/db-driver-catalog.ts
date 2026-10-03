/**
 * The database drivers PPM installs on request instead of shipping.
 *
 * Postgres (`postgres.js`) and SQLite (`bun:sqlite`) stay built in, so a
 * connection that works today keeps working after an upgrade. Every other
 * engine's driver is an npm package that only people who use that engine need,
 * so Settings → Database Drivers installs it into the PPM directory when someone
 * presses Install — the same consent model as the editor's language servers.
 *
 * Each entry is pinned twice over. `version` is the exact release PPM was tested
 * against, and `db-driver-locks.generated.json` holds the lockfile of that
 * release's whole dependency tree, with the registry's SHA-512 for every
 * tarball. The installer runs `bun install --frozen-lockfile` against it, so a
 * dependency published after testing — the usual way a supply-chain attack
 * reaches an app — is never picked up, and a tarball that does not match its
 * recorded digest fails the install. After changing a version:
 *
 *   bun scripts/gen-db-driver-locks.ts
 */
import type { DbType } from "../../../shared/db-types.ts";
import LOCKS from "./db-driver-locks.generated.json" with { type: "json" };

export const DB_DRIVER_IDS = ["mysql", "ssh"] as const;

export type DbDriverId = (typeof DB_DRIVER_IDS)[number];

export interface DbDriverDefinition {
  id: DbDriverId;
  /** What Settings and error messages call it. */
  displayName: string;
  /** The connection types it serves; none for a driver every server connection may use (SSH). */
  engines: readonly DbType[];
  /** Which connections need it, written to follow "Open …": Settings and `ppm db driver list` show it. */
  usedFor: string;
  /** The npm package, and the exact release installed. */
  package: string;
  version: string;
  license: string;
  homepage: string;
  /** The module that is bundled into the driver's single file. */
  entry: string;
  /** Functions the bundle must export before it counts as installed. */
  exports: readonly string[];
  /**
   * Optional imports the bundler must not follow. They stay `require` calls, which the bundle's
   * builtins-only guard then refuses, so the package takes the fallback it has for them missing.
   */
  external?: readonly string[];
}

export const DB_DRIVERS: Record<DbDriverId, DbDriverDefinition> = {
  mysql: {
    id: "mysql",
    displayName: "MySQL / MariaDB",
    engines: ["mysql", "mariadb"],
    usedFor: "MySQL and MariaDB connections",
    package: "mysql2",
    version: "3.24.4",
    license: "MIT",
    homepage: "https://sidorares.github.io/node-mysql2/docs",
    entry: "mysql2/promise",
    exports: ["createPool"],
  },
  ssh: {
    id: "ssh",
    displayName: "SSH tunnel",
    engines: [],
    usedFor: "connections through an SSH tunnel",
    package: "ssh2",
    version: "1.17.0",
    license: "MIT",
    homepage: "https://github.com/mscdex/ssh2",
    entry: "ssh2",
    exports: ["Client"],
    // A native addon it only uses to pick a faster cipher order; it has pure-JS defaults.
    external: ["cpu-features"],
  },
};

export function isDbDriverId(value: unknown): value is DbDriverId {
  return typeof value === "string" && (DB_DRIVER_IDS as readonly string[]).includes(value);
}

/** The driver a connection type needs installed, or null when it is built in. */
export function driverForEngine(type: DbType): DbDriverDefinition | null {
  return Object.values(DB_DRIVERS).find((d) => d.engines.includes(type)) ?? null;
}

/** The staging directory's manifest: the one dependency, at its exact version. */
export function driverManifest(def: DbDriverDefinition): { name: string; private: true; dependencies: Record<string, string> } {
  return { name: `ppm-db-driver-${def.id}`, private: true, dependencies: { [def.package]: def.version } };
}

/** The lockfile `bun install --frozen-lockfile` checks every tarball against. */
export function driverLockfile(id: DbDriverId): unknown {
  const lock = (LOCKS as Record<string, unknown>)[id];
  if (!lock) throw new Error(`No pinned lockfile for the ${id} driver — run bun scripts/gen-db-driver-locks.ts`);
  return lock;
}
