/**
 * Speech-to-text on the host: install status, the install/uninstall buttons in
 * Settings, and the transcribe door the chat mic posts a WAV to.
 *
 * Mounted under `/api`, so every route here is already behind `authMiddleware`.
 */
import { Hono } from "hono";
import { err, ok } from "../../types/api.ts";
import {
  getWhisperStatus,
  startWhisperInstall,
  uninstallWhisper,
} from "../../services/speech-to-text/whisper-install.service.ts";
import { transcribeWav } from "../../services/speech-to-text/whisper-transcribe.service.ts";

export const speechRoutes = new Hono();

/** 16 kHz mono 16-bit is 32 KB/s, so this is about 13 minutes of speech. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

speechRoutes.get("/status", (c) => c.json(ok(getWhisperStatus())));

speechRoutes.post("/install", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { model?: string };
  try {
    return c.json(ok(startWhisperInstall(body.model)));
  } catch (e) {
    return c.json(err(message(e)), 409);
  }
});

speechRoutes.post("/uninstall", (c) => {
  try {
    uninstallWhisper();
    return c.json(ok(getWhisperStatus()));
  } catch (e) {
    return c.json(err(message(e)), 409);
  }
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
