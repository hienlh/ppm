/**
 * The projects table and config rows are shared by every process that opens the database: the
 * server, and any `ppm` command run beside it (the PPM Assistant runs `ppm projects add` from its
 * shell). A write from one process must survive the other's next save, and the server must see
 * the other's change without a restart.
 *
 * Two connections to one database file stand in for the two processes: the config service's own
 * (the "server") and `other`, which writes the way a separate process would.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDbPragmas, getConfigValue, getProjects, getProjectSettingsJson, openTestDb,
  patchProjectSettingsJson, runMigrations, setDb,
} from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import type { ProjectConfig } from "../../../src/types/config.ts";

let dir: string;
let other: Database;

/** The service's in-memory list as it stands, without the refresh a read would do. */
const heldInMemory = (): ProjectConfig[] => [...(configService as unknown as { config: { projects: ProjectConfig[] } }).config.projects];
const names = (list: { name: string }[]) => list.map((p) => p.name);
const insertElsewhere = (path: string, name: string) => {
  const max = (other.query("SELECT COALESCE(MAX(sort_order), -1) AS m FROM projects").get() as { m: number }).m;
  other.query("INSERT INTO projects (path, name, sort_order) VALUES (?, ?, ?)").run(path, name, max + 1);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-config-xproc-"));
  const file = join(dir, "ppm.db");
  const server = new Database(file);
  applyDbPragmas(server);
  runMigrations(server);
  setDb(server);
  configService.load();
  configService.set("projects", [{ path: "/p/alpha", name: "alpha" }, { path: "/p/beta", name: "beta" }]);
  other = new Database(file);
  applyDbPragmas(other);
});

afterEach(() => {
  other.close();
  setDb(openTestDb());
  configService.load();
  // Other test files share this process and expect the preload's auth-off config.
  (configService as unknown as { config: { auth: unknown } }).config.auth = { enabled: false, token: "" };
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
});

describe("a project another process changes while the server runs", () => {
  it("an addition survives the server's next save", () => {
    insertElsewhere("/p/gamma", "gamma");
    configService.save();
    expect(names(getProjects())).toEqual(["alpha", "beta", "gamma"]);
  });

  it("the server lists the addition without a restart", () => {
    insertElsewhere("/p/gamma", "gamma");
    expect(names(configService.get("projects"))).toEqual(["alpha", "beta", "gamma"]);
    expect(names(configService.getAll().projects)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("a removal is not put back by the server's next save", () => {
    other.query("DELETE FROM projects WHERE name = 'beta'").run();
    configService.save();
    expect(names(getProjects())).toEqual(["alpha"]);
    expect(names(configService.get("projects"))).toEqual(["alpha"]);
  });

  it("an addition made by the server from a stale list keeps the other one too", () => {
    const stale = heldInMemory();
    insertElsewhere("/p/gamma", "gamma");
    configService.set("projects", [...stale, { path: "/p/delta", name: "delta" }]);
    expect(names(getProjects())).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(names(configService.get("projects"))).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("a reorder made from a stale list keeps the other process's addition, after the reordered ones", () => {
    const stale = heldInMemory();
    insertElsewhere("/p/gamma", "gamma");
    configService.set("projects", [stale[1]!, stale[0]!]);
    expect(names(getProjects())).toEqual(["beta", "alpha", "gamma"]);
  });

  it("an edit made elsewhere is not reverted by an unrelated save from a stale list", () => {
    const stale = heldInMemory();
    other.query("UPDATE projects SET color = '#123456' WHERE name = 'alpha'").run();
    configService.set("projects", [...stale, { path: "/p/delta", name: "delta" }]);
    expect(getProjects().find((p) => p.name === "alpha")!.color).toBe("#123456");
  });
});

describe("a save keeps project rows in place", () => {
  it("leaves per-project settings and the rows that reference a project alone", () => {
    const alphaId = getProjects().find((p) => p.name === "alpha")!.id;
    patchProjectSettingsJson("/p/alpha", JSON.stringify({ files: { exclude: ["dist"] } }));
    other.query("INSERT INTO jira_config (project_id, base_url, email, api_token_encrypted) VALUES (?, 'https://x', 'a@b', 'enc')").run(alphaId);

    configService.set("theme", { style: "slate", mode: "dark" });
    configService.save();
    configService.set("projects", [...configService.get("projects"), { path: "/p/delta", name: "delta" }]);

    expect(getProjects().find((p) => p.name === "alpha")!.id).toBe(alphaId);
    expect(JSON.parse(getProjectSettingsJson("/p/alpha"))).toEqual({ files: { exclude: ["dist"] } });
    // jira_config cascades from projects(id): rewriting the table used to delete it.
    expect(other.query("SELECT COUNT(*) AS n FROM jira_config").get()).toEqual({ n: 1 });
  });

  it("a project moved to another path keeps its row", () => {
    const alphaId = getProjects().find((p) => p.name === "alpha")!.id;
    patchProjectSettingsJson("/p/alpha", JSON.stringify({ k: 1 }));
    const list = configService.get("projects").map((p) => (p.name === "alpha" ? { ...p, path: "/p/alpha-2" } : p));
    configService.set("projects", list);
    const row = getProjects().find((p) => p.name === "alpha")!;
    expect(row.id).toBe(alphaId);
    expect(row.path).toBe("/p/alpha-2");
    expect(JSON.parse(getProjectSettingsJson("/p/alpha-2"))).toEqual({ k: 1 });
  });

  it("keeps a custom avatar in memory across a refresh caused by another process", () => {
    configService.set("projects", configService.get("projects").map((p) => (p.name === "alpha" ? { ...p, image: "abc.webp" } : p)));
    insertElsewhere("/p/gamma", "gamma");
    expect(configService.get("projects").find((p) => p.name === "alpha")!.image).toBe("abc.webp");
  });
});

describe("config rows another process writes while the server runs", () => {
  it("survive a server save that did not change them", () => {
    other.query("INSERT INTO config (key, value) VALUES ('device_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify("set-by-cli"));
    configService.set("port", 5555);
    configService.save();
    expect(JSON.parse(getConfigValue("device_name")!)).toBe("set-by-cli");
    expect(JSON.parse(getConfigValue("port")!)).toBe(5555);
  });

  it("are still overwritten by a key the server itself changed", () => {
    other.query("INSERT INTO config (key, value) VALUES ('device_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify("set-by-cli"));
    configService.getAll().device_name = "set-by-server";
    configService.save();
    expect(JSON.parse(getConfigValue("device_name")!)).toBe("set-by-server");
  });
});
