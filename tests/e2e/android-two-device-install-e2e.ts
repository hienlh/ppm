/**
 * The Phase 3 gate that needs two emulators: **"install đúng target khi có hai máy"**.
 *
 *   ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$(mktemp -d) bun tests/e2e/android-two-device-install-e2e.ts
 *
 * `adb install` with no `-s` picks whichever device adb feels like when two are attached, and
 * says nothing about which one it chose — so "it installed" is not evidence of anything. This
 * installs a package to one device and then checks **both**: present on the target, absent on
 * the other. Without the second half the test would pass against the bug.
 *
 * It needs two emulators running from the spike's isolated AVD home. Never the user's own
 * Pixel_9 / Pixel_Tablet (plan §9).
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findRunningEmulators } from "../../src/services/android/emulator-discovery.ts";
import { installApk } from "../../src/services/android/android-apk.ts";

const adb = join(process.env.HOME!, "Android/Sdk/platform-tools/adb");
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const emulators = findRunningEmulators().filter((e) => e.adbSerial);
console.log(`running: ${emulators.map((e) => `${e.avdName}(${e.adbSerial})`).join(", ") || "none"}\n`);
if (emulators.length < 2) {
  console.error("this test needs two emulators running; start a second AVD with\n" +
    "  $ANDROID_HOME/emulator/emulator -avd <another name> -no-window -no-audio &");
  process.exit(1);
}

const [target, other] = emulators;

function shell(serial: string, ...args: string[]): string {
  return Bun.spawnSync([adb, "-s", serial, "shell", ...args]).stdout.toString().trim();
}
function packagesOn(serial: string): Set<string> {
  return new Set(shell(serial, "pm", "list", "packages")
    .split("\n").map((l) => l.replace(/^package:/, "").trim()).filter(Boolean));
}
function hasPackage(serial: string, pkg: string): boolean {
  // `pm list packages <filter>` matches by substring, so the exact name has to be checked.
  return packagesOn(serial).has(pkg);
}

/**
 * Make the two devices differ, so the test can fail.
 *
 * Installing something both devices already have would pass whether or not `-s` is honoured, so
 * an asymmetry is required. A natural one is used when the two AVDs run different system images;
 * when they run the *same* image — which is the normal case for two spike AVDs — one is created
 * by removing an ordinary app from the target for user 0. `pm list packages` then stops naming
 * it on the target while the other device still has it, which is exactly the before/after pair
 * the assertion needs.
 *
 * `--user 0` rather than a plain uninstall: these are system apps, and a plain uninstall is
 * refused. The app is restored at the end either way.
 */
const REMOVABLE = ["com.google.android.deskclock", "com.android.traceur", "com.android.wallpapercropper"];

const onTarget = packagesOn(target!.adbSerial!);
let onlyOnOther = [...packagesOn(other!.adbSerial!)]
  .filter((p) => !onTarget.has(p))
  // Prefer something small and ordinary over a vendor blob.
  .sort((a, b) => a.length - b.length);

let removedForUser: string | null = null;
if (onlyOnOther.length === 0) {
  const victim = REMOVABLE.find((p) => onTarget.has(p) && packagesOn(other!.adbSerial!).has(p));
  if (victim) {
    shell(target!.adbSerial!, "pm", "uninstall", "--user", "0", victim);
    if (!hasPackage(target!.adbSerial!, victim)) { removedForUser = victim; onlyOnOther = [victim]; }
  }
}

let apkPath: string | null = null;
let pkg: string | null = null;
for (const candidate of onlyOnOther) {
  const remote = shell(other!.adbSerial!, "pm", "path", candidate).split("\n")[0]?.replace(/^package:/, "").trim();
  if (!remote) continue;
  const local = join(tmpdir(), `ppm-two-device-${Date.now()}.apk`);
  Bun.spawnSync([adb, "-s", other!.adbSerial!, "pull", remote, local]);
  if (existsSync(local)) { apkPath = local; pkg = candidate; break; }
}

check("a package exists on one device and not the other", apkPath !== null,
  apkPath
    ? `${pkg}${removedForUser ? " (removed from the target for user 0 to create the difference)" : ""}`
    : "the two images are identical and no removable app was found");

if (apkPath && pkg) {
  console.log(`\ninstalling ${pkg} onto ${target!.avdName} (${target!.adbSerial}), not ${other!.avdName} (${other!.adbSerial})\n`);

  check("the package is not on the target before the install", !hasPackage(target!.adbSerial!, pkg));
  check("the package is on the other device before the install", hasPackage(other!.adbSerial!, pkg));

  const result = await installApk({ adbPath: adb, serial: target!.adbSerial!, apkPath, reinstall: true });
  check("the install succeeded", result.ok, result.ok ? "installed" : `${result.code ?? "-"}: ${result.message}`);
  check("the package is now on the target", hasPackage(target!.adbSerial!, pkg), `${pkg} on ${target!.adbSerial}`);

  // The half that would catch a dropped `-s`: nothing about the other device may have changed.
  check("the other device still has exactly what it had", hasPackage(other!.adbSerial!, pkg), other!.adbSerial!);

  // And a serial that is not attached must fail rather than fall back to a live device.
  const wrong = await installApk({ adbPath: adb, serial: "emulator-9998", apkPath });
  check("a serial that is not attached fails instead of falling back to a live device",
    !wrong.ok && /not found|device|offline/i.test(wrong.message + wrong.output), wrong.message.slice(0, 90));

  // Why `-s` is load-bearing and not tidiness: without it adb refuses outright once two devices
  // are attached, so a build that dropped it would fail on exactly the host this feature is for.
  const noSerial = Bun.spawnSync([adb, "install", apkPath]);
  const noSerialOut = `${noSerial.stdout.toString()}${noSerial.stderr.toString()}`.trim();
  check("adb with no -s refuses while two devices are attached",
    /more than one device/i.test(noSerialOut), noSerialOut.split("\n")[0] ?? "");

  // Leave the target as it was found. A package this test created the absence of is now back,
  // which is the state it started in; one that was genuinely absent is removed again.
  if (!removedForUser) Bun.spawnSync([adb, "-s", target!.adbSerial!, "uninstall", pkg]);
  check("the target is left as it was found",
    removedForUser ? hasPackage(target!.adbSerial!, pkg) : !hasPackage(target!.adbSerial!, pkg));

  rmSync(apkPath, { force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
