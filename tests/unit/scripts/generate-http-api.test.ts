import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateHttpApi } from "../../../scripts/lib/generate-http-api.ts";

const dirs: string[] = [];

function makeFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ppm-httpapi-"));
  dirs.push(root);
  mkdirSync(resolve(root, "src/server/routes"), { recursive: true });

  writeFileSync(
    resolve(root, "src/server/index.ts"),
    [
      `import { fooRoutes } from "./routes/foo";`,
      `import { barRoutes } from "./routes/bar";`,
      `import { nestRoutes } from "./routes/nest";`,
      `const app: any = {};`,
      `app.get("/api/health", () => {});`,
      `app.route("/api/foo", fooRoutes);`,
      `app.route("/api/bar", barRoutes);`,
      `app.route("/api/project/:projectName", nestRoutes);`,
      `if (url.pathname === "/ws/global") {}`,
      `if (wsType === "terminal") {}`,
      `if (wsType === "chat") {}`,
    ].join("\n"),
  );

  writeFileSync(
    resolve(root, "src/server/routes/foo.ts"),
    [
      `export const fooRoutes: any = {};`,
      `fooRoutes.get("/", () => {});`,
      `fooRoutes.post("/", () => {});`,
      `fooRoutes.delete("/:id", () => {});`,
      // Not routes: a config read and a context variable, which a route file is full of.
      `const auth = configService.get("auth");`,
      `fooRoutes.get("/me", (c: any) => c.get("projectPath"));`,
    ].join("\n"),
  );

  // A router that only mounts others, two of them living in one file.
  writeFileSync(
    resolve(root, "src/server/routes/nest.ts"),
    [
      `import { gitRoutes, jobRoutes } from "./git";`,
      `export const nestRoutes: any = {};`,
      `nestRoutes.route("/git", gitRoutes);`,
      `nestRoutes.route("/jobs", jobRoutes);`,
    ].join("\n"),
  );
  writeFileSync(
    resolve(root, "src/server/routes/git.ts"),
    [
      `export const gitRoutes: any = {};`,
      `export const jobRoutes: any = {};`,
      `gitRoutes.get("/status", () => {});`,
      `jobRoutes.post("/:id/cancel", () => {});`,
    ].join("\n"),
  );

  // A router built by a factory: its calls are on a local, not on the exported name.
  writeFileSync(
    resolve(root, "src/server/routes/bar.ts"),
    [
      `function createBarRoutes() {`,
      `  const routes: any = {};`,
      `  routes.get("/list", () => {});`,
      `  routes.put("/update/:id", () => {});`,
      `  return routes;`,
      `}`,
      `export const barRoutes = createBarRoutes();`,
    ].join("\n"),
  );

  writeFileSync(resolve(root, "package.json"), JSON.stringify({ version: "0.0.1" }));
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("generateHttpApi", () => {
  it("groups routes by mount prefix", () => {
    const root = makeFixture();
    const result = generateHttpApi(root);
    expect(result).toHaveLength(1);

    const md = result[0]!.content;
    expect(md).toContain("## /api/foo");
    expect(md).toContain("## /api/bar");
  });

  it("lists methods with full joined paths", () => {
    const root = makeFixture();
    const md = generateHttpApi(root)[0]!.content;

    expect(md).toMatch(/GET\s+\/api\/foo/);
    expect(md).toMatch(/POST\s+\/api\/foo/);
    expect(md).toMatch(/DELETE\s+\/api\/foo\/:id/);
    expect(md).toMatch(/GET\s+\/api\/bar\/list/);
    expect(md).toMatch(/PUT\s+\/api\/bar\/update\/:id/);
  });

  it("sorts prefixes alphabetically", () => {
    const root = makeFixture();
    const md = generateHttpApi(root)[0]!.content;

    const barIdx = md.indexOf("## /api/bar");
    const fooIdx = md.indexOf("## /api/foo");
    expect(barIdx).toBeGreaterThan(-1);
    expect(fooIdx).toBeGreaterThan(barIdx);
  });

  it("follows nested mounts, taking each router's own calls only", () => {
    const md = generateHttpApi(makeFixture())[0]!.content;
    expect(md).toContain("## /api/project/:projectName/git");
    expect(md).toMatch(/GET\s+\/api\/project\/:projectName\/git\/status`/);
    expect(md).toMatch(/POST\s+\/api\/project\/:projectName\/jobs\/:id\/cancel`/);
    // Two routers in one file: neither one's routes appear under the other's mount.
    expect(md).not.toContain("/git/:id/cancel");
    expect(md).not.toContain("/jobs/status");
  });

  it("lists the server's own routes", () => {
    const md = generateHttpApi(makeFixture())[0]!.content;
    expect(md).toMatch(/GET\s+\/api\/health`/);
  });

  it("does not take a config read or a context variable for a route", () => {
    const md = generateHttpApi(makeFixture())[0]!.content;
    expect(md).toMatch(/GET\s+\/api\/foo\/me`/);
    expect(md).not.toContain("/api/foo/auth");
    expect(md).not.toContain("projectPath");
  });

  it("says how to authenticate", () => {
    const md = generateHttpApi(makeFixture())[0]!.content;
    expect(md).toContain("## Authentication");
    expect(md).toContain("Authorization: Bearer <token>");
    expect(md).toContain("?token=<token>");
  });

  it("lists the WebSocket paths the server upgrades", () => {
    const md = generateHttpApi(makeFixture())[0]!.content;
    expect(md).toContain("## WebSocket");
    expect(md).toContain("`/ws/global`");
    expect(md).toContain("`/ws/project/<project>/<type>/<id>` — `<type>`: `terminal`, `chat`");
    expect(md).not.toContain("Scanner warnings");
  });

  it("returns graceful placeholder when server index missing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ppm-noidx-"));
    dirs.push(root);
    const md = generateHttpApi(root)[0]!.content;
    expect(md).toContain("Server index not found");
  });
});
