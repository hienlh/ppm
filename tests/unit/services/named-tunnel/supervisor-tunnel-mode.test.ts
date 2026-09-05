import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import {
  buildTunnelAttempts, orphanedTunnelPgrepPattern, tunnelWarningPatchForSpawnSuccess,
} from "../../../../src/services/supervisor.ts";
import { getQuickTunnelArgs } from "../../../../src/services/cloudflared.service.ts";
import type { ResolvedTunnelConfig } from "../../../../src/services/named-tunnel/named-tunnel-config.ts";

const TEST_PORT = 39879; // outside the Hyper-V reserved range (44620-48715)

// buildTunnelAttempts writes real artifact files (named-tunnel config/token,
// quick-tunnel config) via getPpmDir() — isolate under a temp dir so this
// never touches a real ~/.ppm (which may be a running production instance).
let ppmHome: string;
beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-nt-supervisor-mode-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
});
afterEach(() => {
  delete process.env.PPM_HOME;
  _resetPpmDir();
  rmSync(ppmHome, { recursive: true, force: true });
});

const QUICK: ResolvedTunnelConfig = {
  mode: "quick", hostname: null, tunnelName: null, token: null, zoneID: null, accountID: null, dismissed: false,
};

const NAMED: ResolvedTunnelConfig = {
  mode: "named", hostname: "ppm.hienle.tech", tunnelName: "ppm-host", token: "super-secret-run-token",
  zoneID: "a".repeat(32), accountID: "b".repeat(32), dismissed: false,
};

describe("buildTunnelAttempts — spawnTunnel's actual call site", () => {
  test("quick-only config produces exactly one quick attempt, argv byte-identical to getQuickTunnelArgs", () => {
    const attempts = buildTunnelAttempts(QUICK, TEST_PORT);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.mode).toBe("quick");
    expect(attempts[0]!.args).toEqual(getQuickTunnelArgs(TEST_PORT));
    expect(attempts[0]!.urlFrom).toBe("regex");
  });

  test("named config produces named-first, quick-fallback-second — quick argv still byte-identical", () => {
    const attempts = buildTunnelAttempts(NAMED, TEST_PORT);
    expect(attempts).toHaveLength(2);

    expect(attempts[0]!.mode).toBe("named");
    expect(attempts[0]!.urlFrom).toBe("hostname");
    expect(attempts[0]!.args).not.toContain(NAMED.token);
    expect(attempts[0]!.args).toContain("--token-file");
    expect(attempts[0]!.regex.test("Registered tunnel connection")).toBe(true);

    expect(attempts[1]!.mode).toBe("quick");
    expect(attempts[1]!.urlFrom).toBe("regex");
    expect(attempts[1]!.args).toEqual(getQuickTunnelArgs(TEST_PORT));
  });

  test("named config with an empty token degrades to quick-only (defensive — resolveTunnelConfig already guarantees this can't happen)", () => {
    const attempts = buildTunnelAttempts({ ...NAMED, token: null }, TEST_PORT);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.mode).toBe("quick");
    expect(attempts[0]!.args).toEqual(getQuickTunnelArgs(TEST_PORT));
  });
});

describe("orphanedTunnelPgrepPattern — reapOrphanedTunnels' match set", () => {
  const bin = "/home/x/.ppm/bin/cloudflared";
  // POSIX ERE `(a|b)` alternation with no other metacharacters behaves
  // identically to a JS RegExp here — safe to reuse for a fast, pgrep-free unit test.
  const pattern = new RegExp(orphanedTunnelPgrepPattern(bin));

  test("matches the long-lived quick connector", () => {
    expect(pattern.test(`${bin} --config /x/cloudflared-quick.yml tunnel --url http://127.0.0.1:8080`)).toBe(true);
  });

  test("matches the long-lived named connector", () => {
    expect(pattern.test(`${bin} --origincert /x/cert.pem --config /x/cloudflared-named.yml tunnel run --token-file /x/named-tunnel.token --url http://127.0.0.1:8080`)).toBe(true);
  });

  test("does NOT match short-lived management subcommands", () => {
    for (const sub of ["login", "create ppm-host", "route dns ppm-host ppm.hienle.tech", "token ppm-host"]) {
      expect(pattern.test(`${bin} --origincert /x/cert.pem tunnel ${sub}`)).toBe(false);
    }
  });

  test("does not match an unrelated process merely containing the word tunnel", () => {
    expect(pattern.test("/usr/bin/some-other-tool --tunnel run")).toBe(false);
  });
});

describe("tunnelWarningPatchForSpawnSuccess — spawnTunnel's success-write decision (R4)", () => {
  test("downgraded (named failed this attempt, quick fell back) always writes the downgrade warning", () => {
    expect(tunnelWarningPatchForSpawnSuccess("quick", true)).toEqual({
      tunnelWarning: "Named tunnel failed to start — using a temporary quick URL",
    });
  });

  test("quick success with no downgrade clears any leftover warning — deliberate config-is-quick case (retunnel-to-quick, cold boot, later regen)", () => {
    expect(tunnelWarningPatchForSpawnSuccess("quick", false)).toEqual({ tunnelWarning: null });
  });

  test("plain named success (no downgrade) never touches the warning — clearing a named warning is the probe's job alone", () => {
    expect(tunnelWarningPatchForSpawnSuccess("named", false)).toEqual({});
  });
});
