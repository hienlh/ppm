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
      `const app: any = {};`,
      `app.route("/api/foo", fooRoutes);`,
      `app.route("/api/bar", barRoutes);`,
    ].join("\n"),
  );

  writeFileSync(
    resolve(root, "src/server/routes/foo.ts"),
    [
      `export const fooRoutes: any = {};`,
      `fooRoutes.get("/", () => {});`,
      `fooRoutes.post("/", () => {});`,
      `fooRoutes.delete("/:id", () => {});`,
    ].join("\n"),
  );

  writeFileSync(
    resolve(root, "src/server/routes/bar.ts"),
    [
      `export const barRoutes: any = {};`,
      `barRoutes.get("/list", () => {});`,
      `barRoutes.put("/update/:id", () => {});`,
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

  it("appends WebSocket section", () => {
    const root = makeFixture();
    const md = generateHttpApi(root)[0]!.content;
    expect(md).toContain("## WebSocket");
    expect(md).toContain("/ws/chat");
  });

  it("returns graceful placeholder when server index missing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ppm-noidx-"));
    dirs.push(root);
    const md = generateHttpApi(root)[0]!.content;
    expect(md).toContain("Server index not found");
  });
});
