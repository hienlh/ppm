/**
 * What devices exist, which of them PPM started, and how to tell the two apart across a restart.
 *
 * Identity, per plan §5:
 *  - `avdId` is stable and derived from the AVD's canonical directory (see `avd-list.ts`). It
 *    survives restarts and is what a tab is pinned to.
 *  - `deviceId` names one *runtime instance*. It changes when the emulator restarts, and carries
 *    a `generation` so a late message from a previous run can be rejected rather than applied.
 *  - The ADB serial is deliberately **not** an identity: `emulator-5554` is reused by whatever
 *    boots next.
 *
 * Ownership decides who may stop a device. PPM may stop only what PPM started; an emulator the
 * user launched from Android Studio is offered Disconnect and nothing more (plan ADR-D). That
 * has to survive a PPM restart, so a minimal record is persisted — pid plus a *start identity*,
 * because pids are reused and a bare pid would eventually name someone else's process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { getPpmDir } from "../ppm-dir.ts";
import { listAvds, type AvdSummary } from "./avd-list.ts";
import { findRunningEmulators, type RunningEmulator } from "./emulator-discovery.ts";

export type DeviceState =
  | "stopped"      // no process
  | "starting"     // process spawned, no gRPC yet
  | "booting"      // gRPC answers, guest not booted
  | "ready"        // guest reports boot complete
  | "stopping"
  | "error";

export interface RuntimeDevice {
  deviceId: string;
  generation: number;
  pid: number;
  grpcPort: number;
  adbSerial: string | null;
  /** True when this PPM instance started it and may therefore stop it. */
  ownedByPpm: boolean;
}

export interface DeviceEntry {
  avdId: string;
  name: string;
  apiLevel: number | null;
  abi: string | null;
  deviceProfile: string | null;
  displayWidth: number | null;
  displayHeight: number | null;
  hardwareKeyboard: boolean;
  lockedByAnotherProcess: boolean;
  state: DeviceState;
  runtime: RuntimeDevice | null;
}

interface OwnershipRecord {
  avdName: string;
  pid: number;
  /** Something that, with the pid, identifies *this* process run. Linux: /proc stat starttime. */
  startIdentity: string | null;
  generation: number;
  startedAt: number;
}

const OWNERSHIP_FILE = () => join(getPpmDir(), "android-ownership.json");

/**
 * A token that distinguishes this process run from a future one that reuses the pid.
 *
 * Linux exposes the process start time in /proc/<pid>/stat field 22 (jiffies since boot), which
 * is exactly the disambiguator pids lack. Elsewhere there is no cheap equivalent, so we return
 * null and fall back to a liveness check plus the discovery file's own AVD name — weaker, and
 * that weakness is why `stop` re-verifies through the discovery file before acting.
 */
export function processStartIdentity(pid: number): string | null {
  if (platform() !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is parenthesised and may itself contain spaces, so split after it.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Fields from here are 3..N; starttime is field 22, i.e. index 19 in this slice.
    return afterComm[19] ?? null;
  } catch {
    return null;
  }
}

function readOwnership(): OwnershipRecord[] {
  try {
    const raw = JSON.parse(readFileSync(OWNERSHIP_FILE(), "utf8"));
    return Array.isArray(raw) ? (raw as OwnershipRecord[]) : [];
  } catch {
    return [];
  }
}

function writeOwnership(records: OwnershipRecord[]): void {
  try {
    mkdirSync(getPpmDir(), { recursive: true });
    writeFileSync(OWNERSHIP_FILE(), JSON.stringify(records, null, 2));
  } catch (e) {
    // Losing the record costs stop rights after a restart, not correctness: an unowned device is
    // offered Disconnect. Never fail a start over it.
    console.warn(`[android] could not persist ownership: ${(e as Error).message}`);
  }
}

/** Record that this PPM started `avdName` as `pid`. Returns the generation for that run. */
export function claimOwnership(avdName: string, pid: number): number {
  const records = readOwnership().filter((r) => r.avdName !== avdName);
  const previous = readOwnership().find((r) => r.avdName === avdName);
  const generation = (previous?.generation ?? 0) + 1;
  records.push({
    avdName,
    pid,
    startIdentity: processStartIdentity(pid),
    generation,
    startedAt: Date.now(),
  });
  writeOwnership(records);
  return generation;
}

