import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  copySessionDesignSettings, CURRENT_SCHEMA_VERSION, getDb, getSessionDesignSlug, getSessionDesignSlugs,
  getSessionPermissionMode, resolveMigratedSession, setSessionDesignSlug, setSessionMetadata,
  setSessionMigratedTo, setSessionPermissionMode,
} from "../../../src/services/db.service.ts";

describe("session design slug + permission mode", () => {
  beforeEach(() => getDb().run("DELETE FROM session_metadata"));

  it("migrates the schema to the version the pre-migration backup compares against", () => {
    const row = getDb().query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(CURRENT_SCHEMA_VERSION);
    const columns = (getDb().query("PRAGMA table_info(session_metadata)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("design_slug");
    expect(columns).toContain("permission_mode");
  });

  it("stores and reads both fields, null when unset", () => {
    expect(getSessionDesignSlug("s1")).toBeNull();
    expect(getSessionPermissionMode("s1")).toBeNull();
    setSessionDesignSlug("s1", "landing");
    setSessionPermissionMode("s1", "acceptEdits");
    expect(getSessionDesignSlug("s1")).toBe("landing");
    expect(getSessionPermissionMode("s1")).toBe("acceptEdits");
    setSessionPermissionMode("s1", "default");
    expect(getSessionPermissionMode("s1")).toBe("default");
  });

  it("carries both through a provider id migration", () => {
    setSessionDesignSlug("draft", "smoke");
    setSessionPermissionMode("draft", "acceptEdits");
    // Codex writes the destination's metadata row before it announces the migration.
    setSessionMetadata("thread", "project", "/project");
    setSessionMigratedTo("draft", "thread");
    const id = resolveMigratedSession("draft");
    expect(id).toBe("thread");
    expect(getSessionDesignSlug(id)).toBe("smoke");
    expect(getSessionPermissionMode(id)).toBe("acceptEdits");
  });

  it("keeps a mode already chosen on the destination when the migration repeats", () => {
    setSessionDesignSlug("draft", "smoke");
    setSessionPermissionMode("draft", "acceptEdits");
    setSessionMigratedTo("draft", "thread");
    setSessionPermissionMode("thread", "default");
    setSessionMigratedTo("draft", "thread");
    expect(getSessionPermissionMode("thread")).toBe("default");
  });

  it("lists slugs in a batch, leaving ordinary sessions out", () => {
    setSessionDesignSlug("a", "one");
    setSessionDesignSlug("b", "two");
    setSessionMetadata("c", "project", "/project");
    expect(getSessionDesignSlugs(["a", "b", "c", "missing"])).toEqual({ a: "one", b: "two" });
    expect(getSessionDesignSlugs([])).toEqual({});
  });

  it("handles a batch larger than one query chunk", () => {
    const ids = Array.from({ length: 1203 }, (_, i) => `s${i}`);
    setSessionDesignSlug("s1202", "last");
    expect(getSessionDesignSlugs(ids)).toEqual({ s1202: "last" });
  });

  it("copies the design identity onto a fork, and nothing for an ordinary source", () => {
    setSessionDesignSlug("src", "smoke");
    setSessionPermissionMode("src", "plan");
    copySessionDesignSettings("src", "fork");
    expect(getSessionDesignSlug("fork")).toBe("smoke");
    expect(getSessionPermissionMode("fork")).toBe("plan");

    setSessionMetadata("plain", "project", "/project");
    copySessionDesignSettings("plain", "fork2");
    expect(getSessionDesignSlug("fork2")).toBeNull();
    expect(getSessionPermissionMode("fork2")).toBeNull();
  });
});
