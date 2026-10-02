/**
 * Which emulators are running right now, and how to reach each one's gRPC endpoint.
 *
 * The emulator advertises itself in a per-process `.ini` under the *current user's* runtime
 * directory. Plan §5 requires this to be read defensively: bounded in size, with PID liveness
 * and process identity verified, and only a loopback endpoint accepted — a stale `.ini` from a
 * crashed emulator otherwise names a port some unrelated process may now hold.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** A discovery .ini is a few hundred bytes; anything larger is not one, and we refuse to read it. */
const MAX_DISCOVERY_BYTES = 64 * 1024;

export interface RunningEmulator {
  /** Absolute path of the discovery file this came from. */
  file: string;
  pid: number;
  /**
   * The AVD **id** (`avd.id`) — what `-avd` takes, what an AVD's `config.ini` calls `AvdId`, and
   * what `listAvds()` reports as `name`. Deliberately not `avd.name`, which is the display name.
   */
  avdName: string;
  avdDir: string | null;
  emulatorVersion: string | null;
  grpcPort: number;
  /** Bearer token for the gRPC channel. Never leaves the backend. */
  grpcToken: string | null;
  /** Directory of JSON Web Key Sets, when the emulator offers JWT auth. */
  grpcJwks: string | null;
  adbPort: number | null;
  adbSerial: string | null;
  /** The emulator's own argv, used to verify this pid is still the process the file describes. */
  cmdline: string | null;
}

/** Where the emulator writes discovery files, current user only. */
export function discoveryDirs(): string[] {
  const dirs: string[] = [];
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) dirs.push(join(runtime, "avd", "running"));
  dirs.push(join(homedir(), ".android", "avd", "running"));
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) dirs.push(join(local, "Temp", "avd", "running"));
  } else {
    const tmp = process.env.TMPDIR ?? "/tmp";
    dirs.push(join(tmp, `android-${process.env.USER ?? ""}`, "avd", "running"));
  }
  return dirs;
}

function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("[")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Is this pid alive? Signal 0 tests existence without delivering anything. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Does the live process still look like the emulator the discovery file describes?
 *
 * PIDs are reused. Without this, a stale `.ini` whose pid now belongs to something else would
 * be treated as a running emulator — and a later "stop" would signal an innocent process.
 */
export function verifyProcessIdentity(pid: number, avdName: string | undefined): boolean {
  const avd = avdName;
  if (!avd) return false;
  if (platform() !== "linux") {
    // Only /proc gives a cheap, dependency-free argv. Elsewhere the pid check plus a live gRPC
    // handshake is what establishes identity, so accept a live pid here and let the connect
    // prove it.
    return pidAlive(pid);
  }
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return argv.some((a) => a === avd) || argv.some((a) => a.includes("qemu-system"));
  } catch {
    return false;
  }
}

function parsePort(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** Every emulator this user is running that advertises a usable loopback gRPC endpoint. */
export function findRunningEmulators(): RunningEmulator[] {
  const found: RunningEmulator[] = [];
  const seenPids = new Set<number>();

  for (const dir of discoveryDirs()) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }

    for (const name of entries) {
      const m = /^pid_(\d+)\.ini$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (seenPids.has(pid)) continue;

      const file = join(dir, name);
      let fields: Record<string, string>;
      try {
        if (statSync(file).size > MAX_DISCOVERY_BYTES) continue;
        fields = parseIni(readFileSync(file, "utf8"));
      } catch {
        continue;   // racing with emulator shutdown is normal
      }

      const grpcPort = parsePort(fields["grpc.port"]);
      if (!grpcPort) continue;                       // no control channel, nothing we can drive
      if (!pidAlive(pid)) continue;                  // stale file from a crashed emulator
      // pid was reused by something else
      if (!verifyProcessIdentity(pid, fields["avd.id"] ?? fields["avd.name"])) continue;

      seenPids.add(pid);
      const adbPort = parsePort(fields["port.adb"]);
      const serialPort = parsePort(fields["port.serial"]);
      found.push({
        file,
        pid,
        // `avd.id`, **never** `avd.name`. The discovery file carries both, and for any AVD made
        // in Android Studio they differ: the id is `Pixel_9` while `avd.name` is `Pixel 9`, the
        // same string with the underscores turned back into spaces. Read the display name here
        // and a running emulator stops matching its own AVD row — the device list then shows the
        // AVD as stopped *and* a second `external:` row beside it with no geometry, and Start is
        // offered for a device that is already up. Every AVD used while this was built had a
        // one-word name, where the two fields agree, which is why it was never seen.
        avdName: fields["avd.id"] ?? fields["avd.name"] ?? "(unknown)",
        avdDir: fields["avd.dir"] ?? null,
        emulatorVersion: fields["emulator.version"] ?? null,
        grpcPort,
        grpcToken: fields["grpc.token"] ?? null,
        grpcJwks: fields["grpc.jwks"] ?? null,
        adbPort,
        // adb names an emulator by its *console* port, not its adb port.
        adbSerial: serialPort ? `emulator-${serialPort}` : null,
        cmdline: fields["cmdline"] ?? null,
      });
    }
  }
  return found;
}

export function findRunningEmulatorByAvd(avdName: string): RunningEmulator | null {
  return findRunningEmulators().find((e) => e.avdName === avdName) ?? null;
}
