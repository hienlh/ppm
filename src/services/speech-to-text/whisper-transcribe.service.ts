/**
 * One transcription = one `whisper-cli` run over a temp WAV.
 *
 * Per-request process rather than a long-lived `whisper-server`, for two
 * reasons: Homebrew's formula builds with `WHISPER_BUILD_SERVER=OFF`, so a Mac
 * has no server binary to talk to; and a resident server holds the model
 * (574 MB) in RAM between sentences that are minutes apart.
 *
 * Runs are serialised. Two at once would each load the model and fight for the
 * same cores, turning two five-second waits into two twelve-second ones.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { isInventedLine } from "./whisper-hallucinations.ts";
import type { WhisperBackend } from "./whisper-gpu-detect.ts";
import { gpuPreference, installedBuild, probeFor, recordGpuFailure } from "./whisper-gpu-state.ts";
import { installedModel, vadModelPath } from "./whisper-install.service.ts";
import { findWhisperBinary, whisperModelDir, whisperTmpDir } from "./whisper-paths.ts";
import { withWhisperLock } from "./whisper-run-lock.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("whisper");

const TIMEOUT_MS = 180_000;

/**
 * whisper.cpp defaults to 4 threads. Measured on a 24-thread i9-12900K with
 * large-v3-turbo over a 10s clip: 4 threads 12.0s, 8 threads 8.1s, 16 threads
 * 5.6s, 24 threads 5.4s — so it is worth raising, and worth capping where the
 * curve flattens instead of taking every core the host has.
 */
export function threadCount(cpus: number = availableParallelism()): number {
  return Math.max(1, Math.min(16, cpus));
}

/** A non-speech annotation on a line of its own: "[BLANK_AUDIO]", "(nhạc)", "*gunshot*". */
const ANNOTATION = /^[[(*][^)\]*]*[\])*]$/;

/**
 * `-nt` prints text without timestamps, one line per segment. Three kinds of
 * line are not something anyone dictated: an annotation, a line with no letter
 * or digit in it at all (a bare "." is what this model makes of a hum in
 * English), and a sentence it invented out of non-speech — see
 * whisper-hallucinations.ts.
 */
export function parseWhisperText(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !ANNOTATION.test(line) &&
        /[\p{L}\p{N}]/u.test(line) &&
        !isInventedLine(line),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Longest vocabulary hint passed on: whisper keeps at most half its text context for it anyway. */
const MAX_PROMPT_CHARS = 1_000;

/**
 * `prompt` is whisper.cpp's `--prompt`, the "previous text" it conditions on: a list of the
 * project's words makes it spell an English identifier inside Vietnamese speech the way the
 * project does. Passed as its own argv element, so nothing in it can reach a shell.
 *
 * `carryPrompt` adds `--carry-initial-prompt`. Whisper reads audio in 30-second windows and, by
 * default, conditions each window after the first on the text it just wrote, so the word list
 * fades out of a two-minute message after its first half minute; with the flag every window
 * starts from the list again.
 */
export function whisperArgs(
  binary: string, wavPath: string, modelPath: string, language: string, prompt?: string,
  opts: { carryPrompt?: boolean; noGpu?: boolean } = {},
): string[] {
  const hint = prompt?.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS) ?? "";
  return [
    binary,
    "-m", modelPath,
    "-f", wavPath,
    "-l", language,
    "-t", String(threadCount()),
    "-nt",
    "-np",
    // Without VAD, silence is transcribed as an invented sentence — see whisper-catalog.ts.
    "--vad",
    "--vad-model", vadModelPath(),
    ...(hint ? ["--prompt", hint] : []),
    ...(hint && opts.carryPrompt ? ["--carry-initial-prompt"] : []),
    // `-ng` is in every whisper-cli, CPU builds included, so it is safe whichever build runs.
    ...(opts.noGpu ? ["-ng"] : []),
  ];
}

const CARRY_FLAG = "--carry-initial-prompt";
const carrySupport = new Map<string, Promise<boolean>>();

/**
 * Whether this `whisper-cli` knows `--carry-initial-prompt`: an older build (Homebrew's, on a Mac
 * that has not upgraded) rejects an unknown flag and every transcription would fail. Asked once
 * per binary, from its own `--help`.
 */
