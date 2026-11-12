/**
 * `ppm --profile x <command>`: read only before the first subcommand, so `start --profile dev`
 * keeps its own option, and a value that merely looks like the flag after the command is left
 * alone. PPM_PROFILE applies when no flag is given, an empty value meaning the default.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  commandProfile, extractProfileArgv, isValidProfileName, resolveCliProfile,
} from "../../../src/cli/utils/profile-argv.ts";
import { supervisedProfileRefusal } from "../../../src/cli/utils/supervised-profile-check.ts";

const argv = (...rest: string[]) => ["bun", "ppm", ...rest];

describe("extractProfileArgv", () => {
  it("takes --profile x and --profile=x out from before the command", () => {
    expect(extractProfileArgv(argv("--profile", "dev", "config", "get", "port"))).toEqual({ argv: argv("config", "get", "port"), profile: "dev" });
    expect(extractProfileArgv(argv("--profile=dev", "status"))).toEqual({ argv: argv("status"), profile: "dev" });
  });

  it("leaves start --profile dev to the start command, so it reaches the supervisor's arguments", () => {
    const scan = extractProfileArgv(argv("start", "--profile", "dev"));
    expect(scan.profile).toBeUndefined();
    expect(scan.argv).toEqual(argv("start", "--profile", "dev"));
  });

  it("ignores a --profile=x value after the command", () => {
    const scan = extractProfileArgv(argv("chat", "send", "--message", "--profile=x"));
    expect(scan.profile).toBeUndefined();
    expect(scan.argv).toEqual(argv("chat", "send", "--message", "--profile=x"));
  });

  it("stops at --, keeps other leading options, and reads --instance", () => {
    expect(extractProfileArgv(argv("--", "--profile", "dev")).profile).toBeUndefined();
    expect(extractProfileArgv(argv("--version"))).toEqual({ argv: argv("--version") });
    expect(extractProfileArgv(argv("--instance", "4242", "projects", "list"))).toEqual({ argv: argv("projects", "list"), instance: "4242" });
  });

  it("refuses a flag with no value", () => {
    expect(() => extractProfileArgv(argv("--profile"))).toThrow("needs a value");
    expect(() => extractProfileArgv(argv("--profile", "--instance", "1", "status"))).toThrow("needs a value");
  });
});

describe("resolveCliProfile", () => {
  it("prefers the flag, then PPM_PROFILE; empty or 'default' means ppm.db", () => {
    expect(resolveCliProfile("dev", { PPM_PROFILE: "other" })).toBe("dev");
    expect(resolveCliProfile(undefined, { PPM_PROFILE: "other" })).toBe("other");
    expect(resolveCliProfile(undefined, { PPM_PROFILE: "" })).toBeNull();
    expect(resolveCliProfile(undefined, {})).toBeNull();
    expect(resolveCliProfile("default", {})).toBeNull();
  });

  it("accepts the existing dev profile and refuses names that could leave the folder", () => {
    expect(isValidProfileName("dev")).toBe(true);
    expect(isValidProfileName("feat.x-1_b")).toBe(true);
    for (const bad of ["", "../x", "a..b", ".hidden", "a/b", "a b", "x".repeat(33)]) {
      expect({ bad, ok: isValidProfileName(bad) }).toEqual({ bad, ok: false });
    }
    expect(() => resolveCliProfile("../prod", {})).toThrow("Invalid profile name");
  });
});

describe("commandProfile (start / autostart enable)", () => {
  it("falls back to the profile chosen before the command, and refuses two different ones", () => {
    expect(commandProfile(undefined, "dev")).toBe("dev");
    expect(commandProfile("dev", null)).toBe("dev");
    expect(commandProfile("dev", "dev")).toBe("dev");
    expect(() => commandProfile("dev", "other")).toThrow("Two profiles were given");
  });
});

describe("process commands on a profile", () => {
  it("act on the supervisor only when it serves that profile", () => {
    const alive = process.pid;
    expect(supervisedProfileRefusal(null, {})).toBeNull();
    expect(supervisedProfileRefusal("dev", { supervisorPid: alive, profile: "dev" })).toBeNull();
    expect(supervisedProfileRefusal("dev", { supervisorPid: alive })).toContain("not supervisor-managed");
    expect(supervisedProfileRefusal("dev", { supervisorPid: alive, profile: "other" })).toContain("ppm.dev.db");
    expect(supervisedProfileRefusal("dev", {})).toContain("stop it where it runs");
  });
});
