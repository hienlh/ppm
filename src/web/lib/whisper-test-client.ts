/**
 * The Settings → Voice Input test: a WAV (a few seconds from the mic, or the bundled sample) goes
 * to `POST /api/speech/test`, which runs whisper-cli on this host once and answers with the text,
 * the time and what it ran on. Nothing here keeps the audio beyond the page's own memory.
 */
import { getAuthToken } from "@/lib/api-client";

export interface WhisperTestResult {
  text: string;
  ms: number;
  ranOn?: "gpu" | "cpu";
  backend?: "cuda" | "metal" | "gpu" | "none" | null;
  fellBack?: boolean;
  /** The model's label ("Large v3 Turbo"). */
  model: string;
  /** The GPU's name when the run used one. */
  device: string | null;
}

/**
 * The bundled sample: JFK's 1961 inaugural address, eleven seconds, public domain; the copy from
 * whisper.cpp's `samples/jfk.mp3` at the release PPM pins. English, so it runs with `en`.
 */
export const TEST_SAMPLE_URL = "/whisper-test-sample.mp3";
export const TEST_SAMPLE_LANG = "en";
/** The longest test recording: long enough to say a sentence with a few terms in it. */
export const TEST_MAX_SECONDS = 15;

export async function runWhisperTest(wav: Uint8Array, language: string, device: "default" | "cpu"): Promise<WhisperTestResult> {
  const token = getAuthToken();
  const res = await fetch(`/api/speech/test?lang=${encodeURIComponent(language)}&device=${device}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: wav as BodyInit,
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: WhisperTestResult; error?: string } | null;
  if (!res.ok || !json?.ok || !json.data) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data;
}

/** "0.84 s", "5.3 s", "12 s": two significant figures, which is all a single run can claim. */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${s < 1 ? s.toFixed(2) : s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** "6.4× faster" for a GPU run against the CPU run of the same audio; null when it is not faster. */
export function speedup(gpuMs: number, cpuMs: number): string | null {
  if (gpuMs <= 0 || cpuMs <= gpuMs) return null;
  const x = cpuMs / gpuMs;
  return `${x < 10 ? x.toFixed(1) : Math.round(x)}× faster on the GPU`;
}

/** What the run used, in one line: "GPU — NVIDIA GeForce RTX 4070 (CUDA) · Large v3 Turbo". */
export function ranOnText(r: WhisperTestResult): string {
  const kind = r.backend === "cuda" ? "CUDA" : r.backend === "metal" ? "Metal" : null;
  const where = r.ranOn === "gpu"
    ? `GPU${r.device ? ` — ${r.device}` : ""}${kind ? ` (${kind})` : ""}`
    : r.fellBack ? "CPU (the GPU failed, so it ran again on the CPU)" : "CPU";
  return `${where} · ${r.model}`;
}
