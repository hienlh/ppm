/**
 * The `web_browser` row must load back after a restart. `assembleConfig` only copies stored rows
 * whose key exists in `DEFAULT_CONFIG`, so a key missing there is written and then silently
 * ignored on the next start.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDbPragmas, openTestDb, runMigrations, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { parseWebBrowserSettings } from "../../../src/shared/web-browser-settings.ts";

let dir: string;
let file: string;
let db: Database | null = null;

/** Other test files share this process and expect the preload's in-memory, auth-off config. */
function restoreSharedConfig(): void {
  setDb(openTestDb());
  configService.load();
  (configService as unknown as { config: { auth: unknown } }).config.auth = { enabled: false, token: "" };
}

function restart(): void {
  db?.close();
  db = new Database(file);
  applyDbPragmas(db);
  runMigrations(db);
  setDb(db);
  configService.load();
}

describe("web_browser config row", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-web-browser-config-"));
    file = join(dir, "ppm.db");
    restart();
  });

  afterEach(() => {
    restoreSharedConfig();
    db?.close();
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts undecided", () => {
    expect(parseWebBrowserSettings(configService.get("web_browser")).enabled).toBeUndefined();
  });

  it("keeps a saved answer and limits across a restart", () => {
    configService.set("web_browser", { ...parseWebBrowserSettings({}), enabled: true, maxTabs: 2, allowLan: false });
    restart();
    const s = parseWebBrowserSettings(configService.get("web_browser"));
    expect(s.enabled).toBe(true);
    expect(s.maxTabs).toBe(2);
    expect(s.allowLan).toBe(false);
  });
});
