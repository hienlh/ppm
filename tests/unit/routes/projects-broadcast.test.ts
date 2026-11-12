/**
 * Every project route that writes tells open PPMs the project list changed, once, and only when it
 * answered 2xx; a read or a refused write says nothing. Run against the real project routes, with
 * the announcement handed in the way the CLI hands in its own.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { projectRoutes } from "../../../src/server/routes/projects.ts";
import { ANNOUNCE_PROJECTS_ENV_KEY } from "../../../src/server/routes/projects-broadcast.ts";

let announced = 0;
const env = { [ANNOUNCE_PROJECTS_ENV_KEY]: () => { announced++; } };
const call = (path: string, method = "GET", body?: unknown) => projectRoutes.request(path, {
  method,
  ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
}, env);

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  configService.set("projects", []);
  announced = 0;
});

describe("projects:changed from the project routes", () => {
  it("a write that succeeds announces once", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ppm-broadcast-"));
    expect((await call("/", "POST", { path: folder, name: "alpha" })).status).toBe(201);
    expect(announced).toBe(1);
    expect((await call("/alpha/color", "PATCH", { color: "#112233" })).status).toBe(200);
    expect((await call("/alpha", "PATCH", { name: "beta" })).status).toBe(200);
    expect((await call("/reorder", "PATCH", { order: ["beta"] })).status).toBe(200);
    expect((await call("/beta", "DELETE")).status).toBe(200);
    expect(announced).toBe(5);
  });

  it("a read announces nothing", async () => {
    expect((await call("/")).status).toBe(200);
    expect((await call("/last-clone-dir")).status).toBe(200);
    expect(announced).toBe(0);
  });

  it("a refused write announces nothing", async () => {
    expect((await call("/nope/color", "PATCH", { color: "#112233" })).status).toBe(404);
    expect((await call("/nope", "DELETE")).status).toBe(404);
    expect((await call("/", "POST", {})).status).toBe(400);
    expect(announced).toBe(0);
  });

  it("refuses the name the reorder route already takes", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ppm-broadcast-"));
    const res = await call("/", "POST", { path: folder, name: "reorder" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("reserved");
    expect(announced).toBe(0);
  });
});
