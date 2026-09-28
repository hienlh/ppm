/**
 * Phase 2 end-to-end, against a real emulator. Run it, do not reason about it:
 *
 *   ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$(mktemp -d) bun tests/e2e/android-e2e.ts
 *
 * It answers the two questions the proto does not, and that guessing at would produce a viewer
 * where "taps land slightly off" and nobody could say why:
 *
 *  1. **Which coordinate space does `sendTouch` use?** `Touch.x` is documented as "the physical
 *     location on the screen", which could mean the panel's own pixels or the rotated display's.
 *     Watched with `getevent`, the guest's touchscreen reports a 0..32767 absolute range, and a
 *     coordinate is normalised against the **panel's** own size whatever the current rotation —
 *     so a rotated frame's coordinates have to be rotated back before they are sent.
 *  2. **Is the pixel buffer bottom-up?** The proto says it is; matched row by row against
 *     `adb exec-out screencap`, which is unambiguously top-down, it is not. This is a regression
 *     guard as much as a measurement: a future emulator that really is bottom-up would render
 *     every screen upside down with no error, and this is what would say so.
 *
 * It also exercises the whole Phase 2 loop: pipeline up, keyframes flowing, quality switch,
 * clean teardown.
 */
import { findRunningEmulators } from "../../src/services/android/emulator-discovery.ts";
import { connectToEmulator, getEmulatorStatus, unaryCall } from "../../src/services/android/android-grpc.ts";
import { frameToDevice } from "../../src/web/components/android/android-coords.ts";
import { sendTouch, setRotation, sendText, releaseAllTouches } from "../../src/services/android/android-input.ts";
import { startVideoPipeline } from "../../src/services/android/android-video.ts";

const results: { name: string; ok: boolean; detail: string }[] = [];
let pipelineRef: { stats(): { sourceFrames: number; fedFrames: number } } | null = null;
let lastSource = 0;

/**
 * Frames the emulator has sent, and — only when that number has not moved — what the guest is
 * showing. A stall here is almost always the guest being parked on a screen that does not
 * change: a stray tap in this very test once opened the Play Store, which with no network is a
 * still picture, and the pipeline dutifully sent nothing. Without this line that reads as a
 * broken pipeline, which is how an afternoon goes.
 */
function mark(where: string): void {
  if (!pipelineRef) return;
  const s = pipelineRef.stats();
  const delta = s.sourceFrames - lastSource;
  let why = "";
  if (delta === 0 && emulator.adbSerial) {
    const dump = Bun.spawnSync(["adb", "-s", emulator.adbSerial, "shell", "dumpsys", "window"]).stdout.toString();
    why = `\n      nothing arrived — the guest is showing ${dump.match(/mCurrentFocus=[^\n]*/)?.[0] ?? "?"}`;
  }
  console.log(`  [source frames] ${where}: total ${s.sourceFrames} (+${delta})${why}`);
  lastSource = s.sourceFrames;
}

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const emulator = findRunningEmulators()[0];
if (!emulator) {
  console.error("no emulator running — start one first, e.g. `$ANDROID_HOME/emulator/emulator -avd <name> -no-window -no-audio`");
  process.exit(1);
}
console.log(`emulator: ${emulator.avdName} pid=${emulator.pid} grpc=${emulator.grpcPort} adb=${emulator.adbSerial}`);

const serial = emulator.adbSerial;
const adb = (...a: string[]) => serial ? Bun.spawnSync(["adb", "-s", serial, "shell", ...a]) : null;

// Two things that look like a broken pipeline and are not. `streamScreenshot` is **change
// driven**: a still picture produces almost no frames (Phase 0 measured 2.1 fps against one and
// 40 fps against a moving one), and a screen that has gone to sleep produces none at all — an
// emulator left idle for a few minutes reports zero access units from a perfectly healthy
// pipeline. So the guest is woken, pinned awake, and given something to scroll.
adb("input", "keyevent", "KEYCODE_WAKEUP");
adb("svc", "power", "stayon", "true");
adb("input", "keyevent", "KEYCODE_HOME");

function startMotion(seconds: number) {
  if (!serial) return null;
  return Bun.spawn(["bash", "-c",
    `end=$(( $(date +%s) + ${seconds} )); while [ "$(date +%s)" -lt "$end" ]; do ` +
    `adb -s ${serial} shell input swipe 540 1800 540 600 1000 >/dev/null 2>&1; ` +
    `adb -s ${serial} shell input swipe 540 600 540 1800 1000 >/dev/null 2>&1; done`]);
}

