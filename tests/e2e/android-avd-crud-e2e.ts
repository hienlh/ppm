/**
 * Phase 4 gate, end to end against real SDK tools and two real boots:
 *
 *   ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$(mktemp -d) bun tests/e2e/android-avd-crud-e2e.ts
 *
 * The plan's gate is three claims, and only one of them can be checked without booting:
 *
 *   "tạo → boot → stop → mở lại giữ dữ liệu; wipe/delete chỉ trúng AVD đã chọn;
 *    không sửa AVD Studio đang chạy."
 *
 * So this creates a throwaway AVD, boots it, **writes a file inside the guest**, stops it, boots
 * it again and checks the file is still there — that is what "giữ dữ liệu" means and nothing
 * short of a second boot proves it. Then it wipes, boots a third time and checks the file is
 * gone; then deletes, and checks a *second* AVD beside it was untouched throughout.
 *
 * It takes several minutes. It never touches Pixel_9 / Pixel_Tablet (plan §9): everything
 * happens in the spike AVD home.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listAvds } from "../../src/services/android/avd-list.ts";
import { listSystemImages } from "../../src/services/android/system-images.ts";
import {
  createAvd, deleteAvd, listDeviceProfiles, parseDeviceProfiles, validateAvdName, wipeAvdData,
} from "../../src/services/android/avd-manager.ts";
import { buildArgs } from "../../src/services/android/emulator-launcher.ts";
import { findRunningEmulators } from "../../src/services/android/emulator-discovery.ts";
import { connectToEmulator, requestShutdown } from "../../src/services/android/android-grpc.ts";

const SDK = join(homedir(), "Android/Sdk");
const AVD_HOME = join(homedir(), ".android-phase4-avd");
const AVDMANAGER = join(SDK, "cmdline-tools/latest/bin/avdmanager");
const EMULATOR = join(SDK, "emulator/emulator");
const ADB = join(SDK, "platform-tools/adb");
const TARGET = "ppm_phase4_target";
const BYSTANDER = "ppm_phase4_bystander";
const MARKER = "/data/local/tmp/ppm-phase4-marker.txt";

const LOG_DIR = process.env.PPM_E2E_LOG_DIR ?? tmpdir();

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(AVDMANAGER)) { console.error(`no avdmanager at ${AVDMANAGER}`); process.exit(1); }
mkdirSync(AVD_HOME, { recursive: true });

/**
 * Boot `name` from the isolated AVD home and wait for adb to call it `device`.
 *
 * The emulator's own output is kept: a boot that never completes is otherwise reported as the
 * word "no", and the reason it did not boot is the only interesting thing about it.
 */
let bootAttempt = 0;
const bootLogs: string[] = [];

