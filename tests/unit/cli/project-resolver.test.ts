import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveProject } from "../../../src/cli/utils/project-resolver.ts";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  configService.set("projects", [{ path: "/nonexistent/alpha", name: "alpha" }]);
  // A `ppm` process starts with the pristine defaults; the project is only in the database.
  const svc = configService as unknown as { loaded: boolean; config: unknown };
  svc.loaded = false;
  svc.config = structuredClone(DEFAULT_CONFIG);
});
afterEach(() => {
  configService.load();
  (configService as unknown as { config: { auth: unknown } }).config.auth = { enabled: false, token: "" };
});

describe("resolveProject (git/chat -p)", () => {
  it("finds a registered project by name in a process that has not loaded the config yet", () => {
    expect(resolveProject({ project: "alpha" })).toMatchObject({ name: "alpha", path: "/nonexistent/alpha" });
  });

  it("still refuses a name nothing is registered under", () => {
    expect(() => resolveProject({ project: "nope" })).toThrow(/Project not found/);
  });
});
