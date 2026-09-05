import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { registerConfigCommands } from "../../../../src/cli/commands/config-cmd.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";

// `ppm config get` prints via console.log/console.error rather than returning a
// value, so every scenario below captures those calls instead of a return value.
let lines: string[] = [];
let origLog: typeof console.log;
let origError: typeof console.error;

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  lines = [];
  origLog = console.log;
  origError = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

function program() {
  const p = new Command();
  registerConfigCommands(p);
  return p;
}

/** `process.exit` is called on a not-found key; swallow it so the test process survives. */
async function run(...args: string[]) {
  const origExit = process.exit;
  (process as unknown as { exit: (code?: number) => void }).exit = () => { throw new Error("__exit__"); };
  try {
    await program().parseAsync(["node", "ppm", "config", ...args]);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    process.exit = origExit;
  }
}

describe("ppm config get — secret masking", () => {
  it("masks a leaf secret key directly, without ever loading the config", async () => {
    await run("get", "tunnel.namedTunnelToken");
    expect(lines.join("\n")).toContain("secret");
    expect(lines.join("\n")).not.toContain("s3cr3t-run-token");
  });

  it("masks the token inside an ANCESTOR object dump ('config get tunnel')", async () => {
    configService.set("tunnel", {
      mode: "named",
      namedTunnelHostname: "ppm.example.com",
      namedTunnelToken: "s3cr3t-run-token-do-not-leak",
      zoneID: "a".repeat(32),
      accountID: "b".repeat(32),
    } as any);

    await run("get", "tunnel");

    const out = lines.join("\n");
    expect(out).not.toContain("s3cr3t-run-token-do-not-leak");
    expect(out).toContain("[REDACTED]");
    // Siblings must still be visible — this is a targeted redact, not a blanket hide.
    expect(out).toContain("ppm.example.com");
    expect(out).toContain("named");
  });

  it("masks the token inside 'config get auth' the same way", async () => {
    configService.set("auth", { enabled: true, token: "s3cr3t-auth-token" } as any);
    await run("get", "auth");
    const out = lines.join("\n");
    expect(out).not.toContain("s3cr3t-auth-token");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("true"); // auth.enabled stays visible
  });

  it("leaves an unrelated key fully visible", async () => {
    await run("get", "tunnel.mode");
    expect(lines.join("\n")).toContain("quick");
  });
});
