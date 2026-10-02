/**
 * The lock a stopped emulator leaves behind must not be read as "in use".
 *
 * Measured on a real emulator: `multiinstance.lock` is a zero-byte marker that survives a clean
 * shutdown, while `hardware-qemu.ini.lock` holds the live emulator's pid. Treating file presence
 * as the signal refused every start after the first — this pins the distinction.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAvds } from "../../../src/services/android/avd-list.ts";

let home: string;

function makeAvd(name: string, config: Record<string, string> = {}): string {
  const dir = join(home, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  const base: Record<string, string> = {
    AvdId: name,
    "abi.type": "x86_64",
    "hw.lcd.width": "1080",
    "hw.lcd.height": "2400",
    "hw.keyboard": "yes",
    "image.sysdir.1": "system-images/android-35/google_apis/x86_64/",
    ...config,
  };
  writeFileSync(join(dir, "config.ini"), Object.entries(base).map(([k, v]) => `${k}=${v}`).join("\n"));
  return dir;
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ppm-avd-test-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("AVD lock detection", () => {
  it("does not treat a leftover multiinstance.lock as a live lock", () => {
    const dir = makeAvd("left_over");
    // Exactly what a cleanly stopped emulator leaves behind.
    writeFileSync(join(dir, "multiinstance.lock"), "");
    expect(listAvds(home)[0]!.lockedByAnotherProcess).toBe(false);
  });

  it("reports a lock whose pid is alive", () => {
    const dir = makeAvd("in_use");
    // This test process is certainly alive, so it stands in for the emulator.
    writeFileSync(join(dir, "hardware-qemu.ini.lock"), `${process.pid} `);
    expect(listAvds(home)[0]!.lockedByAnotherProcess).toBe(true);
  });

  it("reports a lock written the way the emulator really writes it", () => {
    // Byte for byte what a running emulator leaves: the pid, then a NUL. `trim()` does not
    // remove a NUL, so reading this with `Number()` gives NaN and the AVD looks free — which is
    // how this went unnoticed while a test using a trailing *space* passed.
    const dir = makeAvd("nul_terminated");
    writeFileSync(join(dir, "hardware-qemu.ini.lock"), `${process.pid}\0`);
    expect(listAvds(home)[0]!.lockedByAnotherProcess).toBe(true);
  });

  it("ignores a lock whose pid is dead", () => {
    const dir = makeAvd("stale");
    // A pid that cannot exist: the kernel's maximum is far below this on every supported host.
    writeFileSync(join(dir, "hardware-qemu.ini.lock"), "2147483600");
    expect(listAvds(home)[0]!.lockedByAnotherProcess).toBe(false);
  });

  it("ignores an unparseable lock rather than throwing", () => {
    const dir = makeAvd("garbage");
    writeFileSync(join(dir, "hardware-qemu.ini.lock"), "not a pid");
    expect(listAvds(home)[0]!.lockedByAnotherProcess).toBe(false);
  });
});

describe("AVD summary", () => {
  it("reads the API level from image.sysdir.1 when target is absent", () => {
    makeAvd("no_target");
    expect(listAvds(home)[0]!.apiLevel).toBe(35);
  });

  it("reports hw.keyboard=no, which avdmanager writes by default and which silently kills input", () => {
    makeAvd("no_kbd", { "hw.keyboard": "no" });
    expect(listAvds(home)[0]!.hardwareKeyboard).toBe(false);
  });

  it("gives two AVDs in different homes different ids", () => {
    const a = makeAvd("same_name");
    const otherHome = mkdtempSync(join(tmpdir(), "ppm-avd-test2-"));
    try {
      mkdirSync(join(otherHome, "same_name.avd"), { recursive: true });
      writeFileSync(join(otherHome, "same_name.avd", "config.ini"), "AvdId=same_name");
      const idA = listAvds(home)[0]!.avdId;
      const idB = listAvds(otherHome)[0]!.avdId;
      expect(a).toBeTruthy();
      expect(idA).not.toBe(idB);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
