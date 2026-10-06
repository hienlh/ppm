/**
 * Pin the whole dependency tree of every database driver PPM can install.
 *
 * `version` in the catalog pins one package; its dependencies are semver
 * ranges, so an install next month could pull a transitive release nobody here
 * ever ran — which is exactly how a compromised patch release reaches an app.
 * This writes the lockfile of each driver as resolved today, SHA-512 per
 * tarball, and the installer refuses to deviate from it (`--frozen-lockfile`).
 *
 * The output is committed. Re-run after changing a driver in the catalog:
 *
 *   bun scripts/gen-db-driver-locks.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DB_DRIVERS, driverManifest } from "../src/services/database/drivers/db-driver-catalog.ts";

const OUT = resolve(import.meta.dir, "../src/services/database/drivers/db-driver-locks.generated.json");

const locks: Record<string, unknown> = {};
for (const def of Object.values(DB_DRIVERS)) {
  const dir = mkdtempSync(join(tmpdir(), `ppm-db-driver-${def.id}-`));
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(driverManifest(def), null, 2)}\n`);
    // Resolving a tree never needs anyone's install script to run.
    const proc = Bun.spawnSync([process.execPath, "install", "--ignore-scripts"], {
      cwd: dir,
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(`bun install failed for ${def.package}@${def.version}: ${proc.stderr.toString()}`);
    locks[def.id] = Bun.JSONC.parse(readFileSync(join(dir, "bun.lock"), "utf8"));
    console.log(`pinned ${def.package}@${def.version}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
writeFileSync(OUT, `${JSON.stringify(locks, null, 2)}\n`);
console.log(`wrote ${OUT}`);