export function releaseOwnership(avdName: string): void {
  writeOwnership(readOwnership().filter((r) => r.avdName !== avdName));
}

/**
 * Does the ownership record still describe this live emulator?
 *
 * Both the pid and the start identity must match. A record whose pid is alive but whose start
 * identity differs is a *reused pid* — the emulator PPM started is gone and something unrelated
 * now holds that number, so PPM must not claim the right to stop it.
 */
function ownershipMatches(record: OwnershipRecord | undefined, emulator: RunningEmulator): boolean {
  if (!record) return false;
  if (record.pid !== emulator.pid) return false;
  const live = processStartIdentity(emulator.pid);
  if (record.startIdentity !== null && live !== null) return record.startIdentity === live;
  // No start identity available on this OS: fall back to the AVD name agreeing, which the
  // discovery file has already been verified against.
  return record.avdName === emulator.avdName;
}

export function generationFor(avdName: string): number {
  return readOwnership().find((r) => r.avdName === avdName)?.generation ?? 0;
}

/** Merge the AVDs on disk with whatever is running, and attach ownership. */
export function listDevices(avdHome: string): DeviceEntry[] {
  const avds = listAvds(avdHome);
  const running = findRunningEmulators();
  const ownership = readOwnership();

  const byName = new Map<string, RunningEmulator>();
  for (const e of running) byName.set(e.avdName, e);

  const entries: DeviceEntry[] = avds.map((avd) => toEntry(avd, byName.get(avd.name), ownership));

  // An emulator running from an AVD home PPM is not listing still deserves a row: the user can
  // see and disconnect from it, they just cannot start or stop it from here.
  for (const e of running) {
    if (entries.some((x) => x.name === e.avdName)) continue;
    entries.push({
      avdId: `external:${e.avdName}`,
      name: e.avdName,
      apiLevel: null, abi: null, deviceProfile: null,
      displayWidth: null, displayHeight: null,
      hardwareKeyboard: true,          // unknown; assume on so no misleading warning is shown
      lockedByAnotherProcess: false,
      state: "ready",
      runtime: runtimeOf(e, ownership),
    });
  }
  return entries;
}

function runtimeOf(e: RunningEmulator, ownership: OwnershipRecord[]): RuntimeDevice {
  const record = ownership.find((r) => r.avdName === e.avdName);
  const owned = ownershipMatches(record, e);
  return {
    // Runtime identity, not stable: pid + port is unique while the process lives, and changes
    // on every restart, which is exactly what `deviceId` is supposed to express.
    deviceId: `${e.pid}:${e.grpcPort}`,
    generation: owned ? record!.generation : 0,
    pid: e.pid,
    grpcPort: e.grpcPort,
    adbSerial: e.adbSerial,
    ownedByPpm: owned,
  };
}

function toEntry(avd: AvdSummary, e: RunningEmulator | undefined, ownership: OwnershipRecord[]): DeviceEntry {
  return {
    avdId: avd.avdId,
    name: avd.name,
    apiLevel: avd.apiLevel,
    abi: avd.abi,
    deviceProfile: avd.deviceProfile,
    displayWidth: avd.displayWidth,
    displayHeight: avd.displayHeight,
    hardwareKeyboard: avd.hardwareKeyboard,
    lockedByAnotherProcess: avd.lockedByAnotherProcess && !e,
    state: e ? "ready" : "stopped",
    runtime: e ? runtimeOf(e, ownership) : null,
  };
}

export function findDeviceByAvdId(avdHome: string, avdId: string): DeviceEntry | null {
  return listDevices(avdHome).find((d) => d.avdId === avdId) ?? null;
}

/**
 * Resolve a runtime device id back to the live emulator it names.
 *
 * Goes to discovery rather than to `listDevices`, because the WS session needs no AVD home and
 * must not depend on one being resolvable: the id is `pid:grpcPort`, and the pid being alive with
 * that port is the whole claim. An emulator that has restarted has a new id, so a stale id simply
 * finds nothing — which is the behaviour a client holding an old session wants.
 */
export function findRunningByDeviceId(deviceId: string): RunningEmulator | null {
  return findRunningEmulators().find((e) => `${e.pid}:${e.grpcPort}` === deviceId) ?? null;
}
