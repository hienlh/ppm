import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import {
  applyDbPragmas, copySessionForkSettings, CURRENT_SCHEMA_VERSION, getDb, getSessionDesignSlug,
  getSessionIsAssistant, getSessionPermissionMode, resolveMigratedSession, runMigrations, setSessionAssistant,
  setSessionDesignSlug, setSessionMetadata, setSessionMigratedTo, setSessionPermissionMode,
} from "../../../src/services/db.service.ts";

describe("session assistant mark", () => {
  beforeEach(() => getDb().run("DELETE FROM session_metadata"));

  it("migrates to the version that adds the column, defaulting every row to an ordinary session", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
    const row = getDb().query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(CURRENT_SCHEMA_VERSION);
    const column = (getDb().query("PRAGMA table_info(session_metadata)").all() as { name: string; notnull: number; dflt_value: string }[])
      .find((c) => c.name === "assistant");
    expect(column).toMatchObject({ notnull: 1, dflt_value: "0" });
    setSessionMetadata("plain", "project", "/project");
    expect(getSessionIsAssistant("plain")).toBe(false);
    expect(getSessionIsAssistant("never-seen")).toBe(false);
  });

  it("adds the column to a database at the previous version without touching its rows", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    db.exec("ALTER TABLE session_metadata DROP COLUMN assistant");
    db.exec("PRAGMA user_version = 56");
    db.query("INSERT INTO session_metadata (session_id, design_slug) VALUES ('old', 'landing')").run();
    runMigrations(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.query("SELECT design_slug, assistant FROM session_metadata WHERE session_id = 'old'").get())
      .toEqual({ design_slug: "landing", assistant: 0 });
    db.close();
  });

  it("stores the mark idempotently", () => {
    setSessionAssistant("a1");
    setSessionAssistant("a1");
    expect(getSessionIsAssistant("a1")).toBe(true);
    setSessionMetadata("a1", "__assistant__", "/x");
    expect(getSessionIsAssistant("a1")).toBe(true);
  });

  it("carries the mark through a provider id migration onto an existing destination row", () => {
    setSessionAssistant("draft");
    // Codex writes the destination's metadata row before it announces the migration.
    setSessionMetadata("thread", "__assistant__", "/assistant");
    setSessionMigratedTo("draft", "thread");
    const id = resolveMigratedSession("draft");
    expect(id).toBe("thread");
    expect(getSessionIsAssistant(id)).toBe(true);
    // A repeated migration from an unmarked row never clears it.
    setSessionMetadata("other", "p", "/p");
    setSessionMigratedTo("other", "thread");
    expect(getSessionIsAssistant("thread")).toBe(true);
  });

  it("leaves an ordinary session ordinary through a migration", () => {
    setSessionMetadata("draft", "p", "/p");
    setSessionMigratedTo("draft", "thread");
    expect(getSessionIsAssistant("thread")).toBe(false);
  });

  it("copies the mark and the design identity onto a fork, and nothing for an ordinary source", () => {
    setSessionAssistant("src");
    copySessionForkSettings("src", "fork");
    expect(getSessionIsAssistant("fork")).toBe(true);

    setSessionDesignSlug("design", "smoke");
    setSessionPermissionMode("design", "plan");
    copySessionForkSettings("design", "fork2");
    expect(getSessionDesignSlug("fork2")).toBe("smoke");
    expect(getSessionPermissionMode("fork2")).toBe("plan");
    expect(getSessionIsAssistant("fork2")).toBe(false);

    setSessionMetadata("plain", "p", "/p");
    copySessionForkSettings("plain", "fork3");
    expect(getSessionIsAssistant("fork3")).toBe(false);
    expect(getSessionDesignSlug("fork3")).toBeNull();
  });
});
