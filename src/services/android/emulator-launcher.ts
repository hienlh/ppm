/**
 * Starting and stopping emulators PPM owns.
 *
 * Four things here are load-bearing and each one is in the plan for a reason:
 *
 *  - **One start per AVD at a time.** A refresh, a double-tap on Start, or two browser tabs must
 *    not spawn two emulators against one AVD — that corrupts the userdata image. A per-AVD mutex
 *    plus start idempotency (an in-flight start is *returned*, not duplicated) is what prevents it.
 *  - **Never `-grpc <port>`.** `emulator -help` says `-grpc-use-jwt ... (default, disable with
 *    -grpc flag)`, so pinning a port silently drops the control channel to unauthenticated.
 *    The port is discovered from the emulator's own advertisement instead.
 *  - **`ANDROID_AVD_HOME` goes in the child's env only.** Setting it on this process would hide
 *    every AVD outside it from our own listing — it replaces the default rather than adding to it.
 *  - **A lock file is reported, never removed.** An AVD Android Studio is running stays untouched.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectToEmulator, getEmulatorStatus, requestShutdown } from "./android-grpc.ts";
import { findRunningEmulatorByAvd, findRunningEmulators, type RunningEmulator } from "./emulator-discovery.ts";
import { claimOwnership, listDevices, releaseOwnership } from "./device-registry.ts";
import { createOperation, failOperation, finishOperation, updateOperation, type Operation } from "./android-operations.ts";
import { avdHomeEnv } from "./sdk-discovery.ts";

/** How long to wait for the guest to report boot complete before calling it failed. */
const DEFAULT_BOOT_DEADLINE_MS = 5 * 60_000;
/** How often to ask. Cheap: a getStatus is sub-millisecond once the channel is up. */
const BOOT_POLL_MS = 1_000;
/** Emulator stderr/stdout kept for diagnostics. Bounded: a boot loop can log without end. */
const LOG_RING_LINES = 200;

export interface StartOptions {
  avdName: string;
  avdHome: string;
  emulatorPath: string;
  /** Extra flags the caller has already validated. Passed as argv, never through a shell. */
  extraArgs?: string[];
  bootDeadlineMs?: number;
  /** Run without a visible window. `qt-hide-window` still creates one (and needs a display). */
  windowMode?: "no-window" | "qt-hide-window" | "window";
  gpuMode?: string;
  /**
   * Quick boot resumes the saved snapshot and saves one on exit; cold boot ignores any snapshot
   * and boots the guest from scratch.
   *
   * Neither touches user data — that is what **wipe** is for, and conflating the two is how a
   * "boot fresh" button ends up deleting somebody's app state. A cold boot is minutes; a quick
   * boot is seconds, which is why it is the default.
   */
  bootMode?: "quick" | "cold";
  /**
   * How many emulators this host may run at once, starts still booting included. Counted here
   * because only here is the count in the same synchronous step as the reservation below: a
   * caller that counts, awaits, then starts lets two requests for two different AVDs both see
   * the same free slot.
   */
  maxConcurrent?: number;
}

/** A start refused because the host is already at `maxConcurrent`. */
export class EmulatorLimitError extends Error {
  constructor(readonly busy: number, readonly limit: number) {
    super(`already running or starting ${busy} emulator(s); the limit for this host is ${limit}`);
  }
}

export interface StartedDevice {
  avdName: string;
  pid: number;
  grpcPort: number;
  adbSerial: string | null;
  generation: number;
}

interface InFlight {
  operation: Operation<StartedDevice>;
  promise: Promise<StartedDevice>;
}

/** One entry per AVD name while a start is running — this *is* the mutex. */
const starting = new Map<string, InFlight>();
/** Bounded log of what each emulator printed, for the error surface. */
const logs = new Map<string, string[]>();

export function emulatorLog(avdName: string): string[] {
  return logs.get(avdName) ?? [];
}

function appendLog(avdName: string, chunk: string): void {
  const ring = logs.get(avdName) ?? [];
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    ring.push(line);
    if (ring.length > LOG_RING_LINES) ring.shift();
  }
  logs.set(avdName, ring);
}

/** The env the *child* gets. Shared with the SDK tools, which need the same treatment. */
const childEnv = avdHomeEnv;

