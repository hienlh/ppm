/**
 * Android emulator support is off by default, and the nav rail and the mobile drawer ask for its
 * capabilities on every page load to decide whether to show the entry at all. Answering that by
 * discovering the SDK ran `emulator` twice, `adb` and two JVMs per page load on any host that
 * merely has an SDK installed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidCapabilities } from "../../../src/services/android/android-capabilities.ts";

let sdk: string;
let savedAndroidHome: string | undefined;

beforeEach(() => {
  // An SDK root discovery would find, holding tools it would then try to run.
  sdk = mkdtempSync(join(tmpdir(), "ppm-caps-sdk-"));
  const exe = process.platform === "win32" ? ".exe" : "";
  mkdirSync(join(sdk, "emulator"), { recursive: true });
  mkdirSync(join(sdk, "platform-tools"), { recursive: true });
  writeFileSync(join(sdk, "emulator", `emulator${exe}`), "");
  writeFileSync(join(sdk, "platform-tools", `adb${exe}`), "");
  savedAndroidHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
});

afterEach(() => {
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
  rmSync(sdk, { recursive: true, force: true });
});

describe("capabilities while the feature is off", () => {
  it("answers without discovering the SDK or running any of its tools", async () => {
    const spawn = spyOn(Bun, "spawn");
    try {
      const caps = await androidCapabilities({ enabled: false });
      expect(spawn).not.toHaveBeenCalled();
      expect(caps.enabled).toBe(false);
      expect(caps.ready).toBe(false);
      expect(caps.sdk.root).toBeNull();
      // The one row there is says why it is off, and how to turn it on.
      expect(caps.requirements).toEqual([expect.objectContaining({ id: "enabled", met: false })]);
      expect(caps.requirements[0]!.fix).toContain("ANDROID_EMULATOR_ENABLED=1");
    } finally {
      spawn.mockRestore();
    }
  });
});
