import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { teamRoutes } from "../../../src/server/routes/teams.ts";

function createApp() {
  return new Hono().route("/teams", teamRoutes);
}

beforeEach(() => {
  // No setup needed — routes read from filesystem
});

describe("GET /teams", () => {
  it("returns array of teams", async () => {
    const app = createApp();
    const res = await app.request("/teams");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
  });

  it("returns teams with proper structure", async () => {
    const app = createApp();
    const res = await app.request("/teams");
    const json = await res.json() as any;
    expect(json.data).toBeTruthy();
    // If teams exist, they should have expected properties
    if (json.data.length > 0) {
      const team = json.data[0];
      expect(typeof team.name).toBe("string");
    }
  });
});

describe("GET /teams/:name", () => {
  it("rejects invalid team name with special chars", async () => {
    const app = createApp();
    const res = await app.request("/teams/invalid@team");
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Invalid");
  });

  it("rejects team name with spaces", async () => {
    const app = createApp();
    const res = await app.request("/teams/my%20team");
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects team name with dots", async () => {
    const app = createApp();
    const res = await app.request("/teams/team.name");
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects team name with slashes", async () => {
    const app = createApp();
    const res = await app.request("/teams/team/name");
    // Route might not match, or returns 400 for invalid
    expect([404, 400]).toContain(res.status);
  });

  it("accepts valid team name with hyphens", async () => {
    const app = createApp();
    const res = await app.request("/teams/my-team");
    // Should validate name (hyphens allowed), then 404 if not found
    expect([404, 200]).toContain(res.status);
  });

  it("accepts valid team name with underscores", async () => {
    const app = createApp();
    const res = await app.request("/teams/my_team");
    // Should validate name (underscores allowed), then 404 if not found
    expect([404, 200]).toContain(res.status);
  });

  it("accepts valid team name with numbers", async () => {
    const app = createApp();
    const res = await app.request("/teams/team123");
    // Should validate name, then 404 if not found
    expect([404, 200]).toContain(res.status);
  });

  it("returns 404 for nonexistent valid team name", async () => {
    const app = createApp();
    const res = await app.request("/teams/nonexistent-team");
    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("not found");
  });
});

describe("DELETE /teams/:name", () => {
  it("rejects invalid team name with special chars", async () => {
    const app = createApp();
    const res = await app.request("/teams/invalid@team", { method: "DELETE" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Invalid");
  });

  it("rejects team name with spaces", async () => {
    const app = createApp();
    const res = await app.request("/teams/my%20team", { method: "DELETE" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects team name with dots", async () => {
    const app = createApp();
    const res = await app.request("/teams/team.name", { method: "DELETE" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("accepts valid team name and returns ok", async () => {
    const app = createApp();
    const res = await app.request("/teams/fake-team-to-delete", {
      method: "DELETE",
    });
    // Valid name passes validation, returns 200 (force:true means dir may not exist)
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe("fake-team-to-delete");
  });

  it("idempotent — delete nonexistent team returns ok", async () => {
    const app = createApp();
    const res = await app.request("/teams/another-fake-team", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
  });

  it("deletes with valid team name (hyphens and underscores)", async () => {
    const app = createApp();
    const res = await app.request("/teams/my_valid-team123", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
  });
});
