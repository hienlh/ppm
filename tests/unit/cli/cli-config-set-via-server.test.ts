/**
 * `ppm config set` with a server holding the database: the change goes through the server, so it
 * is in the server's memory at once, on the database of the profile asked for and no other. The
 * CLI says which PPM it talked to. Secrets are refused to everyone, exposure keys to an AI chat.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../../helpers/cli-scratch-server.ts";

let home: string;
let dev: ScratchServer;

beforeAll(async () => {
  home = scratchHome();
  dev = await startScratchServer(home, "dev");
}, 60_000);
afterAll(async () => {
  await dev?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm config set through the server", () => {
  it("PPM_PROFILE=dev changes the dev server's memory and leaves ppm.db alone", async () => {
    const r = await runCli(home, ["config", "set", "log_level", "debug"], { PPM_PROFILE: "dev" });
    expect({ code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
    expect(r.stderr).toContain(`→ PPM dev (ppm.dev.db) at 127.0.0.1:${dev.port}`);
    expect((await dev.config()).log_level).toBe("debug");
    expect(existsSync(join(home, "ppm.db"))).toBe(false);
  }, 60_000);

  it("--profile before the command does the same, and types the value", async () => {
    const r = await runCli(home, ["--profile", "dev", "config", "set", "query_audit.retention_days", "7"]);
    expect(r.code).toBe(0);
    expect(((await dev.config()).query_audit as { retention_days: number }).retention_days).toBe(7);
  }, 60_000);

  it("refuses a secret to everyone, before contacting any server", async () => {
    const r = await runCli(home, ["config", "set", "auth.token", "x"], { PPM_PROFILE: "dev" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is a secret");
    expect(r.stderr).not.toContain("→ PPM");
  }, 60_000);

  it("refuses an exposure key from an AI chat, and lets a person set it", async () => {
    const fromAi = await runCli(home, ["config", "set", "host", "0.0.0.0"], { PPM_PROFILE: "dev", PPM_AI_CHAT: "1" });
    expect(fromAi.code).toBe(1);
    expect(fromAi.stderr).toContain("not changed from an AI chat");
    const byPerson = await runCli(home, ["config", "set", "host", "127.0.0.1"], { PPM_PROFILE: "dev" });
    expect(byPerson.code).toBe(0);
    expect((await dev.config()).host).toBe("127.0.0.1");
  }, 60_000);

  it("sends a key with its own settings elsewhere", async () => {
    const r = await runCli(home, ["config", "set", "ntfy.server", "https://ntfy.example"], { PPM_PROFILE: "dev" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("drops the stored token");
  }, 60_000);
});