/** Exported for tests: the flag set is a decision, and `-grpc`'s absence is load-bearing. */
export function buildArgs(opts: StartOptions): string[] {
  const args = ["-avd", opts.avdName];
  switch (opts.windowMode ?? "no-window") {
    case "no-window": args.push("-no-window"); break;
    case "qt-hide-window": args.push("-qt-hide-window"); break;
    case "window": break;
  }
  args.push("-no-boot-anim");
  // `-no-snapshot-load` only refuses to *resume* one; the guest's disk is untouched either way.
  if ((opts.bootMode ?? "quick") === "cold") args.push("-no-snapshot-load");
  if (opts.gpuMode) args.push("-gpu", opts.gpuMode);
  // Deliberately absent: `-grpc <port>`. See the file header.
  for (const extra of opts.extraArgs ?? []) args.push(extra);
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll discovery until this AVD advertises a gRPC endpoint, or the deadline passes. */
async function waitForAdvertisement(avdName: string, deadline: number): Promise<RunningEmulator> {
  while (Date.now() < deadline) {
    const found = findRunningEmulatorByAvd(avdName);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`emulator for ${avdName} never advertised a gRPC endpoint`);
}

/** Poll the guest until it reports boot complete. */
async function waitForBoot(
  emulator: RunningEmulator,
  deadline: number,
  onProgress: (detail: string) => void,
): Promise<void> {
  const channel = connectToEmulator(emulator);
  const startedAt = Date.now();
  try {
    while (Date.now() < deadline) {
      try {
        const status = await getEmulatorStatus(channel);
        if (status.booted) return;
        onProgress(`booting (${Math.round((Date.now() - startedAt) / 1000)}s)`);
      } catch {
        onProgress(`waiting for control channel (${Math.round((Date.now() - startedAt) / 1000)}s)`);
      }
      await sleep(BOOT_POLL_MS);
    }
    throw new Error("guest did not report boot complete before the deadline");
  } finally {
    channel.close();
  }
}

/**
 * Start an emulator, or return the start already running for this AVD.
 *
 * Returns immediately with an operation the caller polls; a cold boot is minutes and no HTTP
 * request should be held that long.
 */
export function startEmulator(opts: StartOptions): Operation<StartedDevice> {
  const inFlight = starting.get(opts.avdName);
  if (inFlight) return inFlight.operation;   // idempotent: same operation, no second process

  const already = findRunningEmulatorByAvd(opts.avdName);
  if (already) {
    const op = createOperation<StartedDevice>("android.start", "already running");
    finishOperation(op.id, {
      avdName: opts.avdName,
      pid: already.pid,
      grpcPort: already.grpcPort,
      adbSerial: already.adbSerial,
      generation: 0,
    });
    return op;
  }

  if (opts.maxConcurrent !== undefined) {
    // A start in flight counts as much as a running emulator: it is minutes to boot, and until
    // it advertises itself discovery cannot see it.
    const busy = new Set([...findRunningEmulators().map((e) => e.avdName), ...starting.keys()]);
    if (busy.size >= opts.maxConcurrent) throw new EmulatorLimitError(busy.size, opts.maxConcurrent);
  }

  const operation = createOperation<StartedDevice>("android.start", "spawning emulator");
  const promise = run(opts, operation).finally(() => starting.delete(opts.avdName));
  starting.set(opts.avdName, { operation, promise });
  // The operation carries the outcome; an unobserved rejection here must not crash the server.
  promise.catch(() => {});
  return operation;
}

async function run(opts: StartOptions, operation: Operation<StartedDevice>): Promise<StartedDevice> {
  const deadline = Date.now() + (opts.bootDeadlineMs ?? DEFAULT_BOOT_DEADLINE_MS);
  updateOperation(operation.id, { state: "running", detail: "spawning emulator" });
  logs.delete(opts.avdName);

  if (!existsSync(opts.emulatorPath)) {
    const message = `emulator binary not found at ${opts.emulatorPath}`;
    failOperation(operation.id, message);
    throw new Error(message);
  }

  // argv, never a shell string: an AVD name or SDK path with a space or a quote in it would
  // otherwise be re-split by the shell.
  const child = spawn(opts.emulatorPath, buildArgs(opts), {
    env: childEnv(opts.avdHome),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (d: Buffer) => appendLog(opts.avdName, d.toString()));
  child.stderr?.on("data", (d: Buffer) => appendLog(opts.avdName, d.toString()));

  let spawnError: Error | null = null;
  child.on("error", (e) => { spawnError = e; });

  try {
    updateOperation(operation.id, { detail: "waiting for the emulator to advertise itself" });
    const emulator = await waitForAdvertisement(opts.avdName, deadline);

    updateOperation(operation.id, { detail: "booting" });
    await waitForBoot(emulator, deadline, (detail) => updateOperation(operation.id, { detail }));

    const generation = claimOwnership(opts.avdName, emulator.pid);
    const started: StartedDevice = {
      avdName: opts.avdName,
      pid: emulator.pid,
      grpcPort: emulator.grpcPort,
      adbSerial: emulator.adbSerial,
      generation,
    };
    finishOperation(operation.id, started);
    return started;
  } catch (e) {
    const tail = emulatorLog(opts.avdName).slice(-6).join("\n");
    const base = spawnError ? `${(spawnError as Error).message}` : (e as Error).message;
    const message = tail ? `${base}\n${tail}` : base;
    failOperation(operation.id, message);
    throw new Error(message);
  }
}

export type StopOutcome = "stopped" | "not-running" | "not-owned";

/**
 * Stop an emulator PPM started.
 *
 * Graceful only: `setVmState SHUTDOWN` over gRPC, which measured at 1-3 seconds. Nothing here
 * signals a pid, and certainly not by process *name* — on this very host `pgrep qemu-system`
 * matches Docker Desktop.
 */
export async function stopEmulator(
  avdName: string,
  opts: { avdHome: string; requireOwnership?: boolean },
): Promise<StopOutcome> {
  const emulator = findRunningEmulatorByAvd(avdName);
  if (!emulator) {
    releaseOwnership(avdName);
    return "not-running";
  }
  if (opts.requireOwnership !== false) {
    const entry = listDevices(opts.avdHome).find((d) => d.name === avdName);
    if (entry?.runtime && !entry.runtime.ownedByPpm) return "not-owned";
  }

  const channel = connectToEmulator(emulator);
  try {
    await requestShutdown(channel);
  } finally {
    channel.close();
  }

  // Wait for the process to actually go, so the caller can report truthfully.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { process.kill(emulator.pid, 0); } catch { break; }
    await sleep(250);
  }
  releaseOwnership(avdName);
  return "stopped";
}

/** Test seam. */
export function _resetLauncher(): void {
  starting.clear();
  logs.clear();
}
