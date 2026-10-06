/**
 * Installing the WebRTC relay: download the pinned MediaMTX archive, verify its SHA-256,
 * unpack it into `<ppm dir>/mediamtx/bin`, and prove the binary actually runs before calling
 * it installed.
 *
 * The last step is not ceremony. `Bun.spawn` **throws** on a missing or unrunnable binary
 * rather than reporting it (CLAUDE.md), and a host that unpacked a build it cannot execute —
 * wrong libc, quarantined by Gatekeeper, noexec mount — would otherwise be reported as
 * installed and fail later at session start, where the user has no way to connect the two.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { downloadVerified, type FetchFn } from "../speech-to-text/whisper-download.ts";
import { mediamtxAsset, MEDIAMTX_VERSION, type MediamtxAsset } from "./mediamtx-catalog.ts";
import { activeRelayCount } from "./mediamtx-process.ts";
import {
  findMediamtxBinary, mediamtxBinDir, mediamtxBinaryName, mediamtxDir, mediamtxTmpDir,
} from "./mediamtx-paths.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("remote-desktop");

export interface MediamtxStatus {
  installed: boolean;
  /** Absolute path when installed. */
  path?: string;
  source?: "bundled" | "system";
  /** The version PPM pins — not what a `system` copy happens to be. */
  pinnedVersion: string;
  /** Null when the release publishes no build for this host; it can still bring its own. */
  available: boolean;
}

export function mediamtxStatus(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): MediamtxStatus {
  const found = findMediamtxBinary(platform);
  return {
    installed: !!found,
    path: found?.path,
    source: found?.source,
    pinnedVersion: MEDIAMTX_VERSION,
    available: mediamtxAsset(platform, arch) !== null,
  };
}

async function extractArchive(
  archive: string, asset: MediamtxAsset, destDir: string, platform: NodeJS.Platform,
): Promise<void> {
  const cmd =
    asset.ext === "tar.gz"
      ? ["tar", "-xzf", archive, "-C", destDir]
      : platform === "win32"
        // Windows 10+ ships bsdtar as tar.exe, which reads zip.
        ? ["tar", "-xf", archive, "-C", destDir]
        : ["unzip", "-o", "-q", archive, "-d", destDir];
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`extract failed (${cmd[0]} exit ${code}): ${stderr.slice(0, 200)}`);
}

/**
 * `ReturnType<typeof Bun.spawn>` would widen `stdout`/`stderr` back to a union including a raw
 * fd, which `new Response()` rejects — so the narrow type is preserved by naming the call
 * (CLAUDE.md, the same trap `gpu-collector-nvidia.ts` hit).
 */
const spawnVersionProbe = (path: string) =>
  Bun.spawn({ cmd: [path, "--version"], stdout: "pipe", stderr: "pipe", windowsHide: true });

/** Run `--version` and require it to exit cleanly. Throws with the host's own words if not. */
async function proveItRuns(path: string): Promise<string> {
  let proc: ReturnType<typeof spawnVersionProbe>;
  try {
    proc = spawnVersionProbe(path);
  } catch (e: any) {
    // Bun.spawn raises synchronously here, so this cannot be folded into the await below.
    throw new Error(`mediamtx could not be started: ${e?.message ?? e}`);
  }
  const [code, out, err] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`mediamtx exited ${code}: ${(err || out).slice(0, 200)}`);
  return out.trim() || err.trim();
}

export interface RelayInstallJob {
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error: string | null;
}

let currentJob: RelayInstallJob | null = null;

/**
 * Start an install in the background and return immediately — the UI polls `relayStatus()`.
 * One at a time: a second call while a job runs throws rather than racing two downloads onto
 * the same `.part` file.
 */
export function startMediamtxInstall(opts: InstallOptions = {}): RelayInstallJob {
  if (currentJob && !currentJob.done) throw new Error("An install is already running");
  const job: RelayInstallJob = { receivedBytes: 0, totalBytes: 0, done: false, error: null };
  currentJob = job;
  log.info(`relay install started version=${MEDIAMTX_VERSION}`);
  installMediamtx({
    ...opts,
    onProgress: (received, total) => { job.receivedBytes = received; job.totalBytes = total; },
  })
    .then((version) => {
      job.done = true;
      // No path: an install always lands in `<ppm dir>/mediamtx/bin`.
      log.info(`relay installed version=${version.slice(0, 40)}`);
    })
    .catch((e: any) => {
      job.error = e?.message ?? String(e);
      job.done = true;
      log.error("relay install failed:", e);
    });
  return job;
}

/** Status plus whatever install is in flight, which is what the Settings pane renders. */
export function relayStatus(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): MediamtxStatus & { job: RelayInstallJob | null } {
  return { ...mediamtxStatus(platform, arch), job: currentJob };
}

/** Test seam: forget any finished job so a suite starts from a clean status. */
export function _resetRelayInstallState(): void {
  currentJob = null;
}

export interface InstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  onProgress?: (received: number, total: number) => void;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
}

/** Download, verify, unpack and prove. Returns the version string the binary reports. */
export async function installMediamtx(opts: InstallOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = mediamtxAsset(platform, arch);
  if (!asset) {
    throw new Error(
      `MediaMTX publishes no build for ${platform}-${arch}. Install it yourself and put it on PATH.`,
    );
  }

  const tmp = mediamtxTmpDir();
  const binDir = mediamtxBinDir();
  mkdirSync(tmp, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const archive = resolve(tmp, asset.file);
  await downloadVerified({
    url: asset.url, dest: archive, sha256: asset.sha256,
    onProgress: opts.onProgress, fetchFn: opts.fetchFn, signal: opts.signal,
  });

  try {
    await extractArchive(archive, asset, binDir, platform);
  } finally {
    rmSync(archive, { force: true });
  }

  const binary = resolve(binDir, mediamtxBinaryName(platform));
  if (!existsSync(binary)) throw new Error(`archive did not contain ${mediamtxBinaryName(platform)}`);
  if (platform !== "win32") chmodSync(binary, 0o755);

  // The archive also carries its own mediamtx.yml, which listens on every interface and turns
  // on RTMP/HLS/SRT/MoQ. PPM generates its own config and must never fall back to that one.
  rmSync(resolve(binDir, "mediamtx.yml"), { force: true });

  return await proveItRuns(binary);
}

/**
 * Remove everything PPM installed. A `system` copy is the host's and is left alone.
 *
 * Takes the whole `mediamtx/` directory, not just `bin/`: the per-session configs and the tmp
 * dir are PPM's too, and both are rebuilt on the next start.
 */
export function uninstallMediamtx(platform: NodeJS.Platform = process.platform): boolean {
  if (currentJob && !currentJob.done) throw new Error("An install is running");
  // Windows cannot delete a running executable, so removing the folder under a live relay would
  // fail part-way through it.
  if (activeRelayCount() > 0) throw new Error("A Remote Desktop session is using the relay; end it first");
  const found = findMediamtxBinary(platform);
  if (found?.source !== "bundled") return false;
  rmSync(mediamtxDir(), { recursive: true, force: true });
  currentJob = null;
  log.info("relay uninstalled");
  return true;
}
