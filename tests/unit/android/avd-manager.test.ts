/**
 * The pure half of AVD create/wipe: name rules, `avdmanager list device` parsing, the config
 * rewrite, and the wipe allowlist.
 *
 * Nothing here runs an SDK tool: where their output is under test, a bun child prints it. The
 * parts that need the real tools are covered by `tests/e2e/android-avd-crud-e2e.ts`, which
 * creates a throwaway AVD in its own AVD home and boots it — a wipe that keeps the wrong file is
 * only visible on the *next* boot.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AVD_LIMITS, _resetProfileCache, applyPpmDefaults, deleteAvd, listDeviceProfiles, parseDeviceProfiles,
  validateAvdName, wipeAvdData, writeConfigKeys,
} from "../../../src/services/android/avd-manager.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ppm-avd-"));

describe("validateAvdName", () => {
  test("accepts what avdmanager takes without quoting", () => {
    for (const name of ["Pixel_9", "a", "a.b-c_1", "API35", "x".repeat(63)]) {
      expect(validateAvdName(name)).toBeNull();
    }
  });

  test("refuses anything that would need quoting or escaping", () => {
    // Each of these becomes a directory name and part of an argv element; the rule is to refuse
    // rather than to escape, so a shell-ish name never reaches a tool in the first place.
    for (const name of ["", "has space", "-leading", ".leading", "semi;colon", "quo'te",
                        "sla/sh", "back\\slash", "$(whoami)", "..", "x".repeat(64)]) {
      expect(validateAvdName(name)).toBeString();
    }
  });
});

describe("parseDeviceProfiles", () => {
  // Real shape, trimmed: `Tag :` is present on some entries and absent on every Pixel.
  const OUTPUT = `Available devices definitions:
id: 0 or "automotive_1024p_landscape"
    Name: Automotive (1024p landscape)
    OEM : Google
    Tag : android-automotive
---------
id: 46 or "pixel_9"
    Name: Pixel 9
    OEM : Google
---------
id: 12 or "medium_tablet"
    Name: Medium Tablet
    OEM : Generic
---------
id: 9 or "wearos_small_round"
    Name: Wear OS Small Round
    OEM : Google
    Tag : android-wear
---------
`;

  test("reads every entry, with or without a Tag line", () => {
    const profiles = parseDeviceProfiles(OUTPUT);
    expect(profiles.map((p) => p.id)).toEqual([
      "automotive_1024p_landscape", "pixel_9", "medium_tablet", "wearos_small_round",
    ]);
  });

  test("a profile with no Tag keeps its name and oem", () => {
    const pixel = parseDeviceProfiles(OUTPUT).find((p) => p.id === "pixel_9")!;
    expect(pixel.name).toBe("Pixel 9");
    expect(pixel.oem).toBe("Google");
    expect(pixel.tag).toBeNull();
  });

  test("classifies enough to group the picker", () => {
    const byId = new Map(parseDeviceProfiles(OUTPUT).map((p) => [p.id, p.kind]));
    expect(byId.get("pixel_9")).toBe("phone");
    expect(byId.get("medium_tablet")).toBe("tablet");
    expect(byId.get("wearos_small_round")).toBe("wear");
    expect(byId.get("automotive_1024p_landscape")).toBe("automotive");
  });

  test("empty or unparseable output is no profiles, not a throw", () => {
    expect(parseDeviceProfiles("")).toEqual([]);
    expect(parseDeviceProfiles("Error: something went wrong\n")).toEqual([]);
  });
});

/**
 * The SDK's Java tools end every line with CRLF on Windows, and the progress-bar strip used to run
 * first and take each of those lines for a frame of the bar: the New-device dialog listed no
 * profiles there, and a failed create or delete said nothing. The "tool" is a bun child printing a
 * Windows-shaped answer, started through the module's own `Bun.spawn`, so this runs on every OS.
 */
