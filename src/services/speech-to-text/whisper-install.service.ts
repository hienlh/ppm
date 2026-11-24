/**
 * Installing Whisper on the host: download the prebuilt whisper.cpp for this
 * platform, the chosen speech model, and the VAD model, then prove the binary
 * actually runs here.
 *
 * That last step is not ceremony. The published Linux build needs glibc 2.34
 * and libstdc++ from GCC 11, so on an older host (Ubuntu 20.04 ships glibc
 * 2.31) every file downloads fine and the binary only fails when someone first
 * speaks into the chat box. Running `--help` once at install time turns that
 * into an install error naming the cause.
 *
 * One model is kept on disk at a time: they are 60–574 MB, and "which one is
 * active" then has no state to drift — it is whichever file is there.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_MODEL_ID,
  MACOS_INSTALL_HINT,
  VAD_MODEL,
  WHISPER_MODELS,
  WHISPER_VERSION,
  modelById,
  modelUrl,
  vadModelUrl,
  whisperAssetFor,
  whisperBuildAsset,
  type WhisperAsset,
  type WhisperBuildKind,
} from "./whisper-catalog.ts";
import { downloadVerified, type FetchFn } from "./whisper-download.ts";
import { forgetProbe, installedBuild, probeWhisperBackend } from "./whisper-gpu-state.ts";
import { whisperBusy, withWhisperLock } from "./whisper-run-lock.ts";
import {
  findBundledBinary,
  findWhisperBinary,
  whisperBinDir,
  whisperDir,
  whisperModelDir,
  whisperTmpDir,
  type WhisperBinary,
} from "./whisper-paths.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("whisper");

export type InstallPhase = "binary" | "model" | "vad" | "verify" | "gpu";

export interface InstallJobState {
  modelId: string;
  /** The whisper.cpp build this install puts in place; a host's own whisper-cli keeps `system`. */
  build: WhisperBuildKind | "system";
  phase: InstallPhase;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error: string | null;
}

export interface WhisperStatusModel {
  id: string;
  label: string;
  note: string;
  bytes: number;
}

export interface WhisperStatus {
  /** False only when this platform has no prebuilt build AND no binary on the host. */
  installable: boolean;
  /** Manual command for a platform PPM cannot install for (macOS). */
  installHint: string | null;
  binary: WhisperBinary | null;
  version: string;
  /** Model currently on disk, if any. */
  model: WhisperStatusModel | null;
  /** Binary + model + VAD model all present — the mic can use it. */
  ready: boolean;
  models: WhisperStatusModel[];
  install: InstallJobState | null;
  /** Download size of this platform's CPU build, for the CPU / GPU choice; null when there is none. */
  cpuBuildBytes: number | null;
}

let currentJob: InstallJobState | null = null;

const publicModel = (m: (typeof WHISPER_MODELS)[number]): WhisperStatusModel => ({
  id: m.id,
  label: m.label,
  note: m.note,
  bytes: m.bytes,
});

/** The installed model, found by which catalog file exists on disk. */
export function installedModel(): (typeof WHISPER_MODELS)[number] | null {
  return WHISPER_MODELS.find((m) => existsSync(resolve(whisperModelDir(), m.file))) ?? null;
}

export function vadModelPath(): string {
  return resolve(whisperModelDir(), VAD_MODEL.file);
}

export function getWhisperStatus(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): WhisperStatus {
  const binary = findWhisperBinary(platform);
  const model = installedModel();
  const asset = whisperAssetFor(platform, arch);
  const hasAsset = asset !== null;

  return {
    installable: hasAsset || binary !== null,
    installHint: !hasAsset && platform === "darwin" ? MACOS_INSTALL_HINT : null,
    binary,
    version: WHISPER_VERSION,
    model: model ? publicModel(model) : null,
    ready: binary !== null && model !== null && existsSync(vadModelPath()),
    models: WHISPER_MODELS.map(publicModel),
    install: currentJob,
    cpuBuildBytes: asset?.bytes ?? null,
  };
}

