/**
 * The production-database gatekeeper. These assertions are the reason an ad-hoc
 * script can no longer reach `~/.ppm/ppm.db`, so they are deliberately explicit
 * about which entrypoints stay allowed.
 *
 * Every case builds its own context rather than mutating process.env/argv: the
 * suite shares one process, and a test that unsets PPM_HOME would expose the
 * real ~/.ppm to whatever runs next.
 */
import { describe, it, expect } from "bun:test";
import { sep } from "node:path";
import { assistantShellEnv } from "../../../src/services/assistant/assistant-shell-env.ts";
import {
  isAllowedProdDbEntrypoint,
  LIVE_PPM_HOME_ENV,
  PROD_DB_OVERRIDE_ENV,
  type ProdDbGuardContext,
} from "../../../src/services/prod-db-guard.ts";

/** A process with nothing but its entry script to vouch for it. */
function ctx(entry: string, extra: Partial<ProdDbGuardContext> = {}): ProdDbGuardContext {
  return {
    ppmHome: undefined,
    override: undefined,
    execPath: "/home/u/.bun/bin/bun",
    entry,
    ...extra,
  };
}

describe("prod DB guard", () => {
  it("allows the real entrypoints", () => {
    for (const entry of [
      "/home/u/.bun/install/global/pkg/@hienlh/ppm/src/index.ts",
      "/home/u/ppm/src/server/index.ts",
      "/home/u/ppm/src/services/supervisor.ts",
      "/home/u/ppm/src/services/edge-forwarder.ts",
    ]) {
      expect(isAllowedProdDbEntrypoint(ctx(entry))).toBe(true);
    }
  });

  it("allows an entrypoint reached through a native path", () => {
    const native = ["", "home", "u", "ppm", "src", "server", "index.ts"].join(sep);
    expect(isAllowedProdDbEntrypoint(ctx(native))).toBe(true);
  });

  it("allows an entrypoint inside an agent worktree", () => {
    expect(
      isAllowedProdDbEntrypoint(ctx("/home/u/ppm/.claude/worktrees/agent-abc/src/server/index.ts")),
    ).toBe(true);
  });

  it("allows a compiled binary, whose entry is not a source path", () => {
    expect(isAllowedProdDbEntrypoint(ctx("/opt/ppm/ppm", { execPath: "/opt/ppm/ppm" }))).toBe(true);
  });

  it("blocks ad-hoc scripts, including ones sitting in the repo", () => {
    for (const entry of [
      "/home/u/ppm/probe-proxy.ts",
      "/home/u/ppm/spike-something.mjs",
      "/tmp/throwaway.ts",
      "/home/u/ppm/src/services/proxy.service.ts", // imported, never an entrypoint
      "[eval]", // bun -e
    ]) {
      expect(isAllowedProdDbEntrypoint(ctx(entry))).toBe(false);
    }
  });

  it("blocks a test file", () => {
    expect(
      isAllowedProdDbEntrypoint(ctx("/home/u/ppm/tests/unit/services/whatever.test.ts")),
    ).toBe(false);
  });

  it("does not match a suffix that is only a partial path segment", () => {
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/vendor-src/index.ts"))).toBe(false);
  });

  it("stands down once PPM_HOME isolates the caller", () => {
    expect(
      isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", { ppmHome: "/tmp/scratch-ppm" })),
    ).toBe(true);
  });

  it("does not take a PPM_HOME naming the real folder as isolation", () => {
    // Every shell a production Assistant session runs has PPM_HOME set exactly so.
    const realPpmDir = "/home/u/.ppm";
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", { ppmHome: "/home/u/.ppm", realPpmDir }))).toBe(false);
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", { ppmHome: "/home/u/.ppm/", realPpmDir }))).toBe(false);
    // The CLI itself still reaches it from there.
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/src/index.ts", { ppmHome: "/home/u/.ppm", realPpmDir }))).toBe(true);
  });

  it("does not take the folder of the instance whose shell this is as isolation, wherever it lives", () => {
    // A production instance run with PPM_HOME=/srv/ppm: its Assistant shells carry both.
    const shell = { ppmHome: "/srv/ppm", liveHome: "/srv/ppm", realPpmDir: "/home/u/.ppm" };
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", shell))).toBe(false);
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/src/index.ts", shell))).toBe(true);
    expect(isAllowedProdDbEntrypoint(ctx("/opt/ppm/ppm", { ...shell, execPath: "/opt/ppm/ppm" }))).toBe(true);
    // A scratch folder set over it from that shell still isolates.
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", { ...shell, ppmHome: "/tmp/scratch" }))).toBe(true);
  });

  it("is what an Assistant shell is given", () => {
    const env = assistantShellEnv();
    expect(env[LIVE_PPM_HOME_ENV]).toBe(env.PPM_HOME);
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", { ppmHome: env.PPM_HOME, liveHome: env[LIVE_PPM_HOME_ENV] }))).toBe(false);
  });

  it("honours the explicit override", () => {
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", { override: "1" }))).toBe(true);
  });

  it("ignores an override set to anything other than 1", () => {
    expect(isAllowedProdDbEntrypoint(ctx("/home/u/ppm/probe.ts", { override: "true" }))).toBe(false);
  });
});
