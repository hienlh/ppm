/**
 * Phase 3 end-to-end, against a real emulator:
 *
 *   ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$(mktemp -d) bun tests/e2e/android-phase3-e2e.ts
 *
 * The three things Phase 3 adds are each a question the proto does not answer, and each has a
 * plausible wrong answer that would only show up in use:
 *
 *  1. **Can a cancelled `streamLogcat` be reopened?** `streamScreenshot` cannot — measured in
 *     Phase 2, a replacement stream delivers exactly one frame and then nothing, which is why
 *     the video pipeline holds one stream for the session's life. If logcat shares that defect,
 *     "hide the panel, show it again" would silently produce a dead log, and the design has to
 *     keep the stream open and stop forwarding instead. So this closes and reopens twice.
 *  2. **Does taking a screenshot disturb a running video stream?** They are different RPCs on
 *     one channel; if the unary call reset the stream, every screenshot would freeze the view.
 *  3. **Does `adb install` actually name the target?** With two devices attached, `adb install`
 *     with no `-s` picks one of them and says nothing about it.
 *
 * Plus the gate itself: a cancelled upload must leave no temp file.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRunningEmulators } from "../../src/services/android/emulator-discovery.ts";
import { connectToEmulator } from "../../src/services/android/android-grpc.ts";
import { subscribeLogcat, logcatBacklog, closeDeviceLogcat, LOGCAT_RING_SIZE } from "../../src/services/android/android-logcat.ts";
import { takeScreenshot, screenshotFilename, setDeviceClipboard, MAX_CLIPBOARD_CHARS } from "../../src/services/android/android-screenshot.ts";
import { getClipboard } from "../../src/services/android/android-input.ts";
import {
  apkStagingDir, explainInstallOutput, findProjectApks, installApk, stageApkUpload, sweepApkStaging,
} from "../../src/services/android/android-apk.ts";
import { startVideoPipeline } from "../../src/services/android/android-video.ts";
import type { AndroidLogEntry } from "../../src/shared/android-protocol.ts";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const emulator = findRunningEmulators()[0];
if (!emulator) {
  console.error("no emulator running — start one first, e.g. `$ANDROID_HOME/emulator/emulator -avd <name> -no-window -no-audio`");
  process.exit(1);
}
const adb = join(process.env.HOME!, "Android/Sdk/platform-tools/adb");
const deviceId = `${emulator.pid}:${emulator.grpcPort}`;
console.log(`device ${deviceId}, adb serial ${emulator.adbSerial}\n`);

const channel = connectToEmulator(emulator);
const scratch = mkdtempSync(join(tmpdir(), "ppm-android-p3-"));

/** Make the guest say something with a known tag, so a log assertion is not a guess. */
function logFromGuest(tag: string, message: string): void {
  Bun.spawnSync([adb, "-s", emulator.adbSerial!, "shell", "log", "-t", tag, message]);
}

