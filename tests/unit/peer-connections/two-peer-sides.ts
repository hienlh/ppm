/**
 * Two PPMs in one test process: each side has its own PPM directory (identity and storage key)
 * and its own database file. `side.run(fn)` switches every singleton to that side for the call.
 * The database singleton closes the previous instance on every switch, so each side's database is
 * a file reopened on entry rather than an in-memory one.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { applyDbPragmas, getDb, openTestDb, runMigrations, setDb } from "../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { resetPeerIdentityCache } from "../../../src/services/peer-connections/peer-identity.ts";
import { resetPeerKeyStoreCache } from "../../../src/services/peer-connections/peer-key-store.ts";

const originalHome = process.env.PPM_HOME!;

export interface PeerSide {
  name: string;
  home: string;
  run<T>(fn: () => T): T;
}

function enter(home: string): void {
  process.env.PPM_HOME = home;
  _resetPpmDir();
  resetPeerIdentityCache();
  resetPeerKeyStoreCache();
  const db = new Database(join(home, "ppm.db"));
  applyDbPragmas(db);
  setDb(db);
}

export function makePeerSide(name: string): PeerSide {
  const home = mkdtempSync(join(originalHome, `peer-${name}-`));
  mkdirSync(home, { recursive: true });
  enter(home);
  // Migrate once; later entries only reopen.
  runMigrations(getDb());
  return {
    name,
    home,
    run<T>(fn: () => T): T {
      enter(home);
      return fn();
    },
  };
}

/** Put the process back on the shared test home and a fresh in-memory database. */
export function leavePeerSides(): void {
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  resetPeerIdentityCache();
  resetPeerKeyStoreCache();
  setDb(openTestDb());
}
