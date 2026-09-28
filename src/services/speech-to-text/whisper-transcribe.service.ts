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
import { installedModel, vadModelPath } from "./whisper-install.service.ts";
import { findWhisperBinary, whisperModelDir, whisperTmpDir } from "./whisper-paths.ts";

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

export function whisperArgs(binary: string, wavPath: string, modelPath: string, language: string): string[] {
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
  ];
}

let queue: Promise<unknown> = Promise.resolve();

export interface TranscribeResult {
  text: string;
  /** Wall time of the whisper-cli run, for the UI's "took Ns" and for tuning. */
  ms: number;
}

/** Throws when Whisper is not installed, the run fails, or it outruns the timeout. */
export async function transcribeWav(wav: Uint8Array, language = "vi"): Promise<TranscribeResult> {
  const run = queue.then(() => runOnce(wav, language));
  // Keep the chain alive after a failure, and never leak the rejection through it.
  queue = run.catch(() => {});
  return run;
}

async function runOnce(wav: Uint8Array, language: string): Promise<TranscribeResult> {
  const binary = findWhisperBinary();
  const model = installedModel();
  if (!binary || !model) throw new Error("Whisper is not installed on this host");

  mkdirSync(whisperTmpDir(), { recursive: true });
  const wavPath = resolve(whisperTmpDir(), `${randomUUID()}.wav`);
  await Bun.write(wavPath, wav);

  const started = Date.now();
  try {
    const cmd = whisperArgs(binary.path, wavPath, resolve(whisperModelDir(), model.file), language);
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) {
      const detail = stderr.trim().split("\n").slice(-1)[0] ?? `exit ${code}`;
      throw new Error(`whisper-cli failed: ${detail}`);
    }
    return { text: parseWhisperText(stdout), ms: Date.now() - started };
  } finally {
    rmSync(wavPath, { force: true });
  }
}
