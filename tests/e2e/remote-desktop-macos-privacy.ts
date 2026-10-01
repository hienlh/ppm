/**
 * Proves macOS privacy mode actually holds the host's input, against the real window server.
 *
 *   bun tests/e2e/remote-desktop-macos-privacy.ts
 *
 * Not a `bun test` file, and it cannot be one: the only way to know whether the local keyboard
 * and mouse are really dead is to lock them and look. A unit test can assert the plumbing and
 * never the effect — which is exactly the trap the X11 side records, where an `EVIOCGRAB` probe
 * reported "privacy mode available" for a feature that could not work because something else
 * already held the grab.
 *
 * **It locks this machine's keyboard and mouse for HOLD_MS, and blanks the screen if the host
 * can.** Run it where you can afford that. It is as safe as it can be made:
 *
 *  - the mechanism is a *deadline*, not a lock (see `remote-desktop-privacy-darwin.ts`), so a
 *    kill -9 of this script gives the input back within the suppression interval, 3 s;
 *  - the fade reservation lapses by itself after at most 15 s, so a black screen cannot persist;
 *  - a hard timer releases everything even if the measurement below throws.
 *
 * What it measures, and why that is the honest answer: macOS exposes per-source HID event
 * counters, so "did the window server see local input during the window" is readable rather
 * than guessed. The counters are the evidence; the operator typing is what generates it, which
 * is why the script asks and then says plainly whether it worked.
 */
import {
  engagePrivacy, privacySupport,
} from "../../src/services/remote-desktop/remote-desktop-privacy.ts";
import { macPermissionStatus } from "../../src/services/remote-desktop/remote-desktop-macos-permissions.ts";

const HOLD_MS = 5000;
const COUNTDOWN_MS = 3000;
/** How long to wait for the operator to show up before refusing to measure anything. */
const OPERATOR_WAIT_MS = 60_000;
/** Input this recent means somebody is at the host right now. */
const OPERATOR_LIVE_SECONDS = 2;

if (process.platform !== "darwin") {
  console.error("This script only means anything on macOS.");
  process.exit(1);
}

const { dlopen, FFIType: T } = await import("bun:ffi");
const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGEventSourceCounterForEventType: { args: [T.i32, T.u32], returns: T.u32 },
  CGEventSourceSecondsSinceLastEventType: { args: [T.i32, T.u32], returns: T.double },
}).symbols;

/** `kCGEventSourceStateHIDSystemState` — the state the real hardware posts into. */
const HID = 1;
/** `CGEventType`s worth counting: a key press, a pointer move, a click. */
const EVENTS = { keyDown: 10, mouseMoved: 5, leftMouseDown: 1 } as const;
/** `kCGAnyInputEventType` — any of them, for the "is anyone here" check. */
const ANY_EVENT = 0xFFFFFFFF;
type Counts = Record<keyof typeof EVENTS, number>;
const counters = (): Counts => ({
  keyDown: cg.CGEventSourceCounterForEventType(HID, EVENTS.keyDown),
  mouseMoved: cg.CGEventSourceCounterForEventType(HID, EVENTS.mouseMoved),
  leftMouseDown: cg.CGEventSourceCounterForEventType(HID, EVENTS.leftMouseDown),
});
const delta = (a: Counts, b: Counts): Counts => ({
  keyDown: b.keyDown - a.keyDown,
  mouseMoved: b.mouseMoved - a.mouseMoved,
  leftMouseDown: b.leftMouseDown - a.leftMouseDown,
});
const total = (c: Counts) => c.keyDown + c.mouseMoved + c.leftMouseDown;

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("permissions:", await macPermissionStatus());
const support = await privacySupport();
console.log("privacySupport():", support);

if (!support.available) {
  // Not a failure of the port: refusing is the correct answer on a host that cannot do it, and
  // the reason is the thing to act on.
  console.log(`\nPrivacy mode is unavailable here: ${support.reason}`);
  console.log("Nothing was held. Grant what the reason names and run this again.");
  process.exit(0);
}

// Wait until somebody is demonstrably *at* this Mac, and refuse to run otherwise.
//
// This is the whole validity of the measurement and it is not a nicety. "No local input reached
// the window server while privacy mode was held" is also what a host with privacy mode doing
// absolutely nothing reports, as long as nobody touches it — and that is exactly what the first
// two runs of this script produced: three windows of zeroes, two `ok`s, and no evidence of
// anything. It is the same trap the X11 side records, where probing only `devices[0]` reported
// a feature as available that could not work. `CGEventSourceSecondsSinceLastEventType` is the
// control, and it is cheap: measured on an untouched host it tracks wall clock exactly (24.27 s
// → 28.27 s over a four-second sleep), so "someone is here" is readable rather than assumed.
const idleSeconds = () => cg.CGEventSourceSecondsSinceLastEventType(HID, ANY_EVENT);
console.log("\n>>> Move the mouse / press a key now, so this can tell you are at the machine.");
const waitUntil = Date.now() + OPERATOR_WAIT_MS;
while (idleSeconds() > OPERATOR_LIVE_SECONDS) {
  if (Date.now() > waitUntil) {
    console.log(`\nNobody has touched this Mac for ${idleSeconds().toFixed(0)}s, so there would be `
      + "nothing for privacy mode to block and the run would pass without proving anything.");
    console.log("Nothing was locked. Run this again while sitting at the host.");
    process.exit(2);
  }
  await Bun.sleep(250);
}

console.log(`>>> Locking this Mac's keyboard and mouse for ${HOLD_MS / 1000}s, in ${COUNTDOWN_MS / 1000}s.`);
console.log(">>> Keep typing and moving the mouse the whole time — that is the measurement.");
await Bun.sleep(COUNTDOWN_MS);

// A baseline over the same length of time, so "nothing happened during the window" can be told
// apart from "nobody was typing".
const idleStart = counters();
await Bun.sleep(500);
const idleDelta = delta(idleStart, counters());

const before = counters();
const handle = await engagePrivacy();
if (!handle) {
  console.error("engagePrivacy() answered null although privacySupport() said it was available.");
  process.exit(1);
}
const safety = setTimeout(() => {
  try { handle.release(); } catch { /* going away anyway */ }
  console.error("\nSafety timer fired — released and bailing out.");
  process.exit(1);
}, HOLD_MS + 5000);

await Bun.sleep(HOLD_MS);
const held = delta(before, counters());
handle.release();
clearTimeout(safety);

// Give the window server a moment, then confirm input is live again.
await Bun.sleep(500);
const afterRelease = counters();
await Bun.sleep(1500);
const freed = delta(afterRelease, counters());

console.log("\nHID counters");
console.log(`  before engaging, 0.5s idle baseline : ${JSON.stringify(idleDelta)}`);
console.log(`  while privacy mode held (${HOLD_MS}ms) : ${JSON.stringify(held)}`);
console.log(`  1.5s after release                  : ${JSON.stringify(freed)}`);

console.log("\nresults");
check(handle.inputBlocked, "engage reported input blocked");
check(total(held) === 0, "no local input reached the window server while held",
  total(held) === 0 ? "" : `${total(held)} events got through — suppression is NOT holding`);
check(total(freed) > 0, "local input works again after release",
  total(freed) > 0 ? "" : "nothing came through; type during the final 1.5s to confirm this");
console.log(`  note  blanked=${handle.blanked} (canBlank=${support.canBlank}) — check by eye whether`);
console.log("        the screen went black AND a connected viewer still saw the real desktop.");

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
