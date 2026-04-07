import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { projectRoutes } from "../../../src/server/routes/projects.ts";
import { configService } from "../../../src/services/config.service.ts";

function createApp() {
  return new Hono().route("/projects", projectRoutes);
}

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  // Reset projects to empty
  (configService as any).config.projects = [];
});

describe("GET /projects", () => {
  it("returns empty array initially", async () => {
    const app = createApp();
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("lists added projects", async () => {
    const app = createApp();

    // Add a project
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "my-project" }),
    });

    // List projects
    const res = await app.request("/projects");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0].name).toBe("my-project");
    expect(json.data[0].path).toBe("/tmp");
  });
});

describe("POST /projects", () => {
  it("adds project with real path and custom name", async () => {
    const app = createApp();
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "test-proj" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("test-proj");
    expect(json.data.path).toBeDefined();
  });

  it("derives project name from path when not provided", async () => {
    const app = createApp();
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("tmp");
  });

  it("rejects missing path with 400", async () => {
    const app = createApp();
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-path" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  });

  it("rejects nonexistent path with 400", async () => {
    const app = createApp();
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/nonexistent/path/xyz" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects duplicate project name with 400", async () => {
    const app = createApp();

    // Add first project
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "dup" }),
    });

    // Try to add duplicate
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/var", name: "dup" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("PATCH /projects/reorder", () => {
  it("reorders projects", async () => {
    const app = createApp();

    // Add two projects
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "proj-a" }),
    });
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/var", name: "proj-b" }),
    });

    // Reorder
    const res = await app.request("/projects/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ["proj-b", "proj-a"] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.reordered).toBe(2);
  });

  it("rejects non-array order with 400", async () => {
    const app = createApp();
    const res = await app.request("/projects/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: "not-an-array" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("order");
  });

  it("rejects missing order field with 400", async () => {
    const app = createApp();
    const res = await app.request("/projects/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("PATCH /projects/:name/color", () => {
  it("sets color on existing project", async () => {
    const app = createApp();

    // Add project
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "proj" }),
    });

    // Set color
    const res = await app.request("/projects/proj/color", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#ff0000" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.color).toBe("#ff0000");
  });

  it("clears color when null sent", async () => {
    const app = createApp();

    // Add project with color
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "proj", color: "#ff0000" }),
    });

    // Clear color
    const res = await app.request("/projects/proj/color", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: null }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.data.color).toBeUndefined();
  });

  it("returns 404 for nonexistent project", async () => {
    const app = createApp();
    const res = await app.request("/projects/nonexistent/color", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#ff0000" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("PATCH /projects/:name", () => {
  it("updates project name", async () => {
    const app = createApp();

    // Add project
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "old-name" }),
    });

    // Update name
    const res = await app.request("/projects/old-name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new-name" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("new-name");
  });

  it("updates project path", async () => {
    const app = createApp();

    // Add project
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "proj" }),
    });

    // Update path
    const res = await app.request("/projects/proj", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/var" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.path).toBeDefined();
  });

  it("rejects update to nonexistent project with 400", async () => {
    const app = createApp();
    const res = await app.request("/projects/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("DELETE /projects/:name", () => {
  it("removes project by name", async () => {
    const app = createApp();

    // Add project
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name: "to-delete" }),
    });

    // Delete
    const res = await app.request("/projects/to-delete", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.removed).toBe("to-delete");

    // Verify deleted
    const listRes = await app.request("/projects");
    const listJson = await listRes.json() as any;
    expect(listJson.data.length).toBe(0);
  });

  it("returns 404 for nonexistent project", async () => {
    const app = createApp();
    const res = await app.request("/projects/nonexistent", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});