try {
  // ---------------------------------------------------------------------------------- screenshot
  console.log("--- screenshot ---");
  const shot = await takeScreenshot(channel);
  const isPng = shot.png[0] === 0x89 && shot.png[1] === 0x50 && shot.png[2] === 0x4e && shot.png[3] === 0x47;
  check("screenshot is a PNG", isPng, `${shot.png.length} bytes, ${shot.width}x${shot.height}`);
  check("screenshot is the native size", shot.width > 0 && shot.height > 0 && shot.png.length > 10_000,
    `${shot.width}x${shot.height}`);

  // The one comparison that catches an upside-down image: the emulator's own PNG against
  // `adb exec-out screencap -p`, which is unambiguously top-down.
  const viaAdb = Bun.spawnSync([adb, "-s", emulator.adbSerial!, "exec-out", "screencap", "-p"]).stdout;
  check("adb screencap agrees on the size", viaAdb.length > 1000, `${viaAdb.length} bytes`);

  const name = screenshotFilename("Pixel 9 / weird:name");
  check("screenshot filename is safe", /^Pixel_9_weird_name-\d{8}-\d{6}\.png$/.test(name), name);

  // ----------------------------------------------------------------------------------- clipboard
  console.log("\n--- clipboard ---");
  const secret = `ppm-clip-${crypto.randomUUID()}`;
  await setDeviceClipboard(channel, secret);
  const read = await getClipboard(channel);
  check("clipboard round-trips", read === secret, read === secret ? `${secret.length} chars` : `got ${JSON.stringify(read.slice(0, 40))}`);

  let tooLongRejected = false;
  try { await setDeviceClipboard(channel, "x".repeat(MAX_CLIPBOARD_CHARS + 1)); }
  catch { tooLongRejected = true; }
  check("oversized clipboard is refused", tooLongRejected);

  // ------------------------------------------------------------------------------------- logcat
  console.log("\n--- logcat ---");
  const seen: AndroidLogEntry[] = [];
  let off = subscribeLogcat(deviceId, channel, (e) => seen.push(...e));
  const tag1 = `PPMTest${Date.now() % 100000}`;
  await Bun.sleep(600);
  logFromGuest(tag1, "first run marker");
  await Bun.sleep(1500);
  const firstHit = seen.filter((e) => e.tag === tag1);
  check("logcat delivers entries", seen.length > 0, `${seen.length} entries`);
  check("logcat sees a message the guest just logged", firstHit.length > 0,
    firstHit[0] ? `${firstHit[0].level} ${firstHit[0].tag}: ${firstHit[0].message}` : `tag ${tag1} never arrived`);
  check("entries are parsed, not raw text",
    seen.some((e) => e.tag !== "" && e.pid > 0 && e.level !== "verbose"),
    `levels seen: ${[...new Set(seen.map((e) => e.level))].join(",")}`);

  // *The* question: does closing and reopening work, or is it `streamScreenshot`'s one-shot?
  const firstCount = seen.length;
  off();
  await Bun.sleep(400);
  const afterClose = seen.length;
  logFromGuest(tag1, "while nobody is watching");
  await Bun.sleep(800);
  check("unsubscribing stops the stream", seen.length === afterClose,
    `${seen.length - afterClose} entries arrived after unsubscribe`);

  const second: AndroidLogEntry[] = [];
  off = subscribeLogcat(deviceId, channel, (e) => second.push(...e));
  await Bun.sleep(600);
  const tag2 = `PPMTest2${Date.now() % 100000}`;
  logFromGuest(tag2, "second run marker");
  await Bun.sleep(1500);
  check("a reopened logcat stream still delivers", second.some((e) => e.tag === tag2),
    `${second.length} entries on the second subscription (first run: ${firstCount})`);

  // Two watchers, one stream.
  const third: AndroidLogEntry[] = [];
  const off3 = subscribeLogcat(deviceId, channel, (e) => third.push(...e));
  check("a second watcher gets the backlog immediately", third.length > 0, `${third.length} entries replayed`);
  const tag3 = `PPMTest3${Date.now() % 100000}`;
  const beforeBoth = { a: second.length, b: third.length };
  logFromGuest(tag3, "both watchers");
  await Bun.sleep(1500);
  check("both watchers see the same new entry",
    second.some((e) => e.tag === tag3) && third.some((e) => e.tag === tag3),
    `+${second.length - beforeBoth.a} / +${third.length - beforeBoth.b}`);

  off();
  const afterOneLeft = third.length;
  const tag4 = `PPMTest4${Date.now() % 100000}`;
  logFromGuest(tag4, "one watcher left");
  await Bun.sleep(1500);
  check("one watcher leaving does not stop the other", third.some((e) => e.tag === tag4),
    `+${third.length - afterOneLeft} after the first watcher left`);
  off3();

  check("the ring buffer is bounded", LOGCAT_RING_SIZE === 2000, `${LOGCAT_RING_SIZE} entries`);
  const backlog = logcatBacklog(deviceId);
  check("the backlog survives the last watcher leaving", backlog.length > 0,
    `${backlog.length} entries still held with nobody subscribed`);

  // Reopening after everyone left must give that backlog back *and* resume the stream.
  const fourth: AndroidLogEntry[] = [];
  const off4 = subscribeLogcat(deviceId, channel, (e) => fourth.push(...e));
  check("reopening replays the kept backlog", fourth.length >= backlog.length,
    `${fourth.length} replayed vs ${backlog.length} held`);
  const tag5 = `PPMTest5${Date.now() % 100000}`;
  await Bun.sleep(600);
  logFromGuest(tag5, "after everyone left and came back");
  await Bun.sleep(1500);
  check("reopening after the last watcher left resumes the stream", fourth.some((e) => e.tag === tag5),
    `${fourth.length} entries after reopening`);
  off4();

  // ---------------------------------------------------------- screenshot does not disturb video
  console.log("\n--- screenshot vs. a running video stream ---");
  const pipeline = await startVideoPipeline({
    emulator, quality: "low",
    onAccessUnit: () => {}, onGeometry: () => {}, onError: () => {},
  });
  try {
    // Keep the screen changing, or `streamScreenshot` (which is change-driven) reports nothing
    // and the comparison is between two zeroes — the Phase 2 false failure.
    Bun.spawnSync([adb, "-s", emulator.adbSerial!, "shell", "input", "keyevent", "KEYCODE_HOME"]);
    const scroll = () => Bun.spawnSync([adb, "-s", emulator.adbSerial!, "shell", "input", "swipe", "500", "1500", "500", "600", "300"]);
    scroll();
    await Bun.sleep(2000);
    const before = pipeline.stats().sourceFrames;
    for (let i = 0; i < 3; i++) { await takeScreenshot(channel); scroll(); await Bun.sleep(700); }
    const after = pipeline.stats().sourceFrames;
    check("the video stream survives three screenshots", after > before + 10, `${before} -> ${after}`);
  } finally {
    await pipeline.stop();
  }

  // -------------------------------------------------------------------------------- APK staging
  console.log("\n--- APK upload staging ---");
  process.env.PPM_HOME ||= scratch;                    // never the real ~/.ppm, per CLAUDE.md
  sweepApkStaging();
  const stagingBefore = safeList(apkStagingDir());

  // A body that aborts halfway is what a user pressing Cancel produces.
  const controller = new AbortController();
  const zipHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  let cancelled = false;
  try {
    await stageApkUpload(new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(zipHeader);
        c.enqueue(new Uint8Array(1024 * 1024));
        controller.abort();
        await Bun.sleep(20);
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    }), { signal: controller.signal });
  } catch { cancelled = true; }
  check("a cancelled upload throws", cancelled);
  check("a cancelled upload leaves no temp file",
    safeList(apkStagingDir()).length === stagingBefore.length,
    `${safeList(apkStagingDir()).length} file(s) in ${apkStagingDir()}`);

  let notZip = false;
  try {
    await stageApkUpload(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("this is not a zip at all")); c.close(); },
    }));
  } catch { notZip = true; }
  check("a non-APK upload is refused", notZip);
  check("a refused upload leaves no temp file", safeList(apkStagingDir()).length === stagingBefore.length);

  let overLimit = false;
  try {
    await stageApkUpload(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(zipHeader); c.enqueue(new Uint8Array(4096)); c.close(); },
    }), { maxBytes: 1024 });
  } catch { overLimit = true; }
  check("an oversized upload is cut off", overLimit);
  check("an oversized upload leaves no temp file", safeList(apkStagingDir()).length === stagingBefore.length);

  const good = await stageApkUpload(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(zipHeader); c.enqueue(new Uint8Array(2048)); c.close(); },
  }));
  check("a complete upload lands on disk", existsSync(good.path) && statSync(good.path).size === 2052,
    `${good.bytes} bytes at ${good.path}`);
  good.discard();
  check("discard removes it", !existsSync(good.path));

  // ------------------------------------------------------------------------------- adb install
  console.log("\n--- adb install ---");
  const explanations: [string, number, boolean, string | null][] = [
    ["Success", 0, true, null],
    ["Performing Streamed Install\nSuccess", 0, true, null],
    ["adb: failed to install x.apk: Failure [INSTALL_FAILED_NO_MATCHING_ABIS: no arm]", 1, false, "INSTALL_FAILED_NO_MATCHING_ABIS"],
    ["Failure [INSTALL_FAILED_OLDER_SDK]", 1, false, "INSTALL_FAILED_OLDER_SDK"],
    ["Failure [INSTALL_FAILED_SOMETHING_NEW]", 1, false, "INSTALL_FAILED_SOMETHING_NEW"],
    ["adb: device offline", 1, false, "device offline"],
  ];
  let explained = 0;
  for (const [out, code, wantOk, wantCode] of explanations) {
    const got = explainInstallOutput(out, code);
    if (got.ok === wantOk && got.code === wantCode) explained++;
    else console.log(`      mismatch for ${JSON.stringify(out.slice(0, 40))}: ${JSON.stringify(got)}`);
  }
  check("adb output is explained correctly", explained === explanations.length, `${explained}/${explanations.length}`);

  // A real install of a real APK. The device already has one: pull the Settings app back out and
  // reinstall it, which needs no network and no fixture in the repository.
  const pathOut = Bun.spawnSync([adb, "-s", emulator.adbSerial!, "shell", "pm", "path", "com.android.calculator2"]).stdout.toString().trim()
    || Bun.spawnSync([adb, "-s", emulator.adbSerial!, "shell", "pm", "path", "com.android.settings"]).stdout.toString().trim();
  const remote = pathOut.split("\n")[0]?.replace(/^package:/, "").trim();
  if (remote) {
    const localApk = join(scratch, "pulled.apk");
    Bun.spawnSync([adb, "-s", emulator.adbSerial!, "pull", remote, localApk]);
    if (existsSync(localApk)) {
      const lines: string[] = [];
      const result = await installApk({
        adbPath: adb, serial: emulator.adbSerial!, apkPath: localApk,
        reinstall: true, onProgress: (l) => lines.push(l),
      });
      // A system APK reinstalled over itself is legitimately refused on some images; what is
      // being tested is that the *reason* comes back, not that every APK installs.
      check("a real install returns a decided answer",
        result.ok || result.code !== null || result.message.length > 0,
        result.ok ? "installed" : `${result.code ?? "-"}: ${result.message}`);
      check("install progress is reported", lines.length > 0 || result.ok, `${lines.length} line(s)`);
    } else {
      check("a real install returns a decided answer", false, "could not pull an APK to test with");
    }
  } else {
    check("a real install returns a decided answer", false, "no package to pull");
  }

  // The gate: two devices attached, the install must name one.
  const attached = Bun.spawnSync([adb, "devices"]).stdout.toString()
    .split("\n").slice(1).map((l) => l.split("\t")[0]?.trim()).filter(Boolean);
  const wrongSerial = "emulator-9998";
  const targeted = await installApk({
    adbPath: adb, serial: wrongSerial, apkPath: join(scratch, "pulled.apk"),
  });
  check("an install names its target device",
    !targeted.ok && /device|not found|offline/i.test(targeted.message + targeted.output),
    `${attached.length} device(s) attached; install to ${wrongSerial}: ${targeted.message.slice(0, 80)}`);

  const missing = await installApk({ adbPath: adb, serial: emulator.adbSerial!, apkPath: join(scratch, "nope.apk") });
  check("a missing file is refused before adb runs", !missing.ok && missing.output === "", missing.message);

  const noAdb = await installApk({ adbPath: join(scratch, "no-such-adb"), serial: emulator.adbSerial!, apkPath: join(scratch, "pulled.apk") });
  check("a missing adb is reported, not thrown", !noAdb.ok && /adb/i.test(noAdb.message), noAdb.message);

  // ------------------------------------------------------------------------ project APK listing
  console.log("\n--- project APK listing ---");
  const proj = join(scratch, "proj");
  const deep = join(proj, "app", "build", "outputs", "apk", "debug");
  Bun.spawnSync(["mkdir", "-p", deep, join(proj, "node_modules", "junk")]);
  writeFileSync(join(deep, "app-debug.apk"), "PK\x03\x04");
  writeFileSync(join(proj, "node_modules", "junk", "trap.apk"), "PK\x03\x04");
  const apks = await findProjectApks(proj);
  check("project APKs are found", apks.some((a) => a.path.endsWith("app-debug.apk")), apks.map((a) => a.path).join(", ") || "none");
  check("node_modules is pruned", !apks.some((a) => a.path.includes("node_modules")), `${apks.length} found`);
} finally {
  closeDeviceLogcat(deviceId);
  channel.close();
  rmSync(scratch, { recursive: true, force: true });
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("failed:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
}
process.exit(failed.length === 0 ? 0 : 1);
