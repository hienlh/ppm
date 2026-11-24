/**
 * Which GPU this host has for Whisper, and which one a `whisper-cli` actually used.
 *
 * Two separate questions on purpose. `nvidia-smi` says whether the CUDA build is worth offering
 * (an NVIDIA card whose driver reports CUDA 12.4 or newer). Only a run of whisper-cli itself says
 * whether a GPU is in use: a CUDA build on a machine whose `ggml-cuda.dll` cannot load quietly
 * runs on the CPU, logging nothing but "no GPU found", and Homebrew's build on a Mac uses Metal
 * without PPM having downloaded anything — so the backend is read from whisper.cpp's own log.
 */
import { MIN_CUDA_VERSION } from "./whisper-catalog.ts";
import { defaultRunner, type Runner } from "../host-info/spawn-runner.ts";

export interface NvidiaGpu {
  name: string;
  driver: string;
  /** "13.3" as the driver reports it, or null when it reports none. */
  cuda: string | null;
  /** The driver is new enough for PPM's CUDA build. */
  supportsCudaBuild: boolean;
}

/**
 * The CUDA version on `nvidia-smi`'s banner. Drivers up to the 570s print `CUDA Version: 12.4`;
 * newer ones print `CUDA UMD Version: 13.3` beside a `KMD Version`, so both spellings are read.
 */
export function parseCudaVersion(banner: string): [number, number] | null {
  const m = /CUDA(?: UMD)? Version:\s*(\d+)\.(\d+)/.exec(banner);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function cudaAtLeast(version: readonly [number, number], min: readonly [number, number] = MIN_CUDA_VERSION): boolean {
  return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
}

/** First card of `--query-gpu=name,driver_version --format=csv,noheader`. */
export function parseGpuQuery(csv: string): { name: string; driver: string } | null {
  const line = csv.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const cut = line.lastIndexOf(",");
  if (cut <= 0) return null;
  const name = line.slice(0, cut).trim();
  const driver = line.slice(cut + 1).trim();
  return name && driver ? { name, driver } : null;
}

/** Ask the driver. Null when there is no NVIDIA driver (no `nvidia-smi`) or it does not answer. */
export async function queryNvidiaGpu(run: Runner = defaultRunner): Promise<NvidiaGpu | null> {
  const query = await run(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"], 5_000);
  if (query.code !== 0) return null;
  const card = parseGpuQuery(query.stdout);
  if (!card) return null;
  const banner = await run(["nvidia-smi"], 5_000);
  const cuda = banner.code === 0 ? parseCudaVersion(banner.stdout) : null;
  return {
    ...card,
    cuda: cuda ? `${cuda[0]}.${cuda[1]}` : null,
    supportsCudaBuild: cuda !== null && cudaAtLeast(cuda),
  };
}

/** A card or a driver changes rarely; an answer is reused for a while, a missing one for less. */
const FOUND_TTL_MS = 10 * 60_000;
const MISSING_TTL_MS = 60_000;

let detector: (run?: Runner) => Promise<NvidiaGpu | null> = queryNvidiaGpu;
let cached: { at: number; value: NvidiaGpu | null } | null = null;
let pending: Promise<NvidiaGpu | null> | null = null;

/** `queryNvidiaGpu`, cached, and shared between callers that ask at the same moment. */
export function detectNvidiaGpu(): Promise<NvidiaGpu | null> {
  const now = Date.now();
  if (cached && now - cached.at < (cached.value ? FOUND_TTL_MS : MISSING_TTL_MS)) return Promise.resolve(cached.value);
  if (!pending) {
    pending = detector()
      .catch(() => null)
      .then((value) => {
        cached = { at: Date.now(), value };
        pending = null;
        return value;
      });
  }
  return pending;
}

/** Test seam: replace the driver query and forget what was cached. */
export function _setNvidiaDetector(fn: ((run?: Runner) => Promise<NvidiaGpu | null>) | null): void {
  detector = fn ?? queryNvidiaGpu;
  cached = null;
  pending = null;
}

/** What a whisper-cli run used: `gpu` is a GPU backend PPM does not name (Vulkan, say). */
export type WhisperBackend = "cuda" | "metal" | "gpu" | "none";

/**
 * Read the backend from whisper.cpp's start-up log (stderr, which `-np` silences — so the probe
 * runs without it). `whisper_backend_init_gpu: using CUDA0 backend` / `using MTL0 backend`, or
 * `no GPU found`. Null when the log says neither, i.e. the run died before choosing.
 */
export function parseWhisperBackend(stderr: string): { backend: WhisperBackend; device: string | null } | null {
  const using = /whisper_backend_init_gpu: using (\S+) backend/.exec(stderr);
  if (using) {
    const name = using[1] ?? "";
    const backend: WhisperBackend = /^CUDA/i.test(name) ? "cuda" : /^(MTL|Metal)/i.test(name) ? "metal" : "gpu";
    const device =
      /Device \d+: ([^,\r\n]+),/.exec(stderr)?.[1]?.trim() ??
      /GPU name:\s*([^\r\n]+)/.exec(stderr)?.[1]?.trim() ??
      null;
    return { backend, device };
  }
  if (/whisper_backend_init_gpu: no GPU found/.test(stderr)) return { backend: "none", device: null };
  return null;
}
