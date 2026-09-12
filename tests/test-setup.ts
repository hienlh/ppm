import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// Set PPM_HOME to isolated temp dir BEFORE any service imports
const testPpmHome = mkdtempSync(resolve(tmpdir(), "ppm-test-"));
process.env.PPM_HOME = testPpmHome;

// Create subdirectories that services expect
mkdirSync(resolve(testPpmHome, "bin"), { recursive: true });
mkdirSync(resolve(testPpmHome, "extensions"), { recursive: true });
mkdirSync(resolve(testPpmHome, "bot"), { recursive: true });

// Now import services (they'll resolve to temp dir via getPpmDir())
import { setDb, openTestDb } from "../src/services/db.service.ts";
import { configService } from "../src/services/config.service.ts";

// Use in-memory DB for all tests (prevents polluting real DB)
setDb(openTestDb());

// Bring the config service up against that throwaway database. It refuses to persist until
// load() has run, because writing pristine defaults over a live instance once blanked the auth
// token and deleted every project — but here PPM_HOME is a fresh temp dir and the database is
// in-memory, so there is nothing to protect and fixtures write config legitimately.
configService.load();

// Disable auth for all tests
const config = (configService as any).config;
config.auth.enabled = false;

// Cleanup temp dir after all tests (best-effort)
process.on("exit", () => {
  try { rmSync(testPpmHome, { recursive: true, force: true }); } catch {}
});