async function extractArchive(archive: string, asset: WhisperAsset, destDir: string, platform: NodeJS.Platform) {
  const cmd =
    asset.ext === "tar.gz"
      ? ["tar", "-xzf", archive, "-C", destDir]
      : platform === "win32"
        ? // Windows 10+ ships bsdtar as tar.exe, which reads zip.
          ["tar", "-xf", archive, "-C", destDir]
        : ["unzip", "-o", "-q", archive, "-d", destDir];

  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`extract failed (${cmd[0]} exit ${code}): ${stderr.slice(0, 200)}`);
  }
}

/** Run the binary once so a host that cannot execute it fails here, not mid-sentence. */
async function verifyBinaryRuns(path: string): Promise<void> {
  let proc;
  try {
    proc = Bun.spawn({ cmd: [path, "--help"], stdout: "ignore", stderr: "pipe", windowsHide: true });
  } catch (e: any) {
    throw new Error(`whisper-cli could not be started: ${e?.message ?? e}`);
  }
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    const detail = stderr.trim().split("\n")[0] ?? `exit ${code}`;
    throw new Error(`whisper-cli does not run on this host: ${detail}`);
  }
}

/** Keep only the model just installed — the others are hundreds of MB of nothing. */
function pruneOtherModels(keepFile: string) {
  for (const m of WHISPER_MODELS) {
    if (m.file !== keepFile) rmSync(resolve(whisperModelDir(), m.file), { force: true });
  }
}

/**
 * A model already on disk at its pinned size is kept: switching between the CPU and the CUDA
 * build must not download 574 MB again. Its hash was checked when it was written, and only a
 * verified download is ever renamed into place.
 */
function alreadyOnDisk(path: string, bytes: number): boolean {
  try { return statSync(path).size === bytes; } catch { return false; }
}

/**
 * Put the unpacked build at `staging` where the old one was. Under the run lock, because Windows
 * cannot move a directory whose `whisper-cli.exe` is running; the old build is set aside first
 * and put back if the new one cannot be moved in.
 */
