import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { workspaceRoutes } from "../../../src/server/routes/workspace.ts";

function createApp() {
  const app = new Hono();
  app.use("/workspace/*", async (c, next) => {
    c.set("projectName", "test-project");
    c.set("projectPath", "/tmp/test");
    await next();
  });
  app.route("/workspace", workspaceRoutes);
  return app;
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("GET /workspace", () => {
  it("returns null when no workspace saved", async () => {
    const app = createApp();
    const res = await app.request("/workspace");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data).toBe(null);
  });

  it("returns saved layout after PUT", async () => {
    const app = createApp();
    const layout = { tabs: ["file1.ts", "file2.ts"], width: 1024 };

    // Save first
    const putRes = await app.request("/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout }),
    });
    expect(putRes.status).toBe(200);

    // Now fetch
    const getRes = await app.request("/workspace");
    expect(getRes.status).toBe(200);
    const json = await getRes.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.layout).toEqual(layout);
    expect(json.data.updatedAt).toBeDefined();
  });
});

describe("PUT /workspace", () => {
  it("saves layout and returns updatedAt", async () => {
    const app = createApp();
    const layout = { tabs: ["main.ts"], width: 800, height: 600 };

    const res = await app.request("/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.updatedAt).toBeDefined();
    expect(typeof json.data.updatedAt).toBe("string");
  });

  it("returns 400 when layout is missing", async () => {
    const app = createApp();
    const res = await app.request("/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Missing layout");
  });

  it("returns 500 when JSON is malformed", async () => {
    const app = createApp();
    const res = await app.request("/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("updates existing workspace layout", async () => {
    const app = createApp();
    const layout1 = { tabs: ["a.ts"] };
    const layout2 = { tabs: ["b.ts", "c.ts"] };

    // Save first
    await app.request("/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout: layout1 }),
    });

    // Update
    const updateRes = await app.request("/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout: layout2 }),
    });
    expect(updateRes.status).toBe(200);

    // Verify updated
    const getRes = await app.request("/workspace");
    const json = await getRes.json() as any;
    expect(json.data.layout).toEqual(layout2);
  });
});
