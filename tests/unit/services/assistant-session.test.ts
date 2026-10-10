import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionMigratedTo } from "../../../src/services/db.service.ts";
import { assistantWorkDir } from "../../../src/services/assistant/assistant-work-dir.ts";
import { isAssistantSession, isAssistantWorkDir } from "../../../src/services/assistant/assistant-session.ts";

describe("isAssistantSession", () => {
  beforeEach(() => getDb().run("DELETE FROM session_metadata"));

  it("names the work dir after the open database, so dev and production keep separate histories", () => {
    // The test database is in memory; the path names the production file, `ppm.db`.
    expect(assistantWorkDir()).toBe(join(getPpmDir(), "assistant", "ppm"));
  });

  it("is true for a marked session and false for an ordinary one", () => {
    setSessionAssistant("a");
    setSessionMetadata("b", "proj", "/proj");
    expect(isAssistantSession("a")).toBe(true);
    expect(isAssistantSession("b")).toBe(false);
    expect(isAssistantSession("unknown")).toBe(false);
  });

  it("follows a provider migration from the id a caller still holds", () => {
    // The mark on the destination only: a caller holding the draft id must still see it.
    setSessionMigratedTo("draft", "thread");
    setSessionAssistant("thread");
    expect(isAssistantSession("draft")).toBe(true);
  });

  it("falls back to the working directory when the mark is lost", () => {
    setSessionMetadata("lost", "__assistant__", assistantWorkDir());
    expect(isAssistantSession("lost")).toBe(true);
    // A live session's cwd counts even with no row at all.
    expect(isAssistantSession("live-only", assistantWorkDir())).toBe(true);
    expect(isAssistantSession("live-only", "/somewhere/else")).toBe(false);
    // A migrated session whose new row carries only the directory.
    setSessionMetadata("thread2", "__assistant__", assistantWorkDir());
    setSessionMigratedTo("draft2", "thread2");
    expect(isAssistantSession("draft2")).toBe(true);
  });

  it("matches the work dir exactly, not a folder inside or beside it", () => {
    expect(isAssistantWorkDir(assistantWorkDir())).toBe(true);
    expect(isAssistantWorkDir(join(assistantWorkDir(), "sub"))).toBe(false);
    expect(isAssistantWorkDir(join(getPpmDir(), "assistant", "ppm.dev"))).toBe(false);
    expect(isAssistantWorkDir(null)).toBe(false);
    if (process.platform === "win32") expect(isAssistantWorkDir(assistantWorkDir().toUpperCase())).toBe(true);
  });
});