describe("SDK tool output with CRLF line endings", () => {
  function toolPrints(stdout: string, stderr = "", exitCode = 0) {
    const spawn = Bun.spawn.bind(Bun);
    const script = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`;
    return spyOn(Bun, "spawn").mockImplementation(
      ((_argv: string[], opts: object) => spawn([process.execPath, "-e", script], opts)) as never,
    );
  }

  test("a device listing still lists its profiles", async () => {
    const spy = toolPrints('Available devices definitions:\r\nid: 0 or "pixel_9"\r\n    Name: Pixel 9\r\n    OEM : Google\r\n---------\r\n');
    _resetProfileCache();
    try {
      expect((await listDeviceProfiles("avdmanager")).map((p) => p.id)).toEqual(["pixel_9"]);
      expect(spy.mock.calls[0]?.[0]).toEqual(["avdmanager", "list", "device"]);
    } finally {
      spy.mockRestore();
      _resetProfileCache();
    }
  });

  test("a failed delete keeps its error line, and the progress bar only its last frame", async () => {
    const spy = toolPrints("", "[=      ] 10% Loading\r[=======] 100% Done\r\nError: There is no Android Virtual Device named 'Pixel_9'.\r\n", 1);
    try {
      const result = await deleteAvd("avdmanager", "Pixel_9", tmp());
      expect(result.ok).toBe(false);
      expect(result.message).toBe("Error: There is no Android Virtual Device named 'Pixel_9'.");
      expect(result.output).toBe("[=======] 100% Done\nError: There is no Android Virtual Device named 'Pixel_9'.");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("writeConfigKeys", () => {
  test("replaces a key in place and leaves every other line alone", () => {
    const dir = tmp();
    const path = join(dir, "config.ini");
    writeFileSync(path, "AvdId=x\nhw.keyboard=no\nsomething.we.do.not.know=42\n");
    writeConfigKeys(path, { "hw.keyboard": "yes" });

    expect(readFileSync(path, "utf8")).toBe("AvdId=x\nhw.keyboard=yes\nsomething.we.do.not.know=42\n");
  });

  test("appends a key the file does not have, rather than duplicating one it does", () => {
    const dir = tmp();
    const path = join(dir, "config.ini");
    writeFileSync(path, "hw.ramSize=1536M\n");
    writeConfigKeys(path, { "hw.ramSize": "2048M", "hw.screen": "multi-touch" });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toEqual(["hw.ramSize=2048M", "hw.screen=multi-touch"]);
    expect(lines.filter((l) => l.startsWith("hw.ramSize=")).length).toBe(1);
  });

  test("a missing file is a no-op, not a throw", () => {
    expect(() => writeConfigKeys(join(tmp(), "nope.ini"), { a: "b" })).not.toThrow();
  });
});

describe("applyPpmDefaults", () => {
  test("always writes hw.keyboard=yes", () => {
    // With `hw.keyboard=no` the gRPC key path returns OK and nothing reaches the guest, so this
    // is the one setting a created AVD cannot be allowed to miss.
    const dir = tmp();
    const path = join(dir, "config.ini");
    writeFileSync(path, "hw.keyboard=no\n");
    applyPpmDefaults(path, { ramMb: 2048, storageMb: 6144 });

    expect(readFileSync(path, "utf8")).toContain("hw.keyboard=yes");
    expect(readFileSync(path, "utf8")).not.toContain("hw.keyboard=no");
  });

  test("writes RAM and storage in the megabyte form the emulator expects", () => {
    const dir = tmp();
    const path = join(dir, "config.ini");
    writeFileSync(path, "AvdId=x\n");
    applyPpmDefaults(path, { ramMb: 3072, storageMb: 8192 });

    const text = readFileSync(path, "utf8");
    expect(text).toContain("hw.ramSize=3072M");
    expect(text).toContain("disk.dataPartition.size=8192M");
    expect(text).toContain("hw.screen=multi-touch");
  });
});

describe("AVD_LIMITS", () => {
  test("every default sits inside its own bounds", () => {
    for (const bounds of Object.values(AVD_LIMITS)) {
      expect(bounds.default).toBeGreaterThanOrEqual(bounds.min);
      expect(bounds.default).toBeLessThanOrEqual(bounds.max);
    }
  });
});

describe("wipeAvdData", () => {
  /** A directory shaped like an AVD that has been booted at least once. */
  function fakeAvd(extra: string[] = []): string {
    const dir = join(tmp(), "Test.avd");
    mkdirSync(dir, { recursive: true });
    for (const name of ["config.ini", "userdata-qemu.img", "cache.img", "sdcard.img",
                        "hardware-qemu.ini", "emu-launch-params.txt", ...extra]) {
      writeFileSync(join(dir, name), "x".repeat(10));
    }
    mkdirSync(join(dir, "snapshots", "default_boot"), { recursive: true });
    writeFileSync(join(dir, "snapshots", "default_boot", "ram.bin"), "y".repeat(100));
    return dir;
  }

  test("removes the runtime state and reports exactly what went", () => {
    const dir = fakeAvd();
    const outcome = wipeAvdData(dir);

    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toContain("userdata-qemu.img");
    expect(outcome.removed).toContain("snapshots/");
    expect(existsSync(join(dir, "userdata-qemu.img"))).toBe(false);
    expect(existsSync(join(dir, "snapshots"))).toBe(false);
    // 5 files of 10 bytes + the 100-byte snapshot; config.ini is not counted because it stays.
    expect(outcome.freedBytes).toBe(150);
  });

  test("keeps the AVD's definition — a wipe is not a delete", () => {
    const dir = fakeAvd();
    wipeAvdData(dir);
    expect(existsSync(join(dir, "config.ini"))).toBe(true);
  });

  test("keeps the factory userdata.img, or the AVD never boots again", () => {
    // Measured: `userdata.img` is the pristine copy `avdmanager` puts in the AVD directory, and
    // the emulator rebuilds `userdata-qemu.img` from it. Delete it and the next boot has nothing
    // to build from — the AVD is bricked, silently, until someone recreates it.
    const dir = fakeAvd(["userdata.img"]);
    wipeAvdData(dir);
    expect(existsSync(join(dir, "userdata.img"))).toBe(true);
    expect(wipeAvdData(dir).removed).not.toContain("userdata.img");
  });

  test("is an allowlist: a file it has never heard of survives", () => {
    const dir = fakeAvd(["something-a-future-emulator-wrote.bin"]);
    wipeAvdData(dir);
    expect(existsSync(join(dir, "something-a-future-emulator-wrote.bin"))).toBe(true);
  });

  test("refuses a directory that is not an AVD", () => {
    const dir = tmp();
    writeFileSync(join(dir, "userdata-qemu.img"), "x");
    const outcome = wipeAvdData(dir);

    expect(outcome.ok).toBe(false);
    expect(outcome.removed).toEqual([]);
    expect(existsSync(join(dir, "userdata-qemu.img"))).toBe(true);
  });

  test("wiping twice is not an error, and the second says so", () => {
    const dir = fakeAvd();
    wipeAvdData(dir);
    const again = wipeAvdData(dir);
    expect(again.ok).toBe(true);
    expect(again.removed).toEqual([]);
    expect(again.message).toContain("nothing");
  });
});
