import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  openTestDb,
  setDb,
  setSessionClearedFrom,
  getSessionClearedFrom,
  setSessionMetadata,
  getSessionProjectPath,
} from "../../../src/services/db.service.ts";

describe("session /clear lineage", () => {
  beforeEach(() => { setDb(openTestDb()); });
  afterEach(() => { setDb(openTestDb()); });

  it("returns null for a session that was not started by /clear", () => {
    expect(getSessionClearedFrom("fresh-session")).toBeNull();
  });

  it("records and reads back the origin session", () => {
    setSessionClearedFrom("new-session", "old-session");

    expect(getSessionClearedFrom("new-session")).toBe("old-session");
  });

  it("keeps project metadata written afterwards", () => {
    setSessionClearedFrom("new-session", "old-session");
    setSessionMetadata("new-session", "ppm", "/tmp/ppm");

    expect(getSessionClearedFrom("new-session")).toBe("old-session");
    expect(getSessionProjectPath("new-session")).toBe("/tmp/ppm");
  });

  it("keeps the origin when project metadata was written first", () => {
    setSessionMetadata("new-session", "ppm", "/tmp/ppm");
    setSessionClearedFrom("new-session", "old-session");

    expect(getSessionClearedFrom("new-session")).toBe("old-session");
    expect(getSessionProjectPath("new-session")).toBe("/tmp/ppm");
  });
});