const channel = connectToEmulator(emulator);
const status = await getEmulatorStatus(channel);
check("booted", status.booted, `${status.displayWidth}x${status.displayHeight}`);

// -------------------------------------------------------------------------------------------
// 1. Video pipeline
// -------------------------------------------------------------------------------------------
let keyframes = 0;
let units = 0;
const geometries: string[] = [];
const pipeline = await startVideoPipeline({
  emulator,
  quality: "balanced",
  onAccessUnit: (au) => { units++; if (au.isKey) keyframes++; },
  onGeometry: (g) => geometries.push(`${g.width}x${g.height}@${g.rotation}`),
  onError: (m) => console.error(`  pipeline: ${m}`),
});
pipelineRef = pipeline;
mark("right after start");
check("pipeline started", true, `${pipeline.geometry.width}x${pipeline.geometry.height} rot=${pipeline.geometry.rotation} enc=${pipeline.encoder}`);

// The rung's ceiling applies to the LONG edge, so a portrait guest is capped on its height and a
// landscape one on its width — that is what makes a rotation not shrink the picture.
check("long edge is capped by the rung", Math.max(pipeline.geometry.width, pipeline.geometry.height) <= 1280,
  `long edge ${Math.max(pipeline.geometry.width, pipeline.geometry.height)} <= 1280`);
check("aspect ratio preserved", Math.abs(
  (pipeline.geometry.width / pipeline.geometry.height) - ((status.displayWidth ?? 1) / (status.displayHeight ?? 1))
) < 0.02, `${(pipeline.geometry.width / pipeline.geometry.height).toFixed(4)} vs ${((status.displayWidth ?? 1) / (status.displayHeight ?? 1)).toFixed(4)}`);

const warmup = startMotion(8);
await Bun.sleep(8000);
try { warmup?.kill(); } catch { /* already finished */ }
mark("after the warmup scroll");
check("frames encoding", units > 30, `${units} access units while the screen was scrolling`);
check("keyframes arriving", keyframes >= 2, `${keyframes} keyframes (0.5s GOP)`);
const codec = pipeline.codecString();
check("codec string derived from real SPS", /^avc1\.[0-9a-f]{6}$/.test(codec ?? ""), String(codec));

// -------------------------------------------------------------------------------------------
// 2. Is the buffer bottom-up, as the proto claims?
// -------------------------------------------------------------------------------------------
if (serial) {
  // Both shots have to come from a still screen: they are taken moments apart, and a scroll in
  // between shrinks the margin between the two alignments to noise.
  await Bun.sleep(1800);
  const shot = await unaryCall(channel, "getScreenshot", { format: "RGB888" }, 10_000);
  const sw = Number(shot.format.width), sh = Number(shot.format.height);
  const g: Buffer = shot.image;
  const raw = Buffer.from(Bun.spawnSync(["adb", "-s", serial, "exec-out", "screencap"]).stdout);
  const cw = raw.readUInt32LE(0), chh = raw.readUInt32LE(4);
  // Android ships a 12-byte header, or 16 since S (it gained a colorSpace field).
  const body = raw.subarray(raw.length === cw * chh * 4 + 16 ? 16 : 12);
  if (cw === sw && chh === sh) {
    const score = (flip: boolean) => {
      let sum = 0, n = 0;
      for (let y = 4; y < sh; y += 17) for (let x = 0; x < sw; x += 13) {
        const gi = (y * sw + x) * 3;
        const ci = ((flip ? sh - 1 - y : y) * sw + x) * 4;
        sum += Math.abs(g[gi]! - body[ci]!) + Math.abs(g[gi + 1]! - body[ci + 1]!) + Math.abs(g[gi + 2]! - body[ci + 2]!);
        n++;
      }
      return sum / n;
    };
    const aligned = score(false), flipped = score(true);
    // A real answer separates the two by an order of magnitude; anything closer means the screen
    // moved between the shots and the comparison proved nothing.
    check("the buffer is top-down, so encoderArgs must NOT vflip", aligned * 4 < flipped,
      `mean |diff| aligned ${aligned.toFixed(2)} vs flipped ${flipped.toFixed(2)}`);
  } else {
    check("orientation comparable", false, `sizes differ: grpc ${sw}x${sh}, screencap ${cw}x${chh}`);
  }
}

