/**
 * Which design requests announce `design:list_changed`: a create, a rename, a delete and a
 * restore that answered 2xx — not a read, not a refusal, not a write inside a design.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ANNOUNCE_DESIGN_LIST_ENV_KEY, announceDesignListChanges, changesDesignList } from "../../../src/server/routes/designs-broadcast.ts";
import type { DesignRouteEnv } from "../../../src/server/routes/design-route-helpers.ts";

describe("changesDesignList", () => {
  it("names the list-changing writes and nothing else", () => {
    const base = "/api/project/demo/designs";
    expect(changesDesignList("POST", base)).toBe(true);
    expect(changesDesignList("PATCH", `${base}/landing`)).toBe(true);
    expect(changesDesignList("DELETE", `${base}/landing`)).toBe(true);
    expect(changesDesignList("POST", `${base}/landing/history/20261113-101010-abcd/restore`)).toBe(true);
    expect(changesDesignList("GET", base)).toBe(false);
    expect(changesDesignList("POST", `${base}/landing`)).toBe(false);
    expect(changesDesignList("POST", `${base}/landing/comments`)).toBe(false);
    expect(changesDesignList("PATCH", `${base}/landing/tweaks`)).toBe(false);
    expect(changesDesignList("DELETE", `${base}/landing/history/20261113-101010-abcd/restore`)).toBe(false);
  });
});

describe("announceDesignListChanges", () => {
  function app() {
    const heard: string[] = [];
    const a = new Hono<DesignRouteEnv>();
    a.use("*", async (c, next) => { c.set("projectName", "demo"); await next(); });
    a.use("*", announceDesignListChanges);
    a.post("/api/project/demo/designs", (c) => c.json({ ok: true }, 201));
    a.patch("/api/project/demo/designs/:slug", (c) => c.json({ ok: false, error: "nope" }, 400));
    a.get("/api/project/demo/designs", (c) => c.json({ ok: true }));
    const env = { [ANNOUNCE_DESIGN_LIST_ENV_KEY]: (p: string) => heard.push(p) };
    return { a, heard, env };
  }

  it("announces a successful create with the project's name", async () => {
    const { a, heard, env } = app();
    await a.request("/api/project/demo/designs", { method: "POST" }, env);
    expect(heard).toEqual(["demo"]);
  });

  it("stays quiet for a refused write and for a read", async () => {
    const { a, heard, env } = app();
    await a.request("/api/project/demo/designs/landing", { method: "PATCH" }, env);
    await a.request("/api/project/demo/designs", {}, env);
    expect(heard).toEqual([]);
  });
});
