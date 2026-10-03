/**
 * What the server says about installable database drivers — the Settings pane
 * lists these, and a route that needed a missing one answers with
 * `DB_DRIVER_MISSING` so the browser can offer the Install button in place.
 */
import type { DbType } from "./db-types.ts";

export type DbDriverState = "missing" | "installed" | "outdated";

export interface DbDriverStatus {
  id: string;
  displayName: string;
  engines: DbType[];
  /** Which connections need it, written to follow "Open …": `MySQL and MariaDB connections`. */
  usedFor: string;
  /** The npm package and the exact release an install gets. */
  package: string;
  version: string;
  license: string;
  homepage: string;
  /** `outdated`: installed, but not the release this PPM pins. It still loads. */
  state: DbDriverState;
  installed: { version: string; installedAt: string; bytes: number; sha256: string } | null;
  installing: boolean;
  removing: boolean;
}

export const DB_DRIVER_MISSING = "DB_DRIVER_MISSING";

/** The 424 body: the usual `{ ok: false, error }` plus which driver to install. */
export interface DbDriverMissingBody {
  ok: false;
  error: string;
  code: typeof DB_DRIVER_MISSING;
  driver: { id: string; displayName: string };
}
