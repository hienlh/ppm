import { describe, it, expect } from "bun:test";
import "../../test-setup.ts";
import { setDb, openTestDb, getSessionModel, setSessionModel, setSessionMetadata } from "../../../src/services/db.service.ts";

describe("DB migration v27 — per-session model override", () => {
  it("session_metadata has model column at v27", () => {
    const db = openTestDb();
    const cols = db.query("PRAGMA table_info(session_metadata)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "model")).toBe(true);
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBeGreaterThanOrEqual(27);
    db.close();
  });

  it("getSessionModel returns null when no override set", () => {
    setDb(openTestDb());
    setSessionMetadata("sess-1", "proj", "/p");
    expect(getSessionModel("sess-1")).toBeNull();
  });

  it("getSessionModel returns null for unknown session", () => {
    setDb(openTestDb());
    expect(getSessionModel("does-not-exist")).toBeNull();
  });

  it("setSessionModel persists and getSessionModel reads it back", () => {
    setDb(openTestDb());
    setSessionModel("sess-2", "claude-opus-4-8");
    expect(getSessionModel("sess-2")).toBe("claude-opus-4-8");
  });

  it("setSessionModel upserts — last write wins", () => {
    setDb(openTestDb());
    setSessionModel("sess-3", "claude-sonnet-4-6");
    setSessionModel("sess-3", "claude-opus-4-8");
    expect(getSessionModel("sess-3")).toBe("claude-opus-4-8");
  });

  it("setSessionModel preserves existing metadata (project_name/path)", () => {
    const db = openTestDb();
    setDb(db);
    setSessionMetadata("sess-4", "my-proj", "/my/path");
    setSessionModel("sess-4", "claude-opus-4-8");
    const row = db.query("SELECT project_name, project_path, model FROM session_metadata WHERE session_id = ?")
      .get("sess-4") as { project_name: string; project_path: string; model: string };
    expect(row.project_name).toBe("my-proj");
    expect(row.project_path).toBe("/my/path");
    expect(row.model).toBe("claude-opus-4-8");
  });

  it("setSessionMetadata after setSessionModel does not clobber model", () => {
    setDb(openTestDb());
    setSessionModel("sess-5", "claude-opus-4-8");
    setSessionMetadata("sess-5", "proj", "/p");
    expect(getSessionModel("sess-5")).toBe("claude-opus-4-8");
  });
});
