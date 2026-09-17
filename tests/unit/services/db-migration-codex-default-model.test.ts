import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, CURRENT_SCHEMA_VERSION } from "../../../src/services/db.service.ts";
import { CODEX_DEFAULT_MODEL } from "../../../src/types/config.ts";

/** The migration under test is v45, so a database has to start at 44 for it to run. */
const VERSION_BEFORE_CODEX_MODEL_MIGRATION = 44;

/**
 * Upgrading an install that configured codex before there was a default model.
 *
 * Built at the version just before the migration so the upgrade really runs,
 * rather than starting from a fresh database where there is no config to patch.
 *
 * Pinned to a literal rather than `CURRENT_SCHEMA_VERSION - 1`: that spelling tracks the
 * newest migration, not this one, so the day a v46 was added these tests quietly started
 * from 45 — past the migration they exist to exercise — and failed for a reason that had
 * nothing to do with what they check.
 */
function dbWithAiConfig(ai: unknown, version = VERSION_BEFORE_CODEX_MODEL_MIGRATION): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
  if (ai !== undefined) {
    db.query("INSERT INTO config (key, value) VALUES ('ai', ?)").run(JSON.stringify(ai));
  }
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

function aiConfig(db: Database): Record<string, any> {
  const row = db.query("SELECT value FROM config WHERE key = 'ai'").get() as { value: string } | null;
  return row ? JSON.parse(row.value) : {};
}

describe("codex default model migration", () => {
  it("fills in a model for a codex provider that has none", () => {
    const db = dbWithAiConfig({
      default_provider: "claude",
      providers: { codex: { type: "cli", cli_command: "codex", permission_mode: "bypassPermissions" } },
    });
    runMigrations(db);
    expect(aiConfig(db).providers.codex.model).toBe(CODEX_DEFAULT_MODEL);
    db.close();
  });

  it("leaves a model the user already picked alone", () => {
    const db = dbWithAiConfig({
      providers: { codex: { type: "cli", model: "gpt-5.5" } },
    });
    runMigrations(db);
    expect(aiConfig(db).providers.codex.model).toBe("gpt-5.5");
    db.close();
  });

  it("keeps the rest of the codex settings", () => {
    const db = dbWithAiConfig({
      providers: { codex: { type: "cli", cli_command: "codex", permission_mode: "bypassPermissions", effort: "high" } },
    });
    runMigrations(db);
    const codex = aiConfig(db).providers.codex;
    expect(codex.permission_mode).toBe("bypassPermissions");
    expect(codex.effort).toBe("high");
    db.close();
  });

  it("does not touch other providers", () => {
    const db = dbWithAiConfig({
      providers: {
        claude: { type: "agent-sdk", model: "claude-opus-5" },
        codex: { type: "cli" },
      },
    });
    runMigrations(db);
    expect(aiConfig(db).providers.claude.model).toBe("claude-opus-5");
    db.close();
  });

  it("adds nothing when codex was never configured", () => {
    const db = dbWithAiConfig({ providers: { claude: { type: "agent-sdk" } } });
    runMigrations(db);
    expect(aiConfig(db).providers.codex).toBeUndefined();
    db.close();
  });

  it("runs only once, so picking Auto afterwards is not undone", () => {
    // The settings picker stores "Auto (default)" as an absent model. Re-running
    // the upgrade must not read that as "never chosen" and reimpose a model.
    const db = dbWithAiConfig({ providers: { codex: { type: "cli" } } });
    runMigrations(db);
    expect(aiConfig(db).providers.codex.model).toBe(CODEX_DEFAULT_MODEL);

    const ai = aiConfig(db);
    delete ai.providers.codex.model; // the user switches to Auto
    db.query("UPDATE config SET value = ? WHERE key = 'ai'").run(JSON.stringify(ai));

    runMigrations(db);
    expect(aiConfig(db).providers.codex.model).toBeUndefined();
    db.close();
  });

  it("survives a config row that is not valid JSON", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
    db.query("INSERT INTO config (key, value) VALUES ('ai', 'not json')").run();
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
    expect(() => runMigrations(db)).not.toThrow();
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("survives an install with no ai config at all", () => {
    const db = dbWithAiConfig(undefined);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});
