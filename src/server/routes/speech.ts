/**
 * Speech-to-text on the host: install status, the install/uninstall buttons in
 * Settings, the transcribe door the chat mic posts a WAV to, and voice messages
 * (`speech-voice-message.ts`).
 *
 * Mounted under `/api`, so every route here is already behind `authMiddleware`.
 */
import { Hono } from "hono";
import { err, ok } from "../../types/api.ts";
import { resolve } from "node:path";
import {
  getWhisperStatus,
  installedModel,
  startWhisperInstall,
  uninstallWhisper,
} from "../../services/speech-to-text/whisper-install.service.ts";
import {
  probeWhisperBackend,
  setGpuPreference,
  whisperGpuStatus,
} from "../../services/speech-to-text/whisper-gpu-state.ts";
import { findWhisperBinary, whisperModelDir } from "../../services/speech-to-text/whisper-paths.ts";
import { transcribeTest, transcribeWav } from "../../services/speech-to-text/whisper-transcribe.service.ts";
import { broadcastGlobalEvent } from "../ws/global.ts";
import { defaultVoiceRouteDeps, registerVoiceMessageRoutes, type VoiceRouteDeps } from "./speech-voice-message.ts";

/** 16 kHz mono 16-bit is 32 KB/s, so this is about 13 minutes of speech. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** The Settings test: 30 seconds of 16 kHz mono 16-bit WAV is under 1 MB. */
const MAX_TEST_AUDIO_BYTES = 1_100_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Install status plus the GPU half; with Whisper ready and never probed, this starts the probe. */
async function fullWhisperStatus() {
  const status = getWhisperStatus();
  const model = installedModel();
  const modelPath = status.ready && model ? resolve(whisperModelDir(), model.file) : null;
  return { ...status, gpu: await whisperGpuStatus({ modelPath }) };
}

/** The routes with their voice-message steps swappable, for tests. */
export function createSpeechRoutes(voiceDeps: VoiceRouteDeps = defaultVoiceRouteDeps(broadcastGlobalEvent)): Hono {
  const speechRoutes = new Hono();

  speechRoutes.get("/status", async (c) => c.json(ok(await fullWhisperStatus())));

  /** `build` picks the whisper.cpp build: `cuda` only where this host has a card that can load it. */
  speechRoutes.post("/install", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; build?: unknown };
    if (body.build !== undefined && body.build !== "cpu" && body.build !== "cuda") {
      return c.json(err("build must be cpu or cuda"), 400);
    }
    // Asked only when the CUDA build would be downloaded: switching models on a CUDA build already
    // in place must not depend on `nvidia-smi` answering right now (a driver update, a timeout).
    if (body.build === "cuda") {
      const gpu = await whisperGpuStatus();
      if (gpu.installedBuild !== "cuda" && !gpu.cudaBuild) {
        return c.json(err("No NVIDIA GPU with CUDA 12.4 or newer was found on this host"), 409);
      }
    }
    try {
      return c.json(ok(startWhisperInstall(body.model, { build: body.build })));
    } catch (e) {
      return c.json(err(message(e)), 409);
    }
  });

  speechRoutes.post("/uninstall", async (c) => {
    try {
      uninstallWhisper();
      return c.json(ok(await fullWhisperStatus()));
    } catch (e) {
      return c.json(err(message(e)), 409);
    }
  });

  /** The "Use GPU" switch in Settings → Voice. Off passes `-ng`, so the GPU stays free for other work. */
  speechRoutes.post("/gpu", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { useGpu?: unknown };
    if (typeof body.useGpu !== "boolean") return c.json(err("useGpu must be true or false"), 400);
    setGpuPreference(body.useGpu);
    return c.json(ok(await fullWhisperStatus()));
  });

  /**
   * POST /api/speech/test?lang=en&device=default|cpu — the Settings test: a few seconds recorded in
   * the browser (or the bundled sample), as a WAV, transcribed once on this host and answered with
   * the text, the time and what it ran on. The audio goes to whisper-cli only: it is written to a
   * temp file for the run and deleted after it, and nothing is sent to a model or kept.
   * `device=cpu` is the "compare with the CPU" button.
   */
  speechRoutes.post("/test", async (c) => {
    const lang = c.req.query("lang") ?? "vi";
    if (!/^(auto|[a-z]{2})$/.test(lang)) return c.json(err("invalid lang"), 400);
    const device = c.req.query("device") ?? "default";
    if (device !== "default" && device !== "cpu") return c.json(err("device must be default or cpu"), 400);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json(err("empty audio"), 400);
    if (body.byteLength > MAX_TEST_AUDIO_BYTES) return c.json(err("A test can be at most 30 seconds"), 413);
    const model = installedModel();
    if (!getWhisperStatus().ready || !model) return c.json(err("Whisper is not installed on this host"), 409);
    try {
      const out = await transcribeTest(body, lang, device);
      const gpu = await whisperGpuStatus();
      return c.json(ok({ ...out, model: model.label, device: out.ranOn === "gpu" ? gpu.device : null }));
    } catch (e) {
      return c.json(err(message(e)), 500);
    }
  });

  /**
   * Ask the installed whisper-cli again which backend it runs on (after a driver update, say).
   * The check runs in the background — loading a model can take longer than a request may stay
   * silent — and the answer says `probing: true`, which the pane polls until it is not.
   */
  speechRoutes.post("/gpu/check", async (c) => {
    const status = getWhisperStatus();
    if (status.install && !status.install.done) return c.json(err("An install is running"), 409);
    const binary = findWhisperBinary();
    const model = installedModel();
    if (!binary || !model) return c.json(err("Whisper is not installed on this host"), 409);
    void probeWhisperBackend(binary, resolve(whisperModelDir(), model.file)).catch(() => {});
    return c.json(ok(await fullWhisperStatus()));
  });

  /**
   * POST /api/speech/transcribe?lang=vi — body is the raw WAV the browser recorded.
   *
   * WAV rather than the browser's native webm/opus: whisper.cpp reads wav, flac,
   * mp3 and Vorbis-ogg only, and converting Opus on the host would mean depending
   * on ffmpeg being installed as well.
   */
  speechRoutes.post("/transcribe", async (c) => {
    const lang = c.req.query("lang") ?? "vi";
    if (!/^(auto|[a-z]{2})$/.test(lang)) return c.json(err("invalid lang"), 400);

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json(err("empty audio"), 400);
    if (body.byteLength > MAX_AUDIO_BYTES) return c.json(err("audio too long"), 413);

    const status = getWhisperStatus();
    if (!status.ready) return c.json(err("Whisper is not installed on this host"), 409);

    try {
      return c.json(ok(await transcribeWav(body, lang)));
    } catch (e) {
      return c.json(err(message(e)), 500);
    }
  });

  registerVoiceMessageRoutes(speechRoutes, voiceDeps);
  return speechRoutes;
}

export const speechRoutes = createSpeechRoutes();
