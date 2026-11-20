/**
 * Archived chats: the rule the history list filters by, the store behind it, and its route.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ppm-session-archive-"));
process.env.PPM_HOME = home;
const { isSessionArchived, matchesStatusFilter } = await import("../../../src/shared/session-archive.ts");
const { getSessionArchiveStates, setSessionArchiveState } = await import("../../../src/services/session-archive.service.ts");
const { Hono } = await import("hono");
const { chatRoutes } = await import("../../../src/server/routes/chat.ts");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-20T12:00:00Z");
const ago = (days: number) => new Date(now - days * DAY).toISOString();

describe("isSessionArchived", () => {
  it("archived by hand, whatever its age", () => {
    expect(isSessionArchived({ createdAt: ago(0), archive: "archived" }, 0, now)).toBe(true);
  });

  it("auto-archives a chat idle at least N days, never a pinned, manager or kept one", () => {
    expect(isSessionArchived({ createdAt: ago(40), updatedAt: ago(31) }, 30, now)).toBe(true);
    expect(isSessionArchived({ createdAt: ago(40), updatedAt: ago(2) }, 30, now)).toBe(false);
    expect(isSessionArchived({ createdAt: ago(40) }, 0, now)).toBe(false);
    expect(isSessionArchived({ createdAt: ago(40), pinned: true }, 30, now)).toBe(false);
    expect(isSessionArchived({ createdAt: ago(40), manager: true }, 30, now)).toBe(false);
    expect(isSessionArchived({ createdAt: ago(40), archive: "kept" }, 30, now)).toBe(false);
  });
});

describe("matchesStatusFilter", () => {
  const ctx = { autoDays: 0, now, running: (id: string) => id === "run", unread: (id: string) => id === "new" };
  const s = (id: string, archive?: "archived") => ({ id, createdAt: ago(1), ...(archive ? { archive } : {}) });
  it("Active hides archived chats, unless one is running or unread", () => {
    expect(matchesStatusFilter("active", s("a"), ctx)).toBe(true);
    expect(matchesStatusFilter("active", s("a", "archived"), ctx)).toBe(false);
    expect(matchesStatusFilter("active", s("run", "archived"), ctx)).toBe(true);
    expect(matchesStatusFilter("active", s("new", "archived"), ctx)).toBe(true);
  });
  it("each other filter shows its own", () => {
    expect(matchesStatusFilter("archived", s("a", "archived"), ctx)).toBe(true);
    expect(matchesStatusFilter("archived", s("a"), ctx)).toBe(false);
    expect(matchesStatusFilter("running", s("run"), ctx)).toBe(true);
    expect(matchesStatusFilter("running", s("a"), ctx)).toBe(false);
    expect(matchesStatusFilter("unread", s("new"), ctx)).toBe(true);
    expect(matchesStatusFilter("all", s("a", "archived"), ctx)).toBe(true);
  });
});

describe("the archive store and route", () => {
  it("keeps one state per chat and forgets it on null", () => {
    setSessionArchiveState("s1", "archived");
    setSessionArchiveState("s2", "kept");
    setSessionArchiveState("s1", "kept");
    expect(getSessionArchiveStates(["s1", "s2", "s3"])).toEqual(new Map([["s1", "kept"], ["s2", "kept"]]));
    setSessionArchiveState("s2", null);
    expect(getSessionArchiveStates(["s2"]).size).toBe(0);
  });

  it("PUT /sessions/:id/archive takes archived, kept or null and nothing else", async () => {
    const app = new Hono<any>();
    app.route("/", chatRoutes);
    const put = (state: unknown) => app.request("http://localhost/sessions/s9/archive", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }),
    });
    expect((await put("archived")).status).toBe(200);
    expect(getSessionArchiveStates(["s9"]).get("s9")).toBe("archived");
    expect((await put("deleted")).status).toBe(400);
    expect((await put(null)).status).toBe(200);
    expect(getSessionArchiveStates(["s9"]).size).toBe(0);
  });
});
