import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import {
  ensureNamedTunnelConfig, writeNamedTunnelToken, namedRunArgs, createTunnelArgs,
  routeDnsArgs, loginArgs, tunnelNameForHost,
} from "../../../../src/services/named-tunnel/named-tunnel-args.ts";

// Port literal kept outside the Hyper-V reserved range (44620-48715).
const TEST_PORT = 39877;
const isPosix = process.platform !== "win32";

// Restore, never delete: the bunfig preload's PPM_HOME shields later test
// files in this process from the real ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;

describe("named-tunnel-args", () => {
  let ppmHome: string;

  beforeEach(() => {
    ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-nt-args-"));
    process.env.PPM_HOME = ppmHome;
    _resetPpmDir();
  });

  afterEach(() => {
    if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
    else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
    _resetPpmDir();
    rmSync(ppmHome, { recursive: true, force: true });
  });

  test("ensureNamedTunnelConfig creates a non-comment-only file idempotently", () => {
    const path1 = ensureNamedTunnelConfig();
    expect(existsSync(path1)).toBe(true);
    const body = readFileSync(path1, "utf-8");
    expect(body.replace(/#.*/g, "").trim()).not.toBe(""); // real key present, never comment-only
    const path2 = ensureNamedTunnelConfig();
    expect(path2).toBe(path1);
  });

  test("writeNamedTunnelToken writes a 0600 file containing the token", () => {
    const path = writeNamedTunnelToken("fake-run-token");
    expect(readFileSync(path, "utf-8")).toBe("fake-run-token");
    if (isPosix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("namedRunArgs never contains the token literal, only --token-file", () => {
    const token = "super-secret-run-token";
    const args = namedRunArgs(token, TEST_PORT);
    expect(args).not.toContain(token);
    expect(args).not.toContain("--token");
    expect(args).toContain("--token-file");
    const idx = args.indexOf("--token-file");
    const tokenPath = args[idx + 1]!;
    expect(readFileSync(tokenPath, "utf-8")).toBe(token);
    if (isPosix) expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(args).toEqual(expect.arrayContaining(["--url", `http://127.0.0.1:${TEST_PORT}`]));
  });

  test("management argv puts --origincert/--config before the subcommand", () => {
    const args = createTunnelArgs("ppm-host");
    expect(args[0]).toBe("--origincert");
    expect(args[2]).toBe("--config");
    expect(args.indexOf("--origincert")).toBeLessThan(args.indexOf("tunnel"));
    expect(args.indexOf("--config")).toBeLessThan(args.indexOf("tunnel"));
    expect(args.slice(-2)).toEqual(["create", "ppm-host"]);
  });

  test("routeDnsArgs appends --overwrite-dns only when requested", () => {
    const withOverwrite = routeDnsArgs("ppm-host", "ppm.hienle.tech", true);
    expect(withOverwrite).toContain("--overwrite-dns");
    const without = routeDnsArgs("ppm-host", "ppm.hienle.tech", false);
    expect(without).not.toContain("--overwrite-dns");
    expect(without.slice(-2)).toEqual(["ppm-host", "ppm.hienle.tech"]);
  });

  test("loginArgs never passes --origincert (no cert yet)", () => {
    expect(loginArgs()).toEqual(["tunnel", "login"]);
  });

  test("tunnelNameForHost is DNS-safe and bounded to 32 chars", () => {
    const name = tunnelNameForHost();
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toMatch(/^ppm-[a-z0-9-]+$/);
  });

  test("a non-default PPM_HOME gets its own tunnel name", () => {
    // Two PPM installations on one machine must never derive the same name, or
    // the second registers a connector on the first one's tunnel and the
    // production hostname starts answering from the wrong instance.
    const previous = process.env.PPM_HOME;
    try {
      process.env.PPM_HOME = resolve(tmpdir(), ".ppm-nt-test");
      _resetPpmDir();
      const isolated = tunnelNameForHost();
      expect(isolated).toMatch(/-ppm-nt-test$/);
      expect(isolated.length).toBeLessThanOrEqual(32);
      expect(isolated).toMatch(/^ppm-[a-z0-9-]+$/);
    } finally {
      if (previous === undefined) delete process.env.PPM_HOME; else process.env.PPM_HOME = previous;
      _resetPpmDir();
    }
  });
});
