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
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
  type WhisperAsset,
} from "./whisper-catalog.ts";
import { downloadVerified, type FetchFn } from "./whisper-download.ts";
import {
  findWhisperBinary,
  whisperBinDir,
  whisperDir,
  whisperModelDir,
  whisperTmpDir,
  type WhisperBinary,
} from "./whisper-paths.ts";

export type InstallPhase = "binary" | "model" | "vad" | "verify";

export interface InstallJobState {
  modelId: string;
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
  const hasAsset = whisperAssetFor(platform, arch) !== null;

  return {
    installable: hasAsset || binary !== null,
    installHint: !hasAsset && platform === "darwin" ? MACOS_INSTALL_HINT : null,
    binary,
    version: WHISPER_VERSION,
    model: model ? publicModel(model) : null,
    ready: binary !== null && model !== null && existsSync(vadModelPath()),
    models: WHISPER_MODELS.map(publicModel),
    install: currentJob,
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

async function runInstall(modelId: string, platform: NodeJS.Platform, arch: string, fetchFn?: FetchFn) {
  const model = modelById(modelId);
  if (!model) throw new Error(`unknown model: ${modelId}`);
  const job = currentJob!;
  const progress = (received: number, total: number) => {
    job.receivedBytes = received;
    job.totalBytes = total || 0;
  };

  mkdirSync(whisperModelDir(), { recursive: true });

  // A host that already has whisper-cli (Homebrew, distro package) needs models only.
  if (!findWhisperBinary(platform)) {
    const asset = whisperAssetFor(platform, arch);
    if (!asset) throw new Error(`no whisper.cpp build for ${platform}/${arch} — install it manually`);
    job.phase = "binary";
    mkdirSync(whisperBinDir(), { recursive: true });
    mkdirSync(whisperTmpDir(), { recursive: true });
    const archive = resolve(whisperTmpDir(), asset.file);
    await downloadVerified({ url: asset.url, dest: archive, sha256: asset.sha256, onProgress: progress, fetchFn });
    await extractArchive(archive, asset, whisperBinDir(), platform);
    rmSync(archive, { force: true });
  }

  job.phase = "model";
  progress(0, model.bytes);
  await downloadVerified({
    url: modelUrl(model),
    dest: resolve(whisperModelDir(), model.file),
    sha256: model.sha256,
    onProgress: progress,
    fetchFn,
  });

  job.phase = "vad";
  progress(0, VAD_MODEL.bytes);
  await downloadVerified({
    url: vadModelUrl(),
    dest: vadModelPath(),
    sha256: VAD_MODEL.sha256,
    onProgress: progress,
    fetchFn,
  });

  job.phase = "verify";
  const binary = findWhisperBinary(platform);
  if (!binary) throw new Error("whisper-cli missing after install");
  await verifyBinaryRuns(binary.path);

  pruneOtherModels(model.file);
}

/**
 * Start an install in the background and return immediately — the UI polls
 * `getWhisperStatus()`. One at a time: a second call while a job runs throws.
 */
export function startWhisperInstall(
  modelId: string = DEFAULT_MODEL_ID,
  opts: { platform?: NodeJS.Platform; arch?: string; fetchFn?: FetchFn } = {},
): InstallJobState {
  if (currentJob && !currentJob.done) throw new Error("An install is already running");
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (!modelById(modelId)) throw new Error(`unknown model: ${modelId}`);

  const job: InstallJobState = {
    modelId,
    phase: "binary",
    receivedBytes: 0,
    totalBytes: 0,
    done: false,
    error: null,
  };
  currentJob = job;

  runInstall(modelId, platform, arch, opts.fetchFn)
    .then(() => {
      job.done = true;
    })
    .catch((e: any) => {
      job.error = e?.message ?? String(e);
      job.done = true;
      console.error("[whisper] install failed:", job.error);
    });

  return job;
}

/** Remove everything PPM downloaded. A system-installed whisper-cli is left alone. */
export function uninstallWhisper(): void {
  if (currentJob && !currentJob.done) throw new Error("An install is running");
  rmSync(whisperDir(), { recursive: true, force: true });
  currentJob = null;
}

/** Test seam: forget any finished job so a suite starts from a clean status. */
export function _resetWhisperInstallState(): void {
  currentJob = null;
}
