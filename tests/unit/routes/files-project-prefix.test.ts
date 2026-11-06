import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// Isolates PPM_HOME and loads the config service before any service import reaches a database.
import "../../test-setup.ts";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileRoutes } from "../../../src/server/routes/files.ts";
import { isInsideProject } from "../../../src/server/helpers/project-path.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";

/**
 * A sibling directory whose name starts with the project's (`app` → `app-secrets`) passed a bare
 * `startsWith(projectPath)` check on every route here, reading — and for upload, writing — outside
 * the project.
 */
let root: string;
let project: string;
let sibling: string;

beforeEach(() => {
  setDb(openTestDb());
  root = mkdtempSync(join(tmpdir(), "files-prefix-"));
  project = join(root, "app");
  sibling = join(root, "app-secrets");
  mkdirSync(project);
  mkdirSync(sibling);
  writeFileSync(join(project, "ok.txt"), "inside");
  writeFileSync(join(sibling, "secret.txt"), "secret");
  writeFileSync(join(sibling, "secret.docx"), "not really a docx");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function projectApp() {
  const app = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
  app.use("*", (c, next) => {
    c.set("projectPath", project);
    c.set("projectName", "app");
    return next();
  });
  return app.route("/files", fileRoutes);
}
const outside = (name: string) => encodeURIComponent(`../${basename(sibling)}/${name}`);

describe("project routes refuse a sibling directory sharing the project's prefix", () => {
  for (const route of ["raw", "probe", "docx-html"]) {
    it(`GET /files/${route}`, async () => {
      const name = route === "docx-html" ? "secret.docx" : "secret.txt";
      const res = await projectApp().request(`/files/${route}?path=${outside(name)}`);
      expect(res.status).toBe(403);
    });
  }

  it("GET /files/transcode", async () => {
    const res = await projectApp().request(`/files/transcode?path=${outside("secret.txt")}`);
    expect(res.status).toBe(403);
  });

  it("POST /files/upload writes nothing outside the project", async () => {
    const form = new FormData();
    form.append("targetDir", `../${basename(sibling)}`);
    form.append("files", new File(["pwned"], "dropped.txt"));
    const res = await projectApp().request("/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(403);
    expect(readdirSync(sibling).sort()).toEqual(["secret.docx", "secret.txt"]);
  });

  it("POST /files/upload creates no directory outside the project", async () => {
    const form = new FormData();
    form.append("targetDir", `../${basename(project)}-new`);
    form.append("files", new File(["x"], "a.txt"));
    const res = await projectApp().request("/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(403);
    expect(existsSync(`${project}-new`)).toBe(false);
  });

  it("still serves and uploads inside the project", async () => {
    expect((await projectApp().request("/files/raw?path=ok.txt")).status).toBe(200);
    const form = new FormData();
    form.append("targetDir", "sub");
    form.append("files", new File(["y"], "b.txt"));
    expect((await projectApp().request("/files/upload", { method: "POST", body: form })).status).toBe(201);
    expect(existsSync(join(project, "sub", "b.txt"))).toBe(true);
  });
});

describe("isInsideProject", () => {
  it("takes the root and what is under it, nothing that only shares the prefix", () => {
    expect(isInsideProject("/home/u/app", "/home/u/app")).toBe(true);
    expect(isInsideProject("/home/u/app", "/home/u/app/src/a.ts")).toBe(true);
    expect(isInsideProject("/home/u/app/", "/home/u/app/src/a.ts")).toBe(true);
    expect(isInsideProject("/home/u/app", "/home/u/app-secrets/a")).toBe(false);
    expect(isInsideProject("/home/u/app", "/home/u")).toBe(false);
  });
});
