import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  getDb, getSessionEffort, getSessionModel, getSessionThinking,
  resolveMigratedSession, setSessionEffort, setSessionMetadata,
  setSessionMigratedTo, setSessionModel, setSessionThinking,
} from "../../../src/services/db.service.ts";

describe("session migration preserves selected settings", () => {
  beforeEach(() => getDb().run("DELETE FROM session_metadata"));

  it("reloads GPT 6 and effort from the real Codex thread id", () => {
    setSessionModel("draft", "gpt-6-astra");
    setSessionEffort("draft", "high");
    setSessionThinking("draft", 0);
    // Codex creates destination metadata before it announces migration.
    setSessionMetadata("thread", "project", "/project");
    setSessionMigratedTo("draft", "thread");
    const reopenedId = resolveMigratedSession("draft");
    expect(reopenedId).toBe("thread");
    expect(getSessionModel(reopenedId)).toBe("gpt-6-astra");
    expect(getSessionEffort(reopenedId)).toBe("high");
    expect(getSessionThinking(reopenedId)).toBe(0);
    expect(getDb().query("SELECT project_name FROM session_metadata WHERE session_id = ?").get("thread"))
      .toEqual({ project_name: "project" });
  });

  it("does not overwrite newer choices if migration is repeated", () => {
    setSessionModel("draft", "gpt-6-astra");
    setSessionEffort("draft", "high");
    setSessionThinking("draft", 1024);
    setSessionMigratedTo("draft", "thread");
    setSessionModel("thread", "gpt-5.6-sol");
    setSessionEffort("thread", "low");
    setSessionThinking("thread", 0);
    setSessionMigratedTo("draft", "thread");
    expect(getSessionModel("thread")).toBe("gpt-5.6-sol");
    expect(getSessionEffort("thread")).toBe("low");
    expect(getSessionThinking("thread")).toBe(0);
  });

  it("carries settings through successive renames without a pre-existing destination", () => {
    setSessionModel("draft", "gpt-6-astra");
    setSessionMigratedTo("draft", "first");
    setSessionMigratedTo("first", "second");
    expect(getSessionModel(resolveMigratedSession("draft"))).toBe("gpt-6-astra");
  });

  it("keeps provider defaults when the source has no overrides", () => {
    setSessionMigratedTo("unknown", "thread");
    expect(resolveMigratedSession("unknown")).toBe("thread");
    expect(getSessionModel("thread")).toBeNull();
    setSessionMigratedTo("thread", "thread");
    expect(resolveMigratedSession("thread")).toBe("thread");
  });
});
