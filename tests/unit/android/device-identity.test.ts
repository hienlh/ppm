/**
 * An AVD's **id** and its **display name** are two different strings, and only one of them
 * identifies the device.
 *
 * Android Studio writes both into the discovery file: `avd.id=Pixel_9` alongside
 * `avd.name=Pixel 9`, the same string with the underscores turned back into spaces. The id is
 * what `-avd` takes and what the AVD's own `config.ini` calls `AvdId`; the display name is for
 * people. Reading the display name as the identity made a running emulator fail to match its own
 * AVD row — the device list then showed it as stopped, offered Start for something already up,
 * and grew a second `external:` row beside it with no geometry.
 *
 * It went unseen because every AVD created while building this had a one-word name, where the
 * two fields are identical. Hence these fixtures: the names deliberately differ.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRunningEmulators } from "../../../src/services/android/emulator-discovery.ts";
import { listDevices } from "../../../src/services/android/device-registry.ts";

const AVD_ID = "Pixel_9";
const DISPLAY_NAME = "Pixel 9";

let runtimeDir: string;
let avdHome: string;
let ppmHome: string;
let saved: Record<string, string | undefined> = {};
let child: ReturnType<typeof Bun.spawn> | null = null;

/** A live process whose argv really carries the AVD id, which is what identity is checked against. */
async function spawnStandIn(): Promise<number> {
  // The id rides as an argument of its own, exactly as it does in the emulator's argv. A bun
  // child rather than `sh -c "sleep 30; :"`, so that the stand-in exists on Windows too.
  child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)", AVD_ID], {
    stdout: "ignore", stderr: "ignore",
  });
  // Only Linux reads the argv back (/proc), and there it is empty until the child has exec'd.
  if (process.platform === "linux") {
    for (let i = 0; i < 200; i++) {
      try {
        if (readFileSync(`/proc/${child.pid}/cmdline`, "utf8").split("\0").includes(AVD_ID)) break;
      } catch { /* not exec'd yet */ }
      await Bun.sleep(10);
    }
  }
  return child.pid;
}

function writeDiscovery(pid: number): void {
  const dir = join(runtimeDir, "avd", "running");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pid_${pid}.ini`), [
    `avd.id=${AVD_ID}`,
    `avd.name=${DISPLAY_NAME}`,
    `avd.dir=${join(avdHome, `${AVD_ID}.avd`)}`,
    "grpc.port=8554",
    "port.adb=5555",
    "port.serial=5554",
  ].join("\n"));
}

function writeAvd(): void {
  const dir = join(avdHome, `${AVD_ID}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.ini"), [
    `AvdId=${AVD_ID}`,
    `avd.ini.displayname=${DISPLAY_NAME}`,
    "abi.type=x86_64",
    "hw.keyboard=yes",
    "hw.lcd.width=1080",
    "hw.lcd.height=2400",
    "image.sysdir.1=system-images/android-35/google_apis_playstore/x86_64/",
  ].join("\n"));
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "ppm-ident-run-"));
  avdHome = mkdtempSync(join(tmpdir(), "ppm-ident-avd-"));
  ppmHome = mkdtempSync(join(tmpdir(), "ppm-ident-home-"));
  saved = {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA,
    TMPDIR: process.env.TMPDIR, PPM_HOME: process.env.PPM_HOME,
  };
  // Every discovery directory bar the home one, so an emulator running on the host adds no rows:
  // `LOCALAPPDATA` is where Windows's emulator writes, `TMPDIR` the other platforms' fallback.
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.LOCALAPPDATA = runtimeDir;
  process.env.TMPDIR = runtimeDir;
  process.env.PPM_HOME = ppmHome;
});

afterEach(async () => {
  if (child) { child.kill(); await child.exited; child = null; }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [runtimeDir, avdHome, ppmHome]) rmSync(d, { recursive: true, force: true });
});

describe("an AVD whose display name differs from its id", () => {
  it("is discovered under its id, not its display name", async () => {
    writeDiscovery(await spawnStandIn());
    const found = findRunningEmulators();
    expect(found).toHaveLength(1);
    expect(found[0]!.avdName).toBe(AVD_ID);
    expect(found[0]!.avdName).not.toBe(DISPLAY_NAME);
  });

  it("matches its own row instead of appearing twice", async () => {
    writeAvd();
    writeDiscovery(await spawnStandIn());

    const devices = listDevices(avdHome);
    expect(devices).toHaveLength(1);                       // no duplicate `external:` row

    const entry = devices[0]!;
    expect(entry.name).toBe(AVD_ID);
    expect(entry.avdId.startsWith("external:")).toBe(false);
    expect(entry.state).toBe("ready");                     // not offered Start while it is up
    expect(entry.runtime?.grpcPort).toBe(8554);
    // The row keeps the geometry only the AVD's config knows, which an `external:` row has not.
    expect(entry.displayWidth).toBe(1080);
    expect(entry.displayHeight).toBe(2400);
  });

  it("still lists an emulator from an AVD home PPM is not reading", async () => {
    // No config on disk here: the external row is a real case and must survive the fix.
    writeDiscovery(await spawnStandIn());
    const devices = listDevices(avdHome);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.avdId).toBe(`external:${AVD_ID}`);
    expect(devices[0]!.runtime?.ownedByPpm).toBe(false);
  });
});
