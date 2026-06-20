import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { projectRoutes } from "../../../src/server/routes/projects.ts";
import { configService } from "../../../src/services/config.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { avatarPath } from "../../../src/services/avatar-storage.service.ts";

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

describe("project image (upload / serve / delete)", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.PPM_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "ppm-avatar-test-"));
    process.env.PPM_HOME = tmpHome;
    _resetPpmDir();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.PPM_HOME;
    else process.env.PPM_HOME = prevHome;
    _resetPpmDir();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function addProject(app: Hono, name: string) {
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp", name }),
    });
  }

  function uploadForm(bytes: number[]) {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)], { type: "image/webp" }), "a.webp");
    return fd;
  }

  it("uploads an image and persists the file on disk", async () => {
    const app = createApp();
    await addProject(app, "proj");

    const res = await app.request("/projects/proj/image", { method: "POST", body: uploadForm([1, 2, 3, 4]) });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.image).toBeDefined();
    expect(existsSync(avatarPath(json.data.image))).toBe(true);
  });

  it("serves the image with webp + immutable cache headers", async () => {
    const app = createApp();
    await addProject(app, "proj");
    await app.request("/projects/proj/image", { method: "POST", body: uploadForm([1, 2, 3, 4]) });

    const res = await app.request("/projects/proj/image");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("returns 404 when project has no image", async () => {
    const app = createApp();
    await addProject(app, "proj");
    const res = await app.request("/projects/proj/image");
    expect(res.status).toBe(404);
  });

  it("returns 404 uploading to unknown project", async () => {
    const app = createApp();
    const res = await app.request("/projects/ghost/image", { method: "POST", body: uploadForm([1, 2, 3]) });
    expect(res.status).toBe(404);
  });

  it("rejects oversized upload with 400", async () => {
    const app = createApp();
    await addProject(app, "proj");
    const big = new Array(2_000_001).fill(0);
    const res = await app.request("/projects/proj/image", { method: "POST", body: uploadForm(big) });
    expect(res.status).toBe(400);
  });

  it("delete clears the field and removes the file", async () => {
    const app = createApp();
    await addProject(app, "proj");
    const up = await (await app.request("/projects/proj/image", { method: "POST", body: uploadForm([1, 2, 3, 4]) })).json() as any;
    const file = avatarPath(up.data.image);
    expect(existsSync(file)).toBe(true);

    const res = await app.request("/projects/proj/image", { method: "DELETE" });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.data.image).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("replacing an image removes the old file", async () => {
    const app = createApp();
    await addProject(app, "proj");
    const first = await (await app.request("/projects/proj/image", { method: "POST", body: uploadForm([1, 1, 1]) })).json() as any;
    const second = await (await app.request("/projects/proj/image", { method: "POST", body: uploadForm([9, 9, 9, 9]) })).json() as any;

    expect(second.data.image).not.toBe(first.data.image);
    expect(existsSync(avatarPath(first.data.image))).toBe(false);
    expect(existsSync(avatarPath(second.data.image))).toBe(true);
  });

  it("renaming a project preserves its image and keeps the file", async () => {
    const app = createApp();
    await addProject(app, "proj");
    const up = await (await app.request("/projects/proj/image", { method: "POST", body: uploadForm([1, 2, 3, 4]) })).json() as any;
    const file = avatarPath(up.data.image);

    const res = await app.request("/projects/proj", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    const json = await res.json() as any;
    expect(json.data.name).toBe("renamed");
    expect(json.data.image).toBe(up.data.image);
    expect(existsSync(file)).toBe(true);
  });

  it("deleting a project removes its avatar file", async () => {
    const app = createApp();
    await addProject(app, "proj");
    const up = await (await app.request("/projects/proj/image", { method: "POST", body: uploadForm([1, 2, 3, 4]) })).json() as any;
    const file = avatarPath(up.data.image);
    expect(existsSync(file)).toBe(true);

    await app.request("/projects/proj", { method: "DELETE" });
    expect(existsSync(file)).toBe(false);
  });
});
