/**
 * Where installed database drivers live and how PPM records one.
 *
 * `<ppm dir>/db-drivers/<id>/` holds a single bundled file, `driver-<sha>.js`,
 * and `driver.json` naming it. The manifest is written last, by rename, so it
 * only ever names a file that is complete and has already been loaded once;
 * a crash mid-install leaves the previous install untouched. Inside the PPM
 * directory so `PPM_HOME` isolates it for tests, and deleting the folder is the
 * whole uninstall.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPpmDir } from "../../ppm-dir.ts";
import type { DbDriverId } from "./db-driver-catalog.ts";

export interface InstalledDbDriver {
  id: DbDriverId;
  package: string;
  version: string;
  /** The bundle, a bare file name inside the driver's folder. */
  file: string;
  sha256: string;
  bytes: number;
  installedAt: string;
}

/** A bundle's name carries the start of its digest, so a new build never reuses an old file's module URL. */
const BUNDLE_NAME = /^driver-[0-9a-f]{12}\.js$/;

export function dbDriversDir(): string {
  return path.join(getPpmDir(), "db-drivers");
}

export function dbDriverDir(id: DbDriverId): string {
  return path.join(dbDriversDir(), id);
}

function manifestPath(id: DbDriverId): string {
  return path.join(dbDriverDir(id), "driver.json");
}

export function bundleFileName(sha256: string): string {
  return `driver-${sha256.slice(0, 12)}.js`;
}

/** The recorded install, or null when there is none or its file is gone. Never throws. */
export function readInstalledDriver(id: DbDriverId): InstalledDbDriver | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath(id), "utf8"));
  } catch {
    return null;
  }
  const m = raw as Partial<InstalledDbDriver> | null;
  if (
    !m || m.id !== id || typeof m.package !== "string" || typeof m.version !== "string"
    || typeof m.file !== "string" || !BUNDLE_NAME.test(m.file)
    || typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)
    || typeof m.bytes !== "number" || typeof m.installedAt !== "string"
  ) return null;
  if (!existsSync(installedBundlePath(m as InstalledDbDriver))) return null;
  return m as InstalledDbDriver;
}

export function installedBundlePath(installed: Pick<InstalledDbDriver, "id" | "file">): string {
  return path.join(dbDriverDir(installed.id), installed.file);
}

/** Record an install. By rename, so a reader sees the old manifest or the new one, never half of one. */
export function writeInstalledDriver(installed: InstalledDbDriver): void {
  const target = manifestPath(installed.id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(installed, null, 2)}\n`);
  renameSync(tmp, target);
}
