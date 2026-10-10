/**
 * Storage for the PPM Assistant on Telegram: which Assistant session each Telegram chat talks to,
 * and the watches that outlive a restart. Every session id is answered with the id the session
 * goes by now, because Codex renames a session on its first turn.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import {
  applyDbPragmas, CURRENT_SCHEMA_VERSION, getDb, runMigrations, setSessionMigratedTo,
} from "../../../src/services/db.service.ts";
import {
  deleteTelegramBinding, getAssistantWatch, getTelegramBinding, insertAssistantWatch, listAssistantWatches,
  listTelegramBindings, setTelegramBinding, telegramChatsBoundTo, updateAssistantWatch,
} from "../../../src/services/assistant-hub/assistant-hub-db.ts";

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("migration 58", () => {
  it("brings a new database to the current version with both tables and their indexes", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(58);
    expect((getDb().query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables(getDb())).toEqual(expect.arrayContaining([
      "assistant_telegram_bindings", "assistant_watches", "idx_assistant_watches_status", "idx_assistant_watches_target",
    ]));
  });

  it("adds the tables to a database at the previous version without touching its rows", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    db.exec("DROP TABLE assistant_telegram_bindings; DROP TABLE assistant_watches; PRAGMA user_version = 57");
    db.query("INSERT INTO session_metadata (session_id, assistant) VALUES ('kept', 1)").run();
    runMigrations(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(58);
    expect(tables(db)).toEqual(expect.arrayContaining(["assistant_telegram_bindings", "assistant_watches"]));
    expect(db.query("SELECT assistant FROM session_metadata WHERE session_id = 'kept'").get()).toEqual({ assistant: 1 });
    db.close();
  });

  it("refuses a watch status outside the known ones at the database too", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    expect(() => db.exec(`INSERT INTO assistant_watches
      (id, assistant_session_id, target_session_id, target_project, target_provider, created_at, expires_at, status)
      VALUES ('w', 'a', 't', 'p', 'mock', 1, 2, 'bogus')`)).toThrow();
    db.close();
  });
});

describe("Telegram bindings", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM assistant_telegram_bindings");
    getDb().run("DELETE FROM session_metadata");
  });

  it("binds a chat to one session and rebinds it in place", () => {
    setTelegramBinding("1001", "asst-a", "claude", 10);
    expect(getTelegramBinding("1001")).toEqual({ telegramChatId: "1001", sessionId: "asst-a", providerId: "claude", updatedAt: 10 });
    setTelegramBinding("1001", "asst-b", "codex", 20);
    expect(getTelegramBinding("1001")).toEqual({ telegramChatId: "1001", sessionId: "asst-b", providerId: "codex", updatedAt: 20 });
    expect(listTelegramBindings()).toHaveLength(1);
  });

  it("answers with the session's current id after a provider renamed it", () => {
    setTelegramBinding("1001", "draft", "codex");
    setSessionMigratedTo("draft", "thread-1");
    expect(getTelegramBinding("1001")?.sessionId).toBe("thread-1");
    expect(telegramChatsBoundTo("draft")).toEqual(["1001"]);
    expect(telegramChatsBoundTo("thread-1")).toEqual(["1001"]);
  });

  it("lists every chat bound to a session and none bound elsewhere", () => {
    setTelegramBinding("1", "asst", "claude", 1);
    setTelegramBinding("2", "asst", "claude", 2);
    setTelegramBinding("3", "other", "claude", 3);
    expect(telegramChatsBoundTo("asst").sort()).toEqual(["1", "2"]);
    expect(telegramChatsBoundTo("nobody")).toEqual([]);
  });

  it("deletes a binding and says whether there was one", () => {
    setTelegramBinding("1001", "asst", "claude");
    expect(deleteTelegramBinding("1001")).toBe(true);
    expect(deleteTelegramBinding("1001")).toBe(false);
    expect(getTelegramBinding("1001")).toBeNull();
  });

  it("refuses empty ids", () => {
    expect(() => setTelegramBinding("", "asst", "claude")).toThrow();
    expect(() => setTelegramBinding("1", " ", "claude")).toThrow();
    expect(() => getTelegramBinding("")).toThrow();
  });
});

describe("watches", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM assistant_watches");
    getDb().run("DELETE FROM session_metadata");
  });

  const watch = (id: string, over: Partial<Parameters<typeof insertAssistantWatch>[0]> = {}) => insertAssistantWatch({
    id, assistantSessionId: "asst", targetSessionId: "target", targetProject: "web", targetProvider: "claude",
    createdAt: 100, expiresAt: 200, armedRunning: true, ...over,
  });

  it("stores a new watch as active, with nothing fired yet", () => {
    expect(watch("w1")).toEqual({
      id: "w1", assistantSessionId: "asst", targetSessionId: "target", targetProject: "web", targetProvider: "claude",
      createdAt: 100, expiresAt: 200, armedRunning: true, status: "active",
      lastEvent: null, firedAt: null, deliveredAt: null, eventJson: null,
    });
  });

  it("filters by status and by either session, following renames", () => {
    watch("w1", { createdAt: 1 });
    watch("w2", { createdAt: 2, targetSessionId: "draft" });
    watch("w3", { createdAt: 3, assistantSessionId: "asst-2" });
    updateAssistantWatch("w3", { status: "cancelled" });
    setSessionMigratedTo("draft", "thread-9");
    expect(listAssistantWatches({ status: "active" }).map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(listAssistantWatches({ targetSessionId: "thread-9" }).map((w) => w.id)).toEqual(["w2"]);
    expect(listAssistantWatches({ targetSessionId: "draft" })[0]?.targetSessionId).toBe("thread-9");
    expect(listAssistantWatches({ assistantSessionId: "asst", status: "active" }).map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(listAssistantWatches().map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
  });

  it("records a firing once even when two events race for it", () => {
    watch("w1");
    const fire = (at: number) => updateAssistantWatch("w1", {
      status: "fired", firedAt: at, lastEvent: "turn_ended", eventJson: JSON.stringify({ outcome: "done" }),
    }, { ifStatus: "active" });
    expect(fire(150)).toBe(true);
    expect(fire(160)).toBe(false);
    expect(getAssistantWatch("w1")).toMatchObject({ status: "fired", firedAt: 150, lastEvent: "turn_ended" });
    expect(updateAssistantWatch("w1", { deliveredAt: 170 })).toBe(true);
    expect(getAssistantWatch("w1")?.deliveredAt).toBe(170);
  });

  it("refuses an unknown status or field and a malformed time", () => {
    watch("w1");
    expect(() => updateAssistantWatch("w1", { status: "done" as never })).toThrow();
    expect(() => updateAssistantWatch("w1", { firedAt: Number.NaN })).toThrow();
    expect(() => updateAssistantWatch("w1", { bogus: 1 } as never)).toThrow();
    expect(() => listAssistantWatches({ status: "nope" as never })).toThrow();
    expect(() => watch("w2", { expiresAt: -1 })).toThrow();
    expect(getAssistantWatch("w1")?.status).toBe("active");
  });

  it("answers false for a watch that does not exist", () => {
    expect(updateAssistantWatch("missing", { status: "cancelled" })).toBe(false);
    expect(getAssistantWatch("missing")).toBeNull();
  });
});
