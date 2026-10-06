/**
 * Install a database driver without the network: a runner that "downloads"
 * by copying the pinned packages out of the repository's own `node_modules`
 * (the driver is a devDependency for exactly this). Everything after the
 * download is the real installer — the bundle, the import that checks it, the
 * manifest.
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { driverLockfile, type DbDriverId } from "../../src/services/database/drivers/db-driver-catalog.ts";
import type { Runner } from "../../src/services/database/drivers/db-driver-install.ts";

const REPO_MODULES = resolve(import.meta.dir, "../../node_modules");

/** What `bun install` was asked to do, as the runner saw it. */
export interface InstallCall { cmd: string[]; cwd: string; env: Record<string, string | undefined>; manifest: unknown; lock: unknown }

type LockEntry = [string, string, { optionalDependencies?: Record<string, string> }?, string?];

/** The packages the pinned lockfile installs, minus the peer dependencies `--omit=peer` skips. */
export function lockedPackages(id: DbDriverId): string[] {
  const lock = driverLockfile(id) as { packages: Record<string, unknown> };
  return Object.keys(lock.packages).filter((name) => name !== "@types/node" && name !== "undici-types");
}

/** What some package in the lockfile only optionally depends on, such as ssh2's native `cpu-features`. */
function optionalPackages(id: DbDriverId): Set<string> {
  const lock = driverLockfile(id) as { packages: Record<string, LockEntry> };
  return new Set(Object.values(lock.packages).flatMap((entry) => Object.keys(entry[2]?.optionalDependencies ?? {})));
}

export function copyingRunner(id: DbDriverId, calls: InstallCall[] = [], tamper?: (modules: string) => void): Runner {
  return async (cmd, { cwd, env }) => {
    calls.push({
      cmd, cwd, env,
      manifest: JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")),
      lock: JSON.parse(readFileSync(join(cwd, "bun.lock"), "utf8")),
    });
    const modules = join(cwd, "node_modules");
    mkdirSync(modules, { recursive: true });
    const optional = optionalPackages(id);
    // Copied, not symlinked: a symlink needs a privilege on Windows. An optional package the
    // repository's own install skipped is one a real install may skip too.
    for (const name of lockedPackages(id)) {
      const from = join(REPO_MODULES, name);
      if (!existsSync(from) && optional.has(name)) continue;
      cpSync(from, join(modules, name), { recursive: true });
    }
    tamper?.(modules);
    return { code: 0, stdout: "", stderr: "" };
  };
}
