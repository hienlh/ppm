/**
 * The AVDs this host has, and enough of each one's config to say whether it will behave.
 *
 * Read straight from the AVD home rather than by shelling out to `emulator -list-avds`: that
 * command answers names only, and the setup screen needs the API level, ABI and — the one that
 * actually bites — whether the hardware keyboard is on.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export interface AvdSummary {
  /** Opaque, stable id issued by PPM. Derived from the canonical config path so it survives a
   *  rename of the display name and never collides across two AVD homes. */
  avdId: string;
  name: string;
  /** Directory holding config.ini, i.e. `<avd home>/<name>.avd`. */
  dir: string;
  apiLevel: number | null;
  abi: string | null;
  tag: string | null;
  deviceProfile: string | null;
  displayWidth: number | null;
  displayHeight: number | null;
  displayDensity: number | null;
  /**
   * `hw.keyboard`. When this is off, gRPC touch works perfectly, `sendKey` returns OK, and not
   * one keystroke reaches the guest — no error anywhere. `avdmanager` creates AVDs with it off;
   * Android Studio creates them with it on. Measured in Phase 0; surfaced so the UI can warn.
   */
  hardwareKeyboard: boolean;
  /** True when another process holds this AVD's lock — usually Android Studio running it. */
  lockedByAnotherProcess: boolean;
}

function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Stable opaque id for an AVD, from its canonical directory. */
export function avdIdFor(avdDir: string): string {
  return createHash("sha256").update(resolve(avdDir)).digest("hex").slice(0, 16);
}

/**
 * API level out of `image.sysdir.1`, e.g. `system-images/android-35/google_apis.../x86_64/`.
 * `target=android-35` is not always present in configs written by newer tooling.
 */
function apiLevelFrom(cfg: Record<string, string>): number | null {
  const target = cfg["target"];
  const fromTarget = target ? /android-(\d+)/.exec(target)?.[1] : undefined;
  if (fromTarget) return Number(fromTarget);
  const sysdir = cfg["image.sysdir.1"];
  const fromSysdir = sysdir ? /android-(\d+)/.exec(sysdir)?.[1] : undefined;
  return fromSysdir ? Number(fromSysdir) : null;
}

/**
 * Is this AVD locked by a process that is actually alive?
 *
 * Presence of a lock file is **not** the answer, measured: `multiinstance.lock` is a zero-byte
 * marker that survives a clean shutdown, so treating it as a lock refuses every start after the
 * first. The real lock is `hardware-qemu.ini.lock`, which holds the emulator's pid (verified
 * against the live process), so the pid is what gets checked. A lock naming a dead pid is stale
 * and ignored.
 *
 * PPM only ever *reports* this — plan §5 is explicit that a lock is never deleted to force a
 * start, which is what would corrupt an image Android Studio is using.
 */
function isLocked(avdDir: string): boolean {
  for (const lock of ["hardware-qemu.ini.lock", "userdata-qemu.img.lock"]) {
    const path = join(avdDir, lock);
    if (!existsSync(path)) continue;
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { continue; }
    // The emulator writes the pid **NUL-terminated** — measured, `hardware-qemu.ini.lock` is the
    // 7 bytes `519772\0`. A NUL is not whitespace, so `trim()` keeps it and `Number()` answers
    // NaN: read that way, every running emulator reports itself unlocked and the "open in
    // Android Studio" warning never appears. Take the leading digits instead.
    const digits = /^\s*(\d+)/.exec(raw);
    if (!digits) continue;
    const pid = Number(digits[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); return true; } catch { /* stale lock, owner is gone */ }
  }
  return false;
}

export function listAvds(avdHome: string): AvdSummary[] {
  let entries: string[];
  try { entries = readdirSync(avdHome); } catch { return []; }

  const avds: AvdSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".avd")) continue;
    const dir = join(avdHome, entry);
    const configPath = join(dir, "config.ini");
    let cfg: Record<string, string>;
    try { cfg = parseIni(readFileSync(configPath, "utf8")); } catch { continue; }

    const name = cfg["AvdId"] ?? entry.slice(0, -".avd".length);
    avds.push({
      avdId: avdIdFor(dir),
      name,
      dir,
      apiLevel: apiLevelFrom(cfg),
      abi: cfg["abi.type"] ?? null,
      tag: cfg["tag.id"] ?? null,
      deviceProfile: cfg["hw.device.name"] ?? null,
      displayWidth: num(cfg["hw.lcd.width"]),
      displayHeight: num(cfg["hw.lcd.height"]),
      displayDensity: num(cfg["hw.lcd.density"]),
      hardwareKeyboard: (cfg["hw.keyboard"] ?? "no").trim() === "yes",
      lockedByAnotherProcess: isLocked(dir),
    });
  }
  return avds.sort((a, b) => a.name.localeCompare(b.name));
}