mark("after the orientation check");

// -------------------------------------------------------------------------------------------
// 3. Which coordinate space does sendTouch use?
// -------------------------------------------------------------------------------------------
async function readTouchEvents(sendIt: () => Promise<void>): Promise<{ x: number[]; y: number[] }> {
  if (!serial) return { x: [], y: [] };
  const proc = Bun.spawn(["adb", "-s", serial, "shell", "getevent", "-lt"], { stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(600);                       // let getevent attach before anything is sent
  await sendIt();
  await Bun.sleep(900);
  proc.kill();
  const text = await new Response(proc.stdout).text();
  const grab = (name: string) => [...text.matchAll(new RegExp(`${name}\\s+([0-9a-f]+)`, "g"))]
    .map((m) => parseInt(m[1]!, 16));
  return { x: grab("ABS_MT_POSITION_X"), y: grab("ABS_MT_POSITION_Y") };
}

// The guest's touchscreen reports an absolute range rather than pixels, so what arrives is the
// coordinate normalised against the PANEL's size. The probe's two axes must be at different
// fractions of their extent, or a mix-up between them is invisible — which is exactly how the
// first run of this test read a false pass on (900, 2000), where 900/1080 and 2000/2400 are the
// same 5/6.
const ABS_MAX = 32767;
const PANEL_W = status.displayWidth ?? 1080;
const PANEL_H = status.displayHeight ?? 2400;
const PROBE = { x: 200, y: 2000 };
const expectX = Math.round(PROBE.x / PANEL_W * ABS_MAX);
const expectY = Math.round(PROBE.y / PANEL_H * ABS_MAX);

const portraitEvents = await readTouchEvents(async () => {
  await sendTouch(channel, [{ x: PROBE.x, y: PROBE.y, id: 0, pressure: 1 }]);
  await Bun.sleep(120);
  await sendTouch(channel, [{ x: PROBE.x, y: PROBE.y, id: 0, pressure: 0 }]);
});
console.log(`  getevent portrait: X=${portraitEvents.x.join(",") || "none"} Y=${portraitEvents.y.join(",") || "none"} (expected X≈${expectX} Y≈${expectY})`);
check("touch reached the guest at all", portraitEvents.x.length > 0,
  serial ? `${portraitEvents.x.length} X events` : "no adb serial — skipped");
if (portraitEvents.x.length > 0) {
  // getevent only prints an axis when its value CHANGES, so a missing Y means "same as last
  // time" rather than "not sent" — only assert on what was actually reported.
  const okX = Math.abs(portraitEvents.x[0]! - expectX) <= 3;
  const okY = portraitEvents.y.length === 0 || Math.abs(portraitEvents.y[0]! - expectY) <= 3;
  check("sendTouch takes PANEL pixels, normalised to the touchscreen's range", okX && okY,
    `sent (${PROBE.x},${PROBE.y}) on a ${PANEL_W}x${PANEL_H} panel → kernel saw (${portraitEvents.x[0]},${portraitEvents.y[0] ?? "unchanged"})`);
}

// -------------------------------------------------------------------------------------------
// 3. Rotation
// -------------------------------------------------------------------------------------------
mark("after the portrait touch probe");
const before = `${pipeline.geometry.width}x${pipeline.geometry.height}@${pipeline.geometry.rotation}`;
await setRotation(channel, 90);
await Bun.sleep(4000);
const after = `${pipeline.geometry.width}x${pipeline.geometry.height}@${pipeline.geometry.rotation}`;
check("rotation changes the reported geometry", before !== after, `${before} → ${after}`);
check("the long edge survives rotation", Math.max(pipeline.geometry.width, pipeline.geometry.height) >= 1000,
  `long edge now ${Math.max(pipeline.geometry.width, pipeline.geometry.height)}`);

// The real question for a rotated screen: does what the VIEWER would send for a given point in
// the frame arrive at the panel pixel that point is drawn on? `frameToDevice` is the viewer's own
// function, so this tests the mapping the user actually gets.
mark("after rotating to 90");
const g90 = {
  width: pipeline.geometry.width, height: pipeline.geometry.height,
  deviceWidth: PANEL_W, deviceHeight: PANEL_H,
  rotation: pipeline.geometry.rotation, generation: 1,
};
// A quarter of the way across and three quarters down the picture, which is asymmetric in both
// the frame and the panel.
const inFrame = { x: Math.round(g90.width * 0.25), y: Math.round(g90.height * 0.75) };
const mapped = frameToDevice(inFrame, g90);
const landscapeEvents = await readTouchEvents(async () => {
  await sendTouch(channel, [{ x: mapped.x, y: mapped.y, id: 0, pressure: 1 }]);
  await Bun.sleep(120);
  await sendTouch(channel, [{ x: mapped.x, y: mapped.y, id: 0, pressure: 0 }]);
});
const wantX = Math.round(mapped.x / PANEL_W * ABS_MAX);
const wantY = Math.round(mapped.y / PANEL_H * ABS_MAX);
console.log(`  rotated: frame(${inFrame.x},${inFrame.y}) of ${g90.width}x${g90.height}@${g90.rotation}`
  + ` → panel(${mapped.x},${mapped.y}) → getevent X=${landscapeEvents.x.join(",") || "none"} Y=${landscapeEvents.y.join(",") || "none"}`
  + ` (expected X≈${wantX} Y≈${wantY})`);
check("a rotated frame coordinate lands where the viewer maps it",
  landscapeEvents.x.length > 0
    && Math.abs(landscapeEvents.x[0]! - wantX) <= 3
    && (landscapeEvents.y.length === 0 || Math.abs(landscapeEvents.y[0]! - wantY) <= 3),
  `${landscapeEvents.x[0] ?? "none"},${landscapeEvents.y[0] ?? "unchanged"}`);
check("a rotated coordinate stays inside the panel", mapped.x <= PANEL_W && mapped.y <= PANEL_H,
  `(${mapped.x},${mapped.y}) within ${PANEL_W}x${PANEL_H}`);

mark("after the landscape touch probe");
await setRotation(channel, 0);
await Bun.sleep(2500);
adb("input", "keyevent", "KEYCODE_HOME");
await Bun.sleep(1500);
mark("after rotating back to 0");

// -------------------------------------------------------------------------------------------
// 4. Quality switch and teardown
// -------------------------------------------------------------------------------------------
// `streamScreenshot` is change-driven: a static screen produces almost no frames at all, which
// is a feature and not a stall (Phase 0 measured 2.1 fps against a still picture and 40 fps
// against a moving one). So this has to scroll something, or it measures nothing.
const motion = startMotion(10);
await Bun.sleep(2500);
mark("after 2.5s of scrolling, before the rung switch");
const unitsBefore = units;
const statsBefore = pipeline.stats();
await pipeline.setQuality("low");
await Bun.sleep(8000);
const statsAfter = pipeline.stats();
console.log(`  across the switch: source +${statsAfter.sourceFrames - statsBefore.sourceFrames},`
  + ` fed +${statsAfter.fedFrames - statsBefore.fedFrames}, access units +${units - unitsBefore}`);
check("a rung switch keeps frames flowing", units > unitsBefore + 20, `${units - unitsBefore} units after the switch`);
try { motion?.kill(); } catch { /* already finished */ }
check("the rung's new ceiling applies", Math.max(pipeline.geometry.width, pipeline.geometry.height) <= 720,
  `${pipeline.geometry.width}x${pipeline.geometry.height}`);

// Text: ASCII types, non-ASCII must take the clipboard path. This only proves the call is
// accepted — Phase 0 already proved what each path delivers.
check("ascii text accepted", await sendText(channel, "ppm").then((r) => r === "typed").catch(() => false));
check("non-ascii routed to the clipboard", await sendText(channel, "Tiếng Việt 😀").then((r) => r === "pasted").catch(() => false));

await releaseAllTouches(channel);
await pipeline.stop();
channel.close();
check("pipeline stopped cleanly", true);

// `pgrep -f <pattern>` matches the *command line*, which on a shell that carries the pattern in
// its own argv matches itself — the trap CLAUDE.md records, and it has produced a false alarm
// here already. `-x` matches the process NAME, which cannot.
let leftover = "?";
for (let i = 0; i < 20; i++) {
  leftover = Bun.spawnSync(["pgrep", "-xc", "ffmpeg"]).stdout.toString().trim() || "0";
  if (leftover === "0") break;
  await Bun.sleep(250);
}
check("no ffmpeg left behind", leftover === "0", `pgrep -xc ffmpeg said ${leftover}`);

adb("svc", "power", "stayon", "false");

console.log(`\ngeometries seen: ${geometries.join(" → ") || "(none after startup)"}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
