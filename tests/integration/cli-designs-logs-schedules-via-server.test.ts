/**
 * `ppm design`, `ppm logs issues` and `ppm schedule` with a server holding the database: each goes
 * through the real route its screen calls, so the running PPM makes the change and every open
 * browser is told (`design:list_changed`, `schedules:changed`, recorded on the scratch server's
 * `/ws/global`). A design is deleted only with `--yes`; `schedule add|edit|enable` are refused
 * from an AI chat and nothing reaches the server; `rm` and `disable` are not.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const AI = { PPM_AI_CHAT: "1" };
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;
const count = async (type: string) => (await server.events()).filter((e) => e.type === type).length;
const schedules = () => server.scratch<Array<{ id: number; name: string; enabled: number }>>("schedules");

async function ok(args: string[], env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ args, code: 0 });
  return r;
}

async function refused(args: string[], message: string, env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  expect(r.stderr).toContain(message);
  return r;
}

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null, undefined, "cli-designs-scratch-server-main.ts");
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(`${home}-project`, { recursive: true, force: true });
});

describe("ppm design through the server", () => {
  const designs = async () => (JSON.parse((await ok(["design", "list", "-p", "demo", "--json"])).stdout) as { designs: Array<{ slug: string; title: string }> }).designs;

  it("creates and renames a design in the running PPM, and tells every open browser", async () => {
    const before = await count("design:list_changed");
    const made = await ok(["design", "create", "Landing page", "-p", "demo", "--json"]);
    expect(made.stderr).toContain(target());
    const { slug } = JSON.parse(made.stdout) as { slug: string };
    await ok(["design", "rename", slug, "Landing v2", "-p", "demo"]);
    expect((await designs()).find((d) => d.slug === slug)?.title).toBe("Landing v2");
    const events = (await server.events()).filter((e) => e.type === "design:list_changed");
    expect(events.length - before).toBe(2);
    expect(events.at(-1)?.projectName).toBe("demo");
  }, 60_000);

  it("deletes nothing without --yes, and deletes with it", async () => {
    const { slug } = JSON.parse((await ok(["design", "create", "Doomed", "-p", "demo", "--json"])).stdout) as { slug: string };
    const before = await count("design:list_changed");
    const dry = await ok(["design", "delete", slug, "-p", "demo"]);
    expect(dry.stdout).toContain(`Would delete design ${slug}`);
    expect(dry.stdout).toContain("Nothing was deleted");
    expect((await designs()).some((d) => d.slug === slug)).toBe(true);
    expect(existsSync(join(`${home}-project`, "designs", slug))).toBe(true);
    expect(await count("design:list_changed")).toBe(before);

    await ok(["design", "delete", slug, "-p", "demo", "--yes"]);
    expect((await designs()).some((d) => d.slug === slug)).toBe(false);
    expect(existsSync(join(`${home}-project`, "designs", slug))).toBe(false);
    expect(await count("design:list_changed")).toBe(before + 1);
  }, 60_000);

  it("exports a design to a file, as a zip and as one HTML file", async () => {
    const { slug } = JSON.parse((await ok(["design", "create", "Export me", "-p", "demo", "--json"])).stdout) as { slug: string };
    const zip = join(home, "out", "design.zip");
    await ok(["design", "export", slug, "--zip", "-o", zip, "-p", "demo"]);
    expect(readFileSync(zip).subarray(0, 2).toString("latin1")).toBe("PK");
    const html = join(home, "out", "design.html");
    await ok(["design", "export", slug, "--html", "-o", html, "-p", "demo"]);
    expect(readFileSync(html, "utf8").toLowerCase()).toContain("<html");
    await refused(["design", "export", slug, "-o", html, "-p", "demo"], "Pass one of --zip or --html");
    await refused(["design", "export", "no-such-design", "--zip", "-o", zip, "-p", "demo"], "not found");
  }, 60_000);

  it("lists a design's history and refuses a malformed snapshot id at the route", async () => {
    const { slug } = JSON.parse((await ok(["design", "create", "History", "-p", "demo", "--json"])).stdout) as { slug: string };
    expect(JSON.parse((await ok(["design", "history", slug, "-p", "demo", "--json"])).stdout)).toBeArray();
    await refused(["design", "restore", slug, "not-a-snapshot", "-p", "demo"], "Invalid snapshot id");
  }, 60_000);
});

describe("ppm logs issues through the server", () => {
  it("lists, sorts, switches Auto and refuses what does not exist", async () => {
    const listed = JSON.parse((await ok(["logs", "issues", "--json"])).stdout) as { issues: unknown[]; auto: boolean };
    expect(listed.issues).toEqual([]);
    expect((await ok(["logs", "issues", "analyze"])).stdout).toContain("Sorted");
    await ok(["logs", "issues", "auto", "off"]);
    expect((JSON.parse((await ok(["logs", "issues", "--json"])).stdout) as { auto: boolean }).auto).toBe(false);
    await refused(["logs", "issues", "dismiss", "no-such-issue"], "No such issue");
    await refused(["logs", "issues", "undismiss"], "Name one issue, or pass --all");
    await ok(["logs", "issues", "undismiss", "--all"]);
    await refused(["logs", "report", "draft", "no-such-issue"], "No issue no-such-issue");
  }, 60_000);
});

describe("ppm schedule through the server", () => {
  const add = ["schedule", "add", "--name", "Morning", "--cron", "0 7 * * *", "--project", "demo", "--prompt", "Say hi", "--disabled"];

  it("refuses add from an AI chat before anything reaches the server", async () => {
    const before = await count("schedules:changed");
    const r = await refused(add, "refused here from an AI chat", AI);
    expect(r.stderr).toContain("schedule_save");
    expect(r.stderr).not.toContain(target());
    expect(await schedules()).toEqual([]);
    expect(await count("schedules:changed")).toBe(before);
  }, 60_000);

  it("adds, edits, disables and removes through the route, each heard by an open Schedules panel", async () => {
    const before = await count("schedules:changed");
    const made = await ok(add);
    expect(made.stderr).toContain(target());
    const [row] = await schedules();
    expect(row).toMatchObject({ name: "Morning", enabled: 0 });
    expect(await count("schedules:changed")).toBe(before + 1);

    await ok(["schedule", "edit", String(row!.id), "--name", "Evening"]);
    expect((await schedules())[0]?.name).toBe("Evening");
    await refused(["schedule", "edit", String(row!.id), "--name", "Sneaky"], "refused here from an AI chat", AI);
    await refused(["schedule", "enable", String(row!.id)], "refused here from an AI chat", AI);
    expect((await schedules())[0]).toMatchObject({ name: "Evening", enabled: 0 });
    await refused(["schedule", "edit", String(row!.id)], "Nothing to change");

    await ok(["schedule", "enable", String(row!.id)]);
    expect((await schedules())[0]?.enabled).toBe(1);
    await ok(["schedule", "disable", String(row!.id)], AI);
    expect((await schedules())[0]?.enabled).toBe(0);
    await refused(["schedule", "edit", String(row!.id), "--cron", "not a cron"], "cron");

    await ok(["schedule", "rm", String(row!.id), "-y"], AI);
    expect(await schedules()).toEqual([]);
    expect(await count("schedules:changed")).toBe(before + 5);
  }, 60_000);
});

describe("without a running PPM", () => {
  it("writes a schedule directly, with the notice", async () => {
    const lone = scratchHome();
    const folder = scratchHome();
    try {
      // The lone home has a database of its own; register its project the way a person would.
      const added = await runCli(lone, ["projects", "add", folder, "--name", "demo"]);
      expect({ code: added.code, err: added.stderr }).toMatchObject({ code: 0 });
      const r = await runCli(lone, ["schedule", "add", "--name", "Offline", "--cron", "0 7 * * *", "--project", "demo", "--prompt", "Hi"]);
      expect({ code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
      expect(r.stderr).toContain("written directly");
      expect(r.stderr).not.toContain("→ PPM");
      expect((await runCli(lone, ["schedule", "list"])).stdout).toContain("Offline");
    } finally {
      rmSync(lone, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    }
  }, 60_000);
});
