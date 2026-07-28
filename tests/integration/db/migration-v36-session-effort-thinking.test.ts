import { describe, it, expect } from "bun:test";
import "../../test-setup.ts";
import {
  setDb,
  openTestDb,
  setSessionMetadata,
  setSessionModel,
  getSessionEffort,
  setSessionEffort,
  getSessionThinking,
  setSessionThinking,
} from "../../../src/services/db.service.ts";

describe("DB migration v36 — per-session effort + thinking", () => {
  it("session_metadata has effort + thinking_budget columns at v36", () => {
    const db = openTestDb();
    const cols = db.query("PRAGMA table_info(session_metadata)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "effort")).toBe(true);
    expect(cols.some((c) => c.name === "thinking_budget")).toBe(true);
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBeGreaterThanOrEqual(36);
    db.close();
  });

  it("getSessionEffort returns null when unset and for unknown session", () => {
    setDb(openTestDb());
    setSessionMetadata("sess-1", "proj", "/p");
    expect(getSessionEffort("sess-1")).toBeNull();
    expect(getSessionEffort("does-not-exist")).toBeNull();
  });

  it("setSessionEffort persists and reads back; upsert last-write-wins", () => {
    setDb(openTestDb());
    setSessionEffort("sess-2", "xhigh");
    expect(getSessionEffort("sess-2")).toBe("xhigh");
    setSessionEffort("sess-2", "max");
    expect(getSessionEffort("sess-2")).toBe("max");
  });

  it("getSessionThinking returns null when unset (= OFF)", () => {
    setDb(openTestDb());
    setSessionMetadata("sess-3", "proj", "/p");
    expect(getSessionThinking("sess-3")).toBeNull();
    expect(getSessionThinking("does-not-exist")).toBeNull();
  });

  it("setSessionThinking stores a budget and null clears it (OFF)", () => {
    setDb(openTestDb());
    setSessionThinking("sess-4", 12000);
    expect(getSessionThinking("sess-4")).toBe(12000);
    setSessionThinking("sess-4", null);
    expect(getSessionThinking("sess-4")).toBeNull();
  });

  it("setSessionEffort/Thinking preserve other metadata columns", () => {
    const db = openTestDb();
    setDb(db);
    setSessionMetadata("sess-5", "my-proj", "/my/path");
    setSessionModel("sess-5", "claude-opus-5");
    setSessionEffort("sess-5", "high");
    setSessionThinking("sess-5", 12000);
    const row = db
      .query("SELECT project_name, project_path, model, effort, thinking_budget FROM session_metadata WHERE session_id = ?")
      .get("sess-5") as {
      project_name: string;
      project_path: string;
      model: string;
      effort: string;
      thinking_budget: number;
    };
    expect(row.project_name).toBe("my-proj");
    expect(row.project_path).toBe("/my/path");
    expect(row.model).toBe("claude-opus-5");
    expect(row.effort).toBe("high");
    expect(row.thinking_budget).toBe(12000);
  });

  it("setSessionMetadata after setSessionEffort does not clobber effort", () => {
    setDb(openTestDb());
    setSessionEffort("sess-6", "xhigh");
    setSessionMetadata("sess-6", "proj", "/p");
    expect(getSessionEffort("sess-6")).toBe("xhigh");
  });
});
