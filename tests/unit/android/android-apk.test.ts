/**
 * Reading adb's answer, and the project APK walk.
 *
 * The install path is not unit-testable end to end — it needs a device — but the two decisions
 * that decide what a person sees are pure: whether adb said yes, and why it said no. Both have
 * to survive adb's habit of exiting 0 on a failed install.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  explainInstallOutput, findProjectApks, installApk, INSTALL_DEADLINE_MS, MAX_APK_BYTES, MAX_STAGING_BYTES,
} from "../../../src/services/android/android-apk.ts";

describe("explainInstallOutput", () => {
  it("believes `Success` over the exit code", () => {
    // Several adb versions exit non-zero on a perfectly good install, and vice versa.
    expect(explainInstallOutput("Performing Streamed Install\nSuccess", 1).ok).toBe(true);
  });

  it("does not mistake the word Success inside a message for the verdict", () => {
    const got = explainInstallOutput("adb: failed to install a.apk: Failure [INSTALL_FAILED_INVALID_APK: Success is not here]", 1);
    expect(got.ok).toBe(false);
    expect(got.code).toBe("INSTALL_FAILED_INVALID_APK");
  });

  it("explains the codes a person can act on", () => {
    const abi = explainInstallOutput("Failure [INSTALL_FAILED_NO_MATCHING_ABIS]", 1);
    expect(abi.ok).toBe(false);
    expect(abi.code).toBe("INSTALL_FAILED_NO_MATCHING_ABIS");
    expect(abi.message).toContain("x86_64");

    const sdk = explainInstallOutput("Failure [INSTALL_FAILED_OLDER_SDK]", 1);
    expect(sdk.message).toContain("API level");

    const sig = explainInstallOutput("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]", 1);
    expect(sig.message).toContain("different key");
  });

  it("passes an unknown code through rather than flattening it", () => {
    const got = explainInstallOutput("Failure [INSTALL_FAILED_SOMETHING_NOBODY_HAS_SEEN]", 1);
    expect(got.ok).toBe(false);
    expect(got.code).toBe("INSTALL_FAILED_SOMETHING_NOBODY_HAS_SEEN");
    expect(got.message).toContain("INSTALL_FAILED_SOMETHING_NOBODY_HAS_SEEN");
  });

  it("names a device that is not there", () => {
    expect(explainInstallOutput("adb: device offline", 1).code).toBe("device offline");
  });

  it("treats a bare exit 0 with no output as success", () => {
    expect(explainInstallOutput("", 0).ok).toBe(true);
  });

  it("reports a non-zero exit with no recognised code verbatim", () => {
    const got = explainInstallOutput("adb: usage: something went sideways", 1);
    expect(got.ok).toBe(false);
    expect(got.message).toBe("adb: usage: something went sideways");
  });
});

describe("findProjectApks", () => {
  it("finds build outputs and prunes the heavy directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "ppm-apk-walk-"));
    try {
      const debug = join(root, "app", "build", "outputs", "apk", "debug");
      mkdirSync(debug, { recursive: true });
      mkdirSync(join(root, "node_modules", "some-pkg"), { recursive: true });
      mkdirSync(join(root, ".git", "objects"), { recursive: true });
      writeFileSync(join(debug, "app-debug.apk"), "PK");
      writeFileSync(join(root, "node_modules", "some-pkg", "fixture.apk"), "PK");
      writeFileSync(join(root, ".git", "objects", "weird.apk"), "PK");
      writeFileSync(join(root, "notes.txt"), "not an apk");

      const found = await findProjectApks(root);
      expect(found.map((f) => f.path)).toEqual(["app/build/outputs/apk/debug/app-debug.apk"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sorts newest first, because that is the build the user just ran", async () => {
    const root = mkdtempSync(join(tmpdir(), "ppm-apk-sort-"));
    try {
      writeFileSync(join(root, "old.apk"), "PK");
      await Bun.sleep(20);
      writeFileSync(join(root, "new.apk"), "PK");
      const found = await findProjectApks(root);
      expect(found[0]!.path).toBe("new.apk");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers for a directory that does not exist", async () => {
    expect(await findProjectApks(join(tmpdir(), "ppm-definitely-not-here"))).toEqual([]);
  });
});

describe("limits", () => {
  it("caps an APK at 2 GB", () => {
    expect(MAX_APK_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});

/**
 * The stand-in for a hung adb is a shell script, and Windows has no /bin/sh to run it. What the
 * two tests using it pin — a deadline timer and an AbortSignal raced against one Bun.spawn — has
 * no platform branch in `installApk`.
 */
const CAN_RUN_SH_STAND_IN = process.platform !== "win32";

describe("staging quota and install deadline", () => {
  it("bounds one upload and the directory as a whole", () => {
    // Two separate limits on purpose: `MAX_APK_BYTES` stops one absurd file, `MAX_STAGING_BYTES`
    // stops several legal ones together filling the disk the database lives on.
    expect(MAX_STAGING_BYTES).toBeGreaterThan(MAX_APK_BYTES);
  });

  it("gives an install a deadline rather than letting it hang forever", () => {
    // adb against a half-wedged emulator hangs rather than erroring, and an operation stuck at
    // "running" has no way out but a PPM restart.
    expect(INSTALL_DEADLINE_MS).toBeGreaterThan(60_000);
    expect(INSTALL_DEADLINE_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it.skipIf(!CAN_RUN_SH_STAND_IN)("kills an install that runs past its deadline and says so", async () => {
    // A stand-in for adb that ignores its arguments and hangs, which is exactly what adb does
    // against a half-wedged emulator — the case the deadline exists for.
    const dir = mkdtempSync(join(tmpdir(), "ppm-deadline-"));
    const fakeAdb = join(dir, "adb");
    const apk = join(dir, "app.apk");
    writeFileSync(fakeAdb, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    writeFileSync(apk, "PK");
    try {
      const started = Date.now();
      const result = await installApk({ adbPath: fakeAdb, serial: "emulator-5554", apkPath: apk, deadlineMs: 400 });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("did not finish");
      // It must actually be killed, not merely reported: a 30s sleep left running would hold a
      // pipe open and the whole thing would still be here when the suite ends.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cancelling an install", () => {
  it.skipIf(!CAN_RUN_SH_STAND_IN)("returns promptly even when killing adb does not close its pipes", async () => {
    // The same hazard as the deadline: a child holding the inherited pipe means the read never
    // ends, so a cancel that waited for it would hang until the 10-minute deadline instead.
    const dir = mkdtempSync(join(tmpdir(), "ppm-cancel-"));
    const fakeAdb = join(dir, "adb");
    const apk = join(dir, "app.apk");
    writeFileSync(fakeAdb, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    writeFileSync(apk, "PK");
    const controller = new AbortController();
    try {
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      const result = await installApk({
        adbPath: fakeAdb, serial: "emulator-5554", apkPath: apk, signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("cancelled");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses immediately when the signal is already aborted, without starting adb", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ppm-precancel-"));
    const apk = join(dir, "app.apk");
    writeFileSync(apk, "PK");
    try {
      // Nothing exists at this path: had adb been started, the answer would be "could not run adb".
      const result = await installApk({
        adbPath: join(dir, "no-such-adb"), serial: "emulator-5554", apkPath: apk,
        signal: AbortSignal.abort(),
      });
      expect(result.message).toBe("cancelled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
