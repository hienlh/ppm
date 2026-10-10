import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { registerProjectsCommands } from "../../../../src/cli/commands/projects.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { DEFAULT_CONFIG } from "../../../../src/types/config.ts";

// The commands print rather than return, so the scenarios capture console output.
let lines: string[] = [];
let origLog: typeof console.log;
let origError: typeof console.error;

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  configService.set("projects", [{ path: "/nonexistent/alpha", name: "alpha" }, { path: "/nonexistent/beta", name: "beta" }]);
  // A `ppm` process starts with a config service that has not loaded anything: pristine
  // defaults, no projects. Put this one back in that state; the projects stay in the database.
  const svc = configService as unknown as { loaded: boolean; config: unknown };
  svc.loaded = false;
  svc.config = structuredClone(DEFAULT_CONFIG);
  lines = [];
  origLog = console.log;
  origError = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origError;
  configService.load();
  (configService as unknown as { config: { auth: unknown } }).config.auth = { enabled: false, token: "" };
});

/** What the command printed, minus the `[scope] …` lines the services log (stderr in a real CLI). */
const printed = () => lines.filter((l) => !/^\[[a-z][\w-]*\] /.test(l)).join("\n");

async function run(...args: string[]) {
  const origExit = process.exit;
  (process as unknown as { exit: (code?: number) => void }).exit = () => { throw new Error("__exit__"); };
  try {
    const p = new Command();
    registerProjectsCommands(p);
    await p.parseAsync(["node", "ppm", "projects", ...args]);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    process.exit = origExit;
  }
}

describe("ppm projects list", () => {
  it("lists the projects in the database of a process that has not loaded the config yet", async () => {
    await run("list");
    const out = lines.join("\n");
    expect(out).not.toContain("No projects registered");
    expect(out).toContain("alpha");
    expect(out).toContain("/nonexistent/beta");
  });

  it("--json prints name and path for each project, and nothing else", async () => {
    await run("list", "--json");
    expect(JSON.parse(printed())).toEqual([
      { name: "alpha", path: "/nonexistent/alpha" },
      { name: "beta", path: "/nonexistent/beta" },
    ]);
  });

  it("--json prints an empty list when nothing is registered", async () => {
    configService.load();
    configService.set("projects", []);
    await run("list", "--json");
    expect(JSON.parse(printed())).toEqual([]);
  });
});
