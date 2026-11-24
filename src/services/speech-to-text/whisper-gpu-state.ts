/**
 * Whisper's GPU on this host: the "Use GPU" switch, what the installed whisper-cli was seen to
 * run on, the last time a GPU run failed, and the status Settings shows.
 *
 * Kept in `<ppm dir>/whisper/gpu.json`, beside the binary it describes: removing Whisper removes
 * it too, and a reinstall starts from "use the GPU if there is one" and a fresh probe.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { whisperGpuAssetFor, type WhisperBuildKind } from "./whisper-catalog.ts";
import { detectNvidiaGpu, parseWhisperBackend, type NvidiaGpu, type WhisperBackend } from "./whisper-gpu-detect.ts";
import { findWhisperBinary, whisperDir, whisperTmpDir, type WhisperBinary } from "./whisper-paths.ts";
import { withWhisperLock } from "./whisper-run-lock.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("whisper");

export interface WhisperProbe {
  /** The binary this was learned from: a reinstall or a Homebrew upgrade at another path asks again. */
  binary: string;
  /** And its build: both PPM builds unpack to the same path, so the path alone cannot tell them apart. */
  build?: WhisperBuildKind | "system" | null;
  backend: WhisperBackend;
  device: string | null;
  at: string;
  /** Set when the probe run itself failed, so the backend is a guess ("none"). */
  error?: string;
}

interface GpuFile {
  useGpu?: boolean;
  probe?: WhisperProbe;
  lastFailure?: { at: string; message: string };
}

const stateFile = () => resolve(whisperDir(), "gpu.json");

