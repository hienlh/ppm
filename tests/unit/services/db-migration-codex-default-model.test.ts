import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../src/services/db.service.ts";

/** v45 once wrote a fixed codex model; a database has to start at 44 for it to run. */
const VERSION_BEFORE_CODEX_MODEL_MIGRATION = 44;

function dbWithAiConfig(ai: unknown): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
  db.query("INSERT INTO config (key, value) VALUES ('ai', ?)").run(JSON.stringify(ai));
  db.exec(`PRAGMA user_version = ${VERSION_BEFORE_CODEX_MODEL_MIGRATION}`);
  return db;
}

function aiConfig(db: Database): Record<string, any> {
  const row = db.query("SELECT value FROM config WHERE key = 'ai'").get() as { value: string } | null;
  return row ? JSON.parse(row.value) : {};
}

describe("codex model on upgrade", () => {
  it("leaves a codex provider with no model on Auto, which follows codex's own default", () => {
    const db = dbWithAiConfig({ providers: { codex: { type: "cli", cli_command: "codex", permission_mode: "bypassPermissions" } } });
    runMigrations(db);
    expect(aiConfig(db).providers.codex.model).toBeUndefined();
    db.close();
  });

  it("leaves a model the user picked alone", () => {
    const db = dbWithAiConfig({ providers: { codex: { type: "cli", model: "gpt-6-astra" } } });
    runMigrations(db);
    expect(aiConfig(db).providers.codex.model).toBe("gpt-6-astra");
    db.close();
  });
});