export function supportsCarryPrompt(binary: string): Promise<boolean> {
  let known = carrySupport.get(binary);
  if (!known) {
    known = (async () => {
      try {
        const proc = Bun.spawn({ cmd: [binary, "--help"], stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
        const timer = setTimeout(() => proc.kill(), 3_000);
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        clearTimeout(timer);
        const known = out.includes(CARRY_FLAG) || err.includes(CARRY_FLAG);
        // Only a yes is kept: a failed or slow `--help` is asked again next time, and a reinstall
        // at the same path that adds the flag is noticed then.
        if (!known) carrySupport.delete(binary);
        return known;
      } catch {
        carrySupport.delete(binary);
        return false;
      }
    })();
    carrySupport.set(binary, known);
  }
  return known;
}

export interface TranscribeResult {
  text: string;
  /** Wall time of the whisper-cli run, for the UI's "took Ns" and for tuning. */
  ms: number;
  /** What the run that produced the text was allowed to use: `cpu` when it ran with `-ng`. */
  ranOn?: "gpu" | "cpu";
  /** What the binary was last seen to run on when the GPU is allowed (null: not checked yet). */
  backend?: WhisperBackend | null;
  /** The GPU run failed and the text came from the CPU retry. */
  fellBack?: boolean;
}

/** Throws when Whisper is not installed, the run fails, or it outruns the timeout. */
export async function transcribeWav(wav: Uint8Array, language = "vi", prompt?: string): Promise<TranscribeResult> {
  return withWhisperLock(() => runOnce(wav, language, prompt));
}

/**
 * The Settings test: one run over `wav`, through the same lock as a voice message so it never runs
 * beside one. `cpu` forces `-ng` (the "compare with the CPU" button); `default` runs the way a
 * message would. No word list is passed, so the time is the model's own.
 */
export function transcribeTest(wav: Uint8Array, language: string, device: "default" | "cpu"): Promise<TranscribeResult> {
  return withWhisperLock(() => runOnce(wav, language, undefined, { forceCpu: device === "cpu" }));
}

async function runOnce(
  wav: Uint8Array, language: string, prompt: string | undefined, opts: { forceCpu?: boolean } = {},
): Promise<TranscribeResult> {
  const binary = findWhisperBinary();
  const model = installedModel();
  if (!binary || !model) throw new Error("Whisper is not installed on this host");

  mkdirSync(whisperTmpDir(), { recursive: true });
  const wavPath = resolve(whisperTmpDir(), `${randomUUID()}.wav`);
  await Bun.write(wavPath, wav);

  // Asked before the clock starts: the first message after a start pays one `--help` run for it.
  const carryPrompt = !!prompt?.trim() && (await supportsCarryPrompt(binary.path));
  const useGpu = !opts.forceCpu && gpuPreference();
  let fellBack = false;
  const started = Date.now();
  try {
    const cmd = (noGpu: boolean) =>
      whisperArgs(binary.path, wavPath, resolve(whisperModelDir(), model.file), language, prompt, { carryPrompt, noGpu });
    let run = await runWhisper(cmd(!useGpu));
    // PPM's CPU build needs no probe to know it has no GPU to lose.
    const backend = probeFor(binary)?.backend ?? (installedBuild(binary) === "cpu" ? "none" : null);
    if (run.code !== 0 && shouldRetryOnCpu({ useGpu, timedOut: run.timedOut, backend })) {
      // A GPU that fails mid-run (out of memory while a game holds it, a driver reset) takes this
      // message down with it. The same binary without its GPU still works, so the message is not
      // lost; the failure is kept for Settings to show.
      const detail = lastLine(run.stderr, run.code);
      log.warn(`whisper-cli failed with the GPU on (${detail}); running it again on the CPU`);
      run = await runWhisper(cmd(true));
      fellBack = true;
      // Only a CPU run that works shows the GPU was what failed; a bad WAV fails both ways and
      // must not be reported as a GPU failure.
      if (run.code === 0) recordGpuFailure(detail);
    }
    if (run.code !== 0) throw new Error(`whisper-cli failed: ${lastLine(run.stderr, run.code)}`);
    // "gpu" only when a probe saw this binary choose one; an unchecked binary is not claimed.
    const ranOn = useGpu && !fellBack && backend !== null && backend !== "none" ? "gpu" : "cpu";
    return { text: parseWhisperText(run.stdout), ms: Date.now() - started, ranOn, backend, fellBack };
  } finally {
    rmSync(wavPath, { force: true });
  }
}

/**
 * A failed run is tried again on the CPU only when the GPU may be what failed: the GPU was on,
 * the run did not simply run out of time (a second three-minute run would only double the
 * wait), and the binary is not known to run on the CPU already.
 */
export function shouldRetryOnCpu(run: { useGpu: boolean; timedOut: boolean; backend: WhisperBackend | null }): boolean {
  return run.useGpu && !run.timedOut && run.backend !== "none";
}

const lastLine = (stderr: string, code: number | null) =>
  stderr.trim().split("\n").at(-1)?.trim() || `exit ${code}`;

async function runWhisper(cmd: string[]): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, code, timedOut };
}