function readState(): GpuFile {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(patch: Partial<GpuFile>, drop: (keyof GpuFile)[] = []): void {
  const next: GpuFile = { ...readState(), ...patch };
  for (const key of drop) delete next[key];
  mkdirSync(whisperDir(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(next, null, 2));
}

/** The "Use GPU" switch. On unless the user turned it off. */
export function gpuPreference(): boolean {
  return readState().useGpu !== false;
}

export function setGpuPreference(on: boolean): void {
  writeState({ useGpu: on });
}

/** A GPU run failed and the message was transcribed again on the CPU. */
export function recordGpuFailure(message: string): void {
  writeState({ lastFailure: { at: new Date().toISOString(), message: message.slice(0, 300) } });
}

/** What `binary` was last seen to run on, or null when it has not been asked. */
export function probeFor(binary: WhisperBinary): WhisperProbe | null {
  const probe = readState().probe;
  return probe && probe.binary === binary.path && probe.build === installedBuild(binary) ? probe : null;
}

/** Forget the probe and any failure: the binary changed, so both describe something gone. */
export function forgetProbe(): void {
  if (existsSync(stateFile())) writeState({}, ["probe", "lastFailure"]);
}

/** The build PPM installed, read from the files: the CUDA archive is the one with a CUDA backend. */
export function installedBuild(binary: WhisperBinary | null): WhisperBuildKind | "system" | null {
  if (!binary) return null;
  if (binary.source === "system") return "system";
  const dir = dirname(binary.path);
  return existsSync(resolve(dir, "ggml-cuda.dll")) || existsSync(resolve(dir, "libggml-cuda.so")) ? "cuda" : "cpu";
}

/** One second of 16 kHz mono silence: enough for whisper-cli to load the model and pick a backend. */
export function silentWav(seconds = 1, rate = 16_000): Uint8Array {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buf);
}

const PROBE_TIMEOUT_MS = 120_000;
let probing: Promise<WhisperProbe> | null = null;

/**
 * Run `binary` once over a second of silence, without `-np`, and read which backend it chose.
 * One at a time; the answer is stored for `probeFor` and clears the last failure, since it is a
 * fresh look at the same GPU.
 */
export function probeWhisperBackend(installed: WhisperBinary, modelPath: string): Promise<WhisperProbe> {
  if (probing) return probing;
  const binary = installed.path;
  const build = installedBuild(installed);
  // Through the run lock: never beside a transcription (they would share the GPU's memory) and
  // never while the build is being swapped or removed.
  probing = withWhisperLock(async (): Promise<WhisperProbe> => {
    mkdirSync(whisperTmpDir(), { recursive: true });
    const wav = resolve(whisperTmpDir(), `probe-${randomUUID()}.wav`);
    await Bun.write(wav, silentWav());
    const started = Date.now();
    let probe: WhisperProbe;
    try {
      const proc = Bun.spawn({
        cmd: [binary, "-m", modelPath, "-f", wav, "-l", "en", "-nt"],
        stdout: "ignore", stderr: "pipe", stdin: "ignore", windowsHide: true,
      });
      const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      const seen = parseWhisperBackend(stderr);
      const at = new Date().toISOString();
      probe = seen
        ? { binary, build, ...seen, at, ...(code === 0 ? {} : { error: `exit ${code}` }) }
        : { binary, build, backend: "none", device: null, at, error: stderr.trim().split("\n").at(-1)?.slice(0, 200) || `exit ${code}` };
    } catch (e) {
      probe = { binary, build, backend: "none", device: null, at: new Date().toISOString(), error: (e as Error).message };
    } finally {
      rmSync(wav, { force: true });
    }
    // Removed while waiting for the lock: writing now would bring back a `gpu.json` for nothing.
    if (existsSync(whisperDir())) writeState({ probe }, ["lastFailure"]);
    log.info(`whisper-cli runs on ${probe.backend}${probe.device ? ` (${probe.device})` : ""} — checked in ${Date.now() - started} ms${probe.error ? `; probe failed: ${probe.error}` : ""}`);
    return probe;
  }).finally(() => { probing = null; });
  return probing;
}

/** Whether a probe is running or waiting for its turn. */
export function probeRunning(): boolean {
  return probing !== null;
}

export interface WhisperGpuStatus {
  /** The CUDA build, when this platform has one AND this host has an NVIDIA card that can load it. */
  cudaBuild: { bytes: number; unpackedBytes: number } | null;
  /** The NVIDIA card the driver reports, whatever its CUDA version. */
  nvidia: NvidiaGpu | null;
  installedBuild: WhisperBuildKind | "system" | null;
  /** What the installed whisper-cli was seen to run on; null until it has been checked. */
  backend: WhisperBackend | null;
  device: string | null;
  checkedAt: string | null;
  probeError: string | null;
  probing: boolean;
  useGpu: boolean;
  lastFailure: { at: string; message: string } | null;
}

/**
 * The GPU half of Whisper's status. With Whisper installed but never probed (installed by an
 * older PPM, or Homebrew upgraded it) this starts a probe in the background — `probing` tells
 * the pane to ask again shortly.
 */
export async function whisperGpuStatus(
  opts: { platform?: NodeJS.Platform; arch?: string; modelPath?: string | null } = {},
): Promise<WhisperGpuStatus> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = whisperGpuAssetFor(platform, arch);
  const nvidia = asset ? await detectNvidiaGpu() : null;
  const binary = findWhisperBinary(platform);
  const build = installedBuild(binary);
  let probe = binary ? probeFor(binary) : null;
  if (binary && !probe && opts.modelPath && !probing) {
    // A CPU build PPM installed cannot use a GPU; only a build that might is worth a run.
    if (build === "cpu") {
      probe = { binary: binary.path, build, backend: "none", device: null, at: new Date().toISOString() };
      writeState({ probe });
    } else {
      void probeWhisperBackend(binary, opts.modelPath).catch(() => {});
    }
  }
  const state = readState();
  return {
    cudaBuild: asset && nvidia?.supportsCudaBuild ? { bytes: asset.bytes, unpackedBytes: asset.unpackedBytes } : null,
    nvidia,
    installedBuild: build,
    backend: probe?.backend ?? null,
    device: probe?.device ?? null,
    checkedAt: probe?.at ?? null,
    probeError: probe?.error ?? null,
    probing: probing !== null,
    useGpu: state.useGpu !== false,
    lastFailure: state.lastFailure ?? null,
  };
}
