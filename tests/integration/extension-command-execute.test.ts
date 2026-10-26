/**
 * The execute route against a real extension host worker: a fixture extension is dev-linked
 * into a scratch PPM_HOME, activated in the worker, and driven through the real route.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// A scratch PPM_HOME and database of its own. afterAll puts the preload's PPM_HOME back and a fresh
// test database in place: every test file shares this process. The preload's in-memory config
// (auth off) is left as it is, never reloaded.
const home = mkdtempSync(resolve(tmpdir(), "ppm-ext-exec-"));
const originalHome = process.env.PPM_HOME;
process.env.PPM_HOME = home;

const { _resetPpmDir } = await import("../../src/services/ppm-dir.ts");
_resetPpmDir();
const { openTestDb, setDb } = await import("../../src/services/db.service.ts");
setDb(openTestDb());
const { extensionService } = await import("../../src/services/extension.service.ts");
const { extensionRoutes } = await import("../../src/server/routes/extensions.ts");
const { extensionWebSocket } = await import("../../src/server/ws/extensions.ts");
const { resetClientTimeZone } = await import("../../src/services/client-timezone.ts");
resetClientTimeZone();

const EXT_ID = "ppm-test-commands";
const DEVICE = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";

function writeFixture(): string {
  const dir = resolve(home, "fixture-ext");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({
    name: EXT_ID,
    version: "1.0.0",
    main: "index.js",
    contributes: {
      commands: [
        { command: "fixture.echo", title: "Echo" },
        { command: "fixture.throw", title: "Throw" },
        { command: "fixture.sleep", title: "Sleep" },
        { command: "fixture.nothing", title: "Returns nothing" },
        { command: "fixture.declaredOnly", title: "Declared, never registered" },
        { command: "fixture.zone", title: "Client time zone" },
        { command: "fixture.bigint", title: "Returns what JSON cannot carry" },
      ],
    },
  }));
  writeFileSync(resolve(dir, "index.js"), `
    exports.activate = function (context, vscode) {
      const changes = [];
      context.subscriptions.push(
        vscode.env.onDidChangeClientTimeZone((e) => changes.push(e.timeZone)),
        vscode.commands.registerCommand("fixture.zone", () => ({ zone: vscode.env.clientTimeZone ?? null, changes })),
        vscode.commands.registerCommand("fixture.echo", (...args) => ({ args })),
        vscode.commands.registerCommand("fixture.throw", () => { throw new Error("handler blew up"); }),
        vscode.commands.registerCommand("fixture.sleep", () => new Promise((r) => setTimeout(() => r("late"), 2500))),
        vscode.commands.registerCommand("fixture.nothing", () => undefined),
        vscode.commands.registerCommand("fixture.bigint", () => ({ n: 10n })),
        vscode.commands.registerCommand("fixture.undeclared", () => "should never run"),
      );
    };
  `);
  return dir;
}

async function execute(body: unknown, headers: Record<string, string> = {}) {
  const res = await extensionRoutes.request("/commands/execute", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

beforeAll(async () => {
  await extensionService.devLink(writeFixture());
  const deadline = Date.now() + 10_000;
  while (!extensionService.isHostReady() && Date.now() < deadline) await Bun.sleep(25);
  expect(extensionService.isActivated(EXT_ID)).toBe(true);
}, 30_000);

afterAll(async () => {
  await extensionService.shutdown();
  resetClientTimeZone();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  setDb(openTestDb()); // setDb closed the preload's; a fresh one is what it held
  rmSync(home, { recursive: true, force: true });
});

describe("POST /api/extensions/commands/execute with a real worker", () => {
  it("spreads args into the handler and answers its result", async () => {
    const { status, body } = await execute({ command: "fixture.echo", args: [["list", "--json"], 2] });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ command: "fixture.echo", extensionId: EXT_ID, result: { args: [["list", "--json"], 2] } });
    expect(typeof body.data.durationMs).toBe("number");
  });

  it("answers result null for a handler returning undefined", async () => {
    const { status, body } = await execute({ command: "fixture.nothing" });
    expect(status).toBe(200);
    expect(body.data.result).toBeNull();
  });

  it("500 COMMAND_FAILED with the thrown message", async () => {
    const { status, body } = await execute({ command: "fixture.throw" });
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, code: "COMMAND_FAILED" });
    expect(body.error).toContain("handler blew up");
  });

  it("500 COMMAND_FAILED, not a bare error, for a result JSON cannot carry", async () => {
    const { status, body } = await execute({ command: "fixture.bigint" });
    expect(status).toBe(500);
    expect(body.code).toBe("COMMAND_FAILED");
    expect(body.error).toContain("cannot be sent back");
  });

  it("504 TIMEOUT when the handler outlasts timeoutMs", async () => {
    const { status, body } = await execute({ command: "fixture.sleep", timeoutMs: 1000 });
    expect(status).toBe(504);
    expect(body.code).toBe("TIMEOUT");
  }, 10_000);

  it("404 for a command registered in code but never declared", async () => {
    const { status, body } = await execute({ command: "fixture.undeclared" });
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("404 for a command declared but with no handler in the worker", async () => {
    const { status, body } = await execute({ command: "fixture.declaredOnly" });
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toContain("no handler");
  });

  it("403 for a request carrying an Origin", async () => {
    const { status, body } = await execute({ command: "fixture.echo" }, { Origin: "http://evil.test" });
    expect(status).toBe(403);
    expect(body.code).toBe("ORIGIN_REFUSED");
  });

  it("hands the browser's time zone to extensions, firing only on a change", async () => {
    const ws = { data: { type: "extensions" }, send: () => {} };
    const report = (timeZone: string) => extensionWebSocket.message(ws, JSON.stringify({ type: "client:timezone", timeZone, deviceId: DEVICE }));
    const zone = async () => (await execute({ command: "fixture.zone" })).body.data.result as { zone: string | null; changes: string[] };

    expect(await zone()).toEqual({ zone: null, changes: [] });
    await report("Europe/London");
    await Bun.sleep(50);
    expect(await zone()).toEqual({ zone: "Europe/London", changes: ["Europe/London"] });
    await report("Europe/London");
    await report("Not/AZone");
    await Bun.sleep(50);
    expect(await zone()).toEqual({ zone: "Europe/London", changes: ["Europe/London"] });
    await report("Asia/Saigon");
    await Bun.sleep(50);
    expect(await zone()).toEqual({ zone: "Asia/Saigon", changes: ["Europe/London", "Asia/Saigon"] });
  });

  it("gives a rebuilt host the zone a browser already reported", async () => {
    await extensionService.shutdown();
    await extensionService.activate(EXT_ID);
    const deadline = Date.now() + 10_000;
    while (!extensionService.isHostReady() && Date.now() < deadline) await Bun.sleep(25);
    await Bun.sleep(50);
    expect((await execute({ command: "fixture.zone" })).body.data.result.zone).toBe("Asia/Saigon");
  }, 20_000);

  it("403 NOT_ACTIVE once the extension is disabled", async () => {
    await extensionService.setEnabled(EXT_ID, false);
    try {
      const { status, body } = await execute({ command: "fixture.echo" });
      expect(status).toBe(403);
      expect(body.code).toBe("NOT_ACTIVE");
    } finally {
      await extensionService.setEnabled(EXT_ID, true);
    }
  }, 20_000);
});
