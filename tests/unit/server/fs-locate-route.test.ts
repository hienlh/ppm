/**
 * `POST /api/fs/locate`: one answer per path, in the order asked, relative paths read against the
 * named project's folder, and the body checked before anything touches the disk.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { fsLocateRoutes } from "../../../src/server/routes/fs-locate.ts";
import { MAX_LOCATE_PATHS } from "../../../src/shared/file-browser-target.ts";

let root: string;
let saved: unknown;
const app = new Hono().route("/api/fs", fsLocateRoutes);
const post = (body: unknown) => app.request("http://localhost/api/fs/locate", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-fs-locate-"));
  mkdirSync(join(root, "demo", "src"), { recursive: true });
  writeFileSync(join(root, "demo", "src", "app.ts"), "x");
  saved = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: join(root, "demo") }]);
});
afterAll(() => {
  configService.set("projects", saved as never);
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/fs/locate", () => {
  it("answers each path in order, relative ones against the project", async () => {
    const res = await post({ project: "demo", paths: ["src/app.ts", join(root, "demo", "src"), "src/nope", "src"] });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { results: Array<Record<string, unknown>> } };
    expect(data.results.map((r) => [r.input, r.ok, r.kind ?? null])).toEqual([
      ["src/app.ts", true, "file"],
      [join(root, "demo", "src"), true, "folder"],
      ["src/nope", false, null],
      ["src", true, "folder"],
    ]);
    expect(data.results[0]!.select).toBe(join(root, "demo", "src", "app.ts"));
  });

  it("refuses relative paths with no project, and a bad body", async () => {
    const { data } = await (await post({ paths: ["src/app.ts"] })).json() as { data: { results: Array<{ ok: boolean }> } };
    expect(data.results[0]!.ok).toBe(false);
    expect((await post("not json")).status).toBe(400);
    expect((await post({ paths: "x" })).status).toBe(400);
    expect((await post({ paths: [1] })).status).toBe(400);
    expect((await post({ paths: Array.from({ length: MAX_LOCATE_PATHS + 1 }, () => "x") })).status).toBe(400);
  });
});