function swapInBuild(staging: string): Promise<void> {
  return withWhisperLock(async () => {
    const bin = whisperBinDir();
    const old = `${bin}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(bin)) renameSync(bin, old);
    try {
      renameSync(staging, bin);
    } catch (e) {
      if (existsSync(old)) renameSync(old, bin);
      throw e;
    }
    rmSync(old, { recursive: true, force: true });
    forgetProbe();
  });
}

/**
 * The build an install puts in place: the one asked for, else the one already there (switching
 * models keeps a CUDA build), else the CPU build. A host's own whisper-cli is never replaced.
 */
export function resolveInstallBuild(
  requested: WhisperBuildKind | undefined, current: WhisperBuildKind | "system" | null,
): WhisperBuildKind | "system" {
  if (current === "system") return "system";
  return requested ?? current ?? "cpu";
}

async function runInstall(
  modelId: string, build: WhisperBuildKind | "system", platform: NodeJS.Platform, arch: string, fetchFn?: FetchFn,
) {
  const model = modelById(modelId);
  if (!model) throw new Error(`unknown model: ${modelId}`);
  const job = currentJob!;
  const progress = (received: number, total: number) => {
    job.receivedBytes = received;
    job.totalBytes = total || 0;
  };

  mkdirSync(whisperModelDir(), { recursive: true });

  // A host that already has whisper-cli (Homebrew, distro package) needs models only. A bundled
  // build of the other kind is replaced, and never left half-replaced: the new archive is
  // downloaded, checked, unpacked beside the old build and run once before the two swap places.
  const existing = findWhisperBinary(platform);
  if (build !== "system" && (!existing || installedBuild(existing) !== build)) {
    const asset = whisperBuildAsset(build, platform, arch);
    if (!asset) throw new Error(`no whisper.cpp ${build} build for ${platform}/${arch} — install it manually`);
    job.phase = "binary";
    mkdirSync(whisperTmpDir(), { recursive: true });
    const archive = resolve(whisperTmpDir(), asset.file);
    await downloadVerified({ url: asset.url, dest: archive, sha256: asset.sha256, onProgress: progress, fetchFn });
    const staging = `${whisperBinDir()}.new`;
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      await extractArchive(archive, asset, staging, platform);
      const staged = findBundledBinary(platform, staging);
      if (!staged) throw new Error("whisper-cli missing from the downloaded build");
      job.phase = "verify";
      await verifyBinaryRuns(staged);
      await swapInBuild(staging);
    } finally {
      rmSync(archive, { force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }

  const modelPath = resolve(whisperModelDir(), model.file);
  if (!alreadyOnDisk(modelPath, model.bytes)) {
    job.phase = "model";
    progress(0, model.bytes);
    await downloadVerified({ url: modelUrl(model), dest: modelPath, sha256: model.sha256, onProgress: progress, fetchFn });
  }

  if (!alreadyOnDisk(vadModelPath(), VAD_MODEL.bytes)) {
    job.phase = "vad";
    progress(0, VAD_MODEL.bytes);
    await downloadVerified({ url: vadModelUrl(), dest: vadModelPath(), sha256: VAD_MODEL.sha256, onProgress: progress, fetchFn });
  }

  job.phase = "verify";
  const binary = findWhisperBinary(platform);
  if (!binary) throw new Error("whisper-cli missing after install");
  await verifyBinaryRuns(binary.path);

  pruneOtherModels(model.file);

  // A build that may use a GPU is asked which one it uses now, so Settings can say so at once.
  // A probe that fails does not fail the install: the build still runs, on the CPU.
  if (installedBuild(binary) !== "cpu") {
    job.phase = "gpu";
    await probeWhisperBackend(binary, modelPath).catch(() => {});
  }
}

/**
 * Start an install in the background and return immediately — the UI polls
 * `getWhisperStatus()`. One at a time: a second call while a job runs throws.
 */
export function startWhisperInstall(
  modelId: string = DEFAULT_MODEL_ID,
  opts: { platform?: NodeJS.Platform; arch?: string; fetchFn?: FetchFn; build?: WhisperBuildKind } = {},
): InstallJobState {
  if (currentJob && !currentJob.done) throw new Error("An install is already running");
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (!modelById(modelId)) throw new Error(`unknown model: ${modelId}`);

  // The lookup `runInstall` starts with: a host that already has whisper-cli downloads models only.
  let existing: WhisperBinary | null = null;
  try { existing = findWhisperBinary(platform); } catch { /* runInstall meets the same error and reports it */ }
  const build = resolveInstallBuild(opts.build, installedBuild(existing));
  if (build !== "system" && !whisperBuildAsset(build, platform, arch)) {
    throw new Error(`whisper.cpp publishes no ${build} build for ${platform}/${arch}`);
  }

  const job: InstallJobState = {
    modelId,
    build,
    phase: "binary",
    receivedBytes: 0,
    totalBytes: 0,
    done: false,
    error: null,
  };
  currentJob = job;

  const downloadsBinary = build !== "system" && installedBuild(existing) !== build;
  const startedAt = Date.now();
  log.info(
    `install started: model=${modelId} ${platform}/${arch}, ` +
    (downloadsBinary ? `downloading whisper.cpp ${WHISPER_VERSION} (${build})` : `using ${existing!.source} whisper-cli ${existing!.path}`),
  );
  runInstall(modelId, build, platform, arch, opts.fetchFn)
    .then(() => {
      job.done = true;
      log.info(`installed ${downloadsBinary ? `whisper.cpp ${WHISPER_VERSION} (${build}) + ` : ""}model ${modelId} in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
    })
    .catch((e: any) => {
      job.error = e?.message ?? String(e);
      job.done = true;
      log.error(`install failed (phase=${job.phase}):`, job.error);
    });

  return job;
}

/** Remove everything PPM downloaded. A system-installed whisper-cli is left alone. */
export function uninstallWhisper(): void {
  if (currentJob && !currentJob.done) throw new Error("An install is running");
  // A running whisper-cli (a transcription, a GPU check) holds files Windows will not delete, and a
  // check finishing afterwards would write its result into a folder that is gone.
  if (whisperBusy()) throw new Error("Whisper is running; try again in a moment");
  rmSync(whisperDir(), { recursive: true, force: true });
  currentJob = null;
}

/** Test seam: forget any finished job so a suite starts from a clean status. */
export function _resetWhisperInstallState(): void {
  currentJob = null;
}
