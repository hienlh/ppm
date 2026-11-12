/**
 * With no PPM running on the database, `ppm config set` writes it directly and says so — which is
 * what makes `ppm init -y` followed by `ppm config set port …` work before PPM ever started. The
 * same checks as the server's route apply. A port that answers without a PPM behind it is a
 * refusal, never a write underneath whatever is there.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { rmSync } from "node:fs";
import { runCli, scratchHome } from "../../helpers/cli-scratch-server.ts";

let home: string;
let freePort: number;

beforeAll(() => {
  home = scratchHome();
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  freePort = probe.port;
  probe.stop(true);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("ppm config set with no server", () => {
  it("init then config set port writes directly, with a notice", async () => {
    const init = await runCli(home, ["init", "-y", "-p", String(freePort)]);
    expect({ code: init.code, err: init.stderr }).toMatchObject({ code: 0 });
    const set = await runCli(home, ["config", "set", "port", String(freePort)]);
    expect({ code: set.code, err: set.stderr }).toMatchObject({ code: 0 });
    expect(set.stderr).toContain("No PPM is running on ppm.db; written directly");
    const get = await runCli(home, ["config", "get", "port"]);
    expect(get.stdout.replace(/\x1b\[[0-9;]*m/g, "")).toContain(`port = ${freePort}`);
  }, 90_000);

  it("applies the same checks offline", async () => {
    const bad = await runCli(home, ["config", "set", "port", "not-a-port"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("expects a number");
    const ai = await runCli(home, ["config", "set", "host", "0.0.0.0"], { PPM_AI_CHAT: "1" });
    expect(ai.code).toBe(1);
  }, 60_000);

  it("refuses when something answers on the configured port", async () => {
    const squatter = Bun.serve({ port: freePort, hostname: "127.0.0.1", fetch: () => new Response("not ppm") });
    try {
      const r = await runCli(home, ["config", "set", "log_level", "debug"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Something is listening on port ${freePort}`);
    } finally {
      squatter.stop(true);
    }
  }, 60_000);
});
