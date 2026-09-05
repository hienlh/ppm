import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { openTestDb, setDb, setConfigValue } from "../../../../src/services/db.service.ts";
import { getQuickTunnelArgs } from "../../../../src/services/cloudflared.service.ts";
import {
  readTunnelConfigFresh, chooseTunnelSpawn,
} from "../../../../src/services/named-tunnel/named-tunnel-runtime.ts";

const TEST_PORT = 39878; // outside the Hyper-V reserved range (44620-48715)

const FULL_NAMED = {
  mode: "named",
  namedTunnelName: "ppm-host",
  namedTunnelHostname: "ppm.hienle.tech",
  namedTunnelToken: "secret-run-token",
  zoneID: "a".repeat(32),
  accountID: "b".repeat(32),
};

describe("named-tunnel-runtime", () => {
  let ppmHome: string;

  beforeEach(() => {
    ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-nt-runtime-"));
    process.env.PPM_HOME = ppmHome;
    _resetPpmDir();
    setDb(openTestDb());
  });

  afterEach(() => {
    delete process.env.PPM_HOME;
    _resetPpmDir();
    rmSync(ppmHome, { recursive: true, force: true });
  });

  test("readTunnelConfigFresh resolves quick when no config row exists", async () => {
    const cfg = await readTunnelConfigFresh();
    expect(cfg.mode).toBe("quick");
  });

  test("readTunnelConfigFresh resolves named once the row is fully populated", async () => {
    setConfigValue("tunnel", JSON.stringify(FULL_NAMED));
    const cfg = await readTunnelConfigFresh();
    expect(cfg.mode).toBe("named");
    expect(cfg.hostname).toBe("ppm.hienle.tech");
  });

  test("chooseTunnelSpawn quick argv is byte-identical to getQuickTunnelArgs", () => {
    const plan = chooseTunnelSpawn({ mode: "quick", hostname: null, tunnelName: null, token: null, zoneID: null, accountID: null, dismissed: false }, TEST_PORT);
    expect(plan.mode).toBe("quick");
    expect(plan.args).toEqual(getQuickTunnelArgs(TEST_PORT));
  });

  test("chooseTunnelSpawn picks named argv with --token-file, never the token literal", () => {
    const plan = chooseTunnelSpawn(
      { mode: "named", hostname: "ppm.hienle.tech", tunnelName: "ppm-host", token: "super-secret", zoneID: "a".repeat(32), accountID: "b".repeat(32), dismissed: false },
      TEST_PORT,
    );
    expect(plan.mode).toBe("named");
    expect(plan.args).not.toContain("super-secret");
    expect(plan.args).toContain("--token-file");
    expect(plan.args).toEqual(expect.arrayContaining(["--url", `http://127.0.0.1:${TEST_PORT}`]));
  });

  test("chooseTunnelSpawn falls back to quick when config claims named but token is empty", () => {
    const plan = chooseTunnelSpawn(
      { mode: "named", hostname: "ppm.hienle.tech", tunnelName: "ppm-host", token: null, zoneID: "a".repeat(32), accountID: "b".repeat(32), dismissed: false },
      TEST_PORT,
    );
    expect(plan.mode).toBe("quick");
    expect(plan.args).toEqual(getQuickTunnelArgs(TEST_PORT));
  });
});
