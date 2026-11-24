/**
 * Drives the real CUDA build of Whisper on a host with an NVIDIA card: install the CPU build,
 * switch to the GPU build, and time the same clip through PPM's own `transcribeWav` on both, with
 * the "Use GPU" switch on and off.
 *
 * Not a `bun test` file: it downloads the 675 MB CUDA archive (plus the CPU build and, unless a
 * model is seeded, the 574 MB model) and needs an NVIDIA GPU whose driver reports CUDA 12.4+.
 *
 *   bun tests/e2e/whisper-gpu-e2e.ts
 *
 * PPM_WHISPER_SEED_MODEL=<path to ggml-large-v3-turbo-q5_0.bin> copies a model in first, so the
 * install finds it already on disk instead of downloading it (which also exercises that path).
 * PPM_WHISPER_GPU_KEEP_HOME=1 keeps the scratch PPM_HOME (printed) for a UI check afterwards;
 * otherwise it is deleted. A real install in `~/.ppm/whisper` is never touched.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-whisper-gpu-e2e-"));

const { getWhisperStatus, startWhisperInstall } = await import("../../src/services/speech-to-text/whisper-install.service.ts");
const { transcribeWav } = await import("../../src/services/speech-to-text/whisper-transcribe.service.ts");
const { setGpuPreference, silentWav, whisperGpuStatus } = await import("../../src/services/speech-to-text/whisper-gpu-state.ts");
const { whisperModelDir } = await import("../../src/services/speech-to-text/whisper-paths.ts");
const { DEFAULT_MODEL_ID, modelById } = await import("../../src/services/speech-to-text/whisper-catalog.ts");

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** Run an install to the end, returning the phases it went through. */
async function install(build: "cpu" | "cuda"): Promise<{ phases: string[]; seconds: number; error: string | null }> {
  const started = Date.now();
  const job = startWhisperInstall(DEFAULT_MODEL_ID, { build });
  const phases: string[] = [];
  while (!job.done) {
    if (phases.at(-1) !== job.phase) phases.push(job.phase);
    await Bun.sleep(100);
  }
  if (phases.at(-1) !== job.phase) phases.push(job.phase);
  return { phases, seconds: (Date.now() - started) / 1000, error: job.error };
}

/** Three runs of the clip; the first run of a build pays its disk cache, so the median is kept. */
async function time(label: string, wav: Uint8Array): Promise<number> {
  const runs: number[] = [];
  let text = "";
  for (let i = 0; i < 3; i++) {
    const out = await transcribeWav(wav, "en");
    runs.push(out.ms);
    text = out.text;
  }
  const median = [...runs].sort((a, b) => a - b)[1]!;
  console.log(`  ${label}: ${runs.join(" / ")} ms (median ${median}) -> "${text}"`);
  check(`${label}: transcript contains the sentence`, /ask not what your country/i.test(text), text);
  return median;
}

try {
  console.log(`PPM_HOME=${process.env.PPM_HOME}`);
  const seed = process.env.PPM_WHISPER_SEED_MODEL;
  if (seed) {
    mkdirSync(whisperModelDir(), { recursive: true });
    copyFileSync(seed, resolve(whisperModelDir(), modelById(DEFAULT_MODEL_ID)!.file));
    console.log(`seeded ${DEFAULT_MODEL_ID} from ${seed}`);
  }

  const first = await whisperGpuStatus();
  console.log(`\nNVIDIA: ${JSON.stringify(first.nvidia)}`);
  check("the CUDA build is offered on this host", first.cudaBuild !== null, first);

  console.log("\ninstalling the CPU build…");
  const cpu = await install("cpu");
  console.log(`  phases: ${cpu.phases.join(" → ")} (${cpu.seconds.toFixed(1)} s)`);
  check("CPU install finished without error", cpu.error === null, cpu.error);
  check("a seeded model is not downloaded again", !seed || !cpu.phases.includes("model"), cpu.phases);
  const afterCpu = await whisperGpuStatus({ modelPath: resolve(whisperModelDir(), modelById(DEFAULT_MODEL_ID)!.file) });
  check("the CPU build is recorded as CPU-only", afterCpu.installedBuild === "cpu" && afterCpu.backend === "none", afterCpu);

  const res = await fetch("https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav");
  const jfk = new Uint8Array(await res.arrayBuffer());
  console.log("\ntiming samples/jfk.wav (11 s)…");
  const cpuMs = await time("CPU build", jfk);

  console.log("\nswitching to the GPU build…");
  const gpu = await install("cuda");
  console.log(`  phases: ${gpu.phases.join(" → ")} (${gpu.seconds.toFixed(1)} s)`);
  check("GPU install finished without error", gpu.error === null, gpu.error);
  check("switching builds does not download the model again", !gpu.phases.includes("model"), gpu.phases);
  check("the GPU is checked after the install", gpu.phases.includes("gpu"), gpu.phases);
  const afterGpu = await whisperGpuStatus();
  console.log(`  probe: ${afterGpu.backend} ${afterGpu.device ?? ""}`);
  check("the CUDA build runs on CUDA", afterGpu.installedBuild === "cuda" && afterGpu.backend === "cuda", afterGpu);

  const gpuMs = await time("GPU build, Use GPU on", jfk);
  setGpuPreference(false);
  const offMs = await time("GPU build, Use GPU off (-ng)", jfk);
  setGpuPreference(true);
  check("the GPU is faster than the CPU", gpuMs * 2 < cpuMs, { gpuMs, cpuMs });
  check("turning the GPU off runs on the CPU", offMs > gpuMs * 2, { offMs, gpuMs });

  const quiet = await transcribeWav(silentWav(6), "vi");
  check("silence still transcribes to nothing on the GPU", quiet.text === "", quiet.text);
  check("no GPU failure was recorded", (await whisperGpuStatus()).lastFailure === null);
  check("status is ready", getWhisperStatus().ready);

  console.log(`\nsummary: CPU ${cpuMs} ms, GPU ${gpuMs} ms, GPU switched off ${offMs} ms (median of 3, 11 s clip)`);
} finally {
  if (process.env.PPM_WHISPER_GPU_KEEP_HOME === "1") console.log(`\nkept ${process.env.PPM_HOME}`);
  else rmSync(process.env.PPM_HOME!, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