async function boot(name: string, extra: string[] = []): Promise<{ serial: string; seconds: number } | null> {
  const args = buildArgs({ avdName: name, avdHome: AVD_HOME, emulatorPath: EMULATOR, gpuMode: "swiftshader_indirect" });
  const logPath = join(LOG_DIR, `emulator-${++bootAttempt}-${name}.log`);
  const log = Bun.file(logPath).writer();
  const proc = Bun.spawn([EMULATOR, ...args, "-no-audio", ...extra], {
    env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  void (async () => { for await (const chunk of proc.stdout) log.write(chunk); })();
  void (async () => { for await (const chunk of proc.stderr) log.write(chunk); })();

  const started = Date.now();
  for (let i = 0; i < 240; i++) {
    await Bun.sleep(1000);
    if (proc.exitCode !== null) {
      bootLogs.push(`${logPath} (emulator exited with ${proc.exitCode} after ${i}s)`);
      return null;
    }
    const running = findRunningEmulators().find((e) => e.avdName === name);
    if (!running?.adbSerial) continue;
    const state = Bun.spawnSync([ADB, "-s", running.adbSerial, "shell", "getprop", "sys.boot_completed"])
      .stdout.toString().trim();
    if (state === "1") return { serial: running.adbSerial, seconds: Math.round((Date.now() - started) / 1000) };
  }
  bootLogs.push(`${logPath} (still running, never reported boot_completed)`);
  return null;
}

/** Graceful shutdown through gRPC — never a kill by process name (plan ADR-D). */
async function stop(name: string): Promise<boolean> {
  const running = findRunningEmulators().find((e) => e.avdName === name);
  if (!running) return true;
  try {
    const channel = connectToEmulator(running);
    await requestShutdown(channel);
    channel.close();
  } catch { return false; }
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    if (!findRunningEmulators().some((e) => e.avdName === name)) return true;
  }
  return false;
}

const guestHas = (serial: string) =>
  Bun.spawnSync([ADB, "-s", serial, "shell", "cat", MARKER]).stdout.toString().trim();

try {
  // ------------------------------------------------------------------- pure checks, no booting
  console.log("--- names and parsing ---");
  for (const [name, wantOk] of [["Pixel_9", true], ["a.b-c_1", true], ["has space", false],
                                ["", false], ["-leading", false], ["x".repeat(64), false]] as const) {
    const problem = validateAvdName(name);
    if ((problem === null) !== wantOk) check(`name ${JSON.stringify(name)}`, false, problem ?? "accepted");
  }
  check("AVD names are validated, not escaped", results.length === 0, "6 cases");

  const profiles = await listDeviceProfiles(AVDMANAGER);
  check("device profiles parse", profiles.length > 20, `${profiles.length} profiles`);
  // Every Pixel entry has no `Tag :` line — a parser requiring one drops exactly the profiles
  // people reach for, and would still look like it worked.
  const pixel = profiles.find((p) => p.id === "pixel_9");
  check("a profile with no Tag line still parses", pixel?.name === "Pixel 9" && pixel.tag === null,
    pixel ? `${pixel.name} tag=${pixel.tag} kind=${pixel.kind}` : "pixel_9 missing");
  check("profiles are classified", profiles.some((p) => p.kind === "phone") && profiles.some((p) => p.kind === "tablet"),
    `${profiles.filter((p) => p.kind === "phone").length} phones, ${profiles.filter((p) => p.kind === "tablet").length} tablets`);

  const images = listSystemImages(SDK);
  check("installed system images are found", images.length > 0,
    images.map((i) => `${i.id} (${(i.bytes / 1024 ** 3).toFixed(1)}GB)`).join(", "));
  const image = images.find((i) => i.abi === "x86_64");
  if (!image) { check("an x86_64 image to build on", false, "none installed"); throw new Error("stop"); }

  check("cold boot adds -no-snapshot-load and quick boot does not",
    buildArgs({ avdName: "x", avdHome: "/tmp", emulatorPath: "/e", bootMode: "cold" }).includes("-no-snapshot-load")
    && !buildArgs({ avdName: "x", avdHome: "/tmp", emulatorPath: "/e" }).includes("-no-snapshot-load"));
  check("no boot mode ever passes -grpc",
    !buildArgs({ avdName: "x", avdHome: "/tmp", emulatorPath: "/e", bootMode: "cold" }).includes("-grpc"));

  // ------------------------------------------------------------------------------------ create
  console.log("\n--- create ---");
  for (const name of [TARGET, BYSTANDER]) {
    if (listAvds(AVD_HOME).some((a) => a.name === name)) {
      await deleteAvd(AVDMANAGER, name, AVD_HOME);
    }
  }
  const created = await createAvd({
    name: TARGET, systemImage: image.id, deviceProfile: "pixel_9",
    ramMb: 2048, storageMb: 4096, sdCardMb: 256,
    avdmanagerPath: AVDMANAGER, avdHome: AVD_HOME, images,
  });
  check("create succeeds", created.ok, created.ok ? created.message : created.message);
  check("the AVD has a real display, not avdmanager's 320x640 default",
    created.avd?.displayWidth === 1080 && (created.avd?.displayHeight ?? 0) > 2000,
    `${created.avd?.displayWidth}x${created.avd?.displayHeight}`);
  check("hw.keyboard=yes was written", created.avd?.hardwareKeyboard === true,
    `hw.keyboard=${created.avd?.hardwareKeyboard}`);
  const config = readFileSync(join(AVD_HOME, `${TARGET}.avd`, "config.ini"), "utf8");
  check("RAM and storage were applied",
    config.includes("hw.ramSize=2048M") && config.includes("disk.dataPartition.size=4096M"),
    config.split("\n").filter((l) => /^(hw\.ramSize|disk\.dataPartition\.size)=/.test(l)).join(" "));

  const dup = await createAvd({
    name: TARGET, systemImage: image.id, deviceProfile: "pixel_9",
    avdmanagerPath: AVDMANAGER, avdHome: AVD_HOME, images,
  });
  check("a duplicate name is refused rather than overwritten", !dup.ok && /already exists/.test(dup.message), dup.message);

  const madeUp = await createAvd({
    name: "ppm_phase4_nope", systemImage: "system-images;android-99;evil;x86_64", deviceProfile: "pixel_9",
    avdmanagerPath: AVDMANAGER, avdHome: AVD_HOME, images,
  });
  check("a system image the host does not have is refused", !madeUp.ok && /not installed/.test(madeUp.message), madeUp.message);

  const bystander = await createAvd({
    name: BYSTANDER, systemImage: image.id, deviceProfile: "medium_phone",
    avdmanagerPath: AVDMANAGER, avdHome: AVD_HOME, images,
  });
  check("a second AVD is created to watch for collateral damage", bystander.ok, bystander.message);

  // --------------------------------------------------------- boot → write → stop → boot again
  console.log("\n--- boot, write, stop, boot again ---");
  const first = await boot(TARGET);
  check("the new AVD boots", first !== null, first ? `${first.serial} in ${first.seconds}s` : "never reported boot_completed");
  if (!first) throw new Error("stop");

  const written = `phase4-${Date.now()}`;
  // One argument, not `sh -c <cmd>`: adb joins its arguments with spaces and hands the whole
  // string to the **device's** shell, so a redirect written as a separate argv element is parsed
  // by that shell rather than by the `sh -c` it was meant for — `sh -c echo` then writes an empty
  // line and the marker file exists with nothing in it.
  Bun.spawnSync([ADB, "-s", first.serial, "shell", `echo ${written} > ${MARKER}`]);
  check("a file can be written in the guest", guestHas(first.serial) === written, guestHas(first.serial));

  check("first stop is graceful", await stop(TARGET));

  const second = await boot(TARGET);
  check("it boots a second time", second !== null, second ? `${second.serial} in ${second.seconds}s` : "no");
  if (!second) throw new Error("stop");
  // The gate: stop and reopen must not lose what the guest wrote.
  check("data survives stop and reopen", guestHas(second.serial) === written,
    `expected ${written}, guest said ${JSON.stringify(guestHas(second.serial))}`);
  check("second stop is graceful", await stop(TARGET));

  // ------------------------------------------------------------------------------------- wipe
  console.log("\n--- wipe ---");
  const bystanderDirBefore = listAvds(AVD_HOME).find((a) => a.name === BYSTANDER)!.dir;
  const bystanderConfigBefore = readFileSync(join(bystanderDirBefore, "config.ini"), "utf8");

  const targetDir = listAvds(AVD_HOME).find((a) => a.name === TARGET)!.dir;
  const wiped = wipeAvdData(targetDir);
  check("wipe reports what it removed", wiped.ok && wiped.removed.length > 0,
    `${wiped.removed.join(", ")} (${(wiped.freedBytes / 1024 ** 2).toFixed(0)} MB)`);
  check("wipe keeps config.ini", existsSync(join(targetDir, "config.ini")));
  check("wipe keeps the AVD's own .ini", existsSync(join(AVD_HOME, `${TARGET}.ini`)));
  check("the AVD is still listed after a wipe", listAvds(AVD_HOME).some((a) => a.name === TARGET));
  check("wipe left the other AVD alone",
    readFileSync(join(bystanderDirBefore, "config.ini"), "utf8") === bystanderConfigBefore
    && existsSync(join(AVD_HOME, `${BYSTANDER}.ini`)));

  const third = await boot(TARGET);
  check("it boots after a wipe", third !== null, third ? `${third.serial} in ${third.seconds}s` : "no");
  if (third) {
    check("the wipe really removed the guest's data", guestHas(third.serial) === "",
      `guest said ${JSON.stringify(guestHas(third.serial))}`);
    check("third stop is graceful", await stop(TARGET));
  }

  // ------------------------------------------------------------------ destructive-while-running
  console.log("\n--- refusals ---");
  const fourth = await boot(TARGET);
  if (fourth) {
    const summary = listAvds(AVD_HOME).find((a) => a.name === TARGET)!;
    check("a running AVD is reported as locked", summary.lockedByAnotherProcess,
      `lockedByAnotherProcess=${summary.lockedByAnotherProcess}`);
    await stop(TARGET);
  } else {
    check("a running AVD is reported as locked", false, "could not boot to test");
  }

  // ------------------------------------------------------------------------------------ delete
  console.log("\n--- delete ---");
  const removed = await deleteAvd(AVDMANAGER, TARGET, AVD_HOME);
  check("delete succeeds", removed.ok, removed.ok ? "deleted" : removed.message);
  check("the AVD is gone from the listing", !listAvds(AVD_HOME).some((a) => a.name === TARGET));
  check("its directory is gone", !existsSync(join(AVD_HOME, `${TARGET}.avd`)) && !existsSync(join(AVD_HOME, `${TARGET}.ini`)));
  check("delete hit only the named AVD",
    listAvds(AVD_HOME).some((a) => a.name === BYSTANDER)
    && readFileSync(join(bystanderDirBefore, "config.ini"), "utf8") === bystanderConfigBefore);

  const ghost = await deleteAvd(AVDMANAGER, "ppm_phase4_never_existed", AVD_HOME);
  check("deleting something that is not there fails cleanly", !ghost.ok, ghost.message.slice(0, 80));
} finally {
  console.log("\n--- cleanup ---");
  for (const name of [TARGET, BYSTANDER]) {
    await stop(name).catch(() => {});
    if (listAvds(AVD_HOME).some((a) => a.name === name)) await deleteAvd(AVDMANAGER, name, AVD_HOME).catch(() => {});
  }
  // The AVD home itself belongs to this test; the user's is never touched.
  try { rmSync(AVD_HOME, { recursive: true, force: true }); } catch { /* left for inspection */ }
  console.log(`  ${findRunningEmulators().length} emulator(s) still running`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
if (bootLogs.length > 0) {
  console.log("\nboots that never completed:");
  for (const line of bootLogs) console.log(`  - ${line}`);
}
process.exit(failed.length === 0 ? 0 : 1);
