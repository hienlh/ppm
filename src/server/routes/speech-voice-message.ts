/**
 * The voice-message half of `/api/speech`: its settings, turning a recording into a cleaned
 * transcript, and learning from a transcript the user edited. The work is
 * `services/voice-message/`; this file checks what comes in and maps failures to statuses.
 *
 * `/voice-message` and `/voice-learn` answer 409 `voice_messages_off` until the feature is turned
 * on (feature intro or Settings → Voice); `/voice-settings` always works, since that is where it
 * is turned on.
 */
import type { Context, Hono } from "hono";
import { err, ok } from "../../types/api.ts";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../shared/feature-intros.ts";
import { settleFeaturesDecidedInSettings } from "../../services/feature-intros.service.ts";
import { getWhisperStatus } from "../../services/speech-to-text/whisper-install.service.ts";
import { VoiceMessageError, type VoiceMessageErrorCode } from "../../services/voice-message/voice-message-errors.ts";
import {
  learnFromEdit, MAX_VOICE_AUDIO_BYTES, processVoiceMessage, voiceProjectPath,
} from "../../services/voice-message/voice-message.service.ts";
import {
  projectWordsOf, readVoiceSettings, selfLearningOn, updateVoiceSettings, voiceMessagesEnabled, type VoiceSettingsPatch,
} from "../../services/voice-message/voice-settings.ts";
import { autoVocabulary, clearAutoVocabularyCache } from "../../services/voice-message/voice-auto-vocabulary-sources.ts";
import { whisperPromptPreview } from "../../services/voice-message/voice-vocabulary.ts";
import { isFaded } from "../../services/voice-message/voice-learned-fade.ts";
import { VOICE_SURFACES, WHISPER_PROMPT_MAX_CHARS, type VoiceSurface } from "../../shared/voice-message.ts";

export interface VoiceRouteDeps {
  broadcast: (event: unknown) => void;
  process: typeof processVoiceMessage;
  learn: typeof learnFromEdit;
  whisperReady: () => boolean;
}

/** Longest text `/voice-learn` compares, and longest `typed` passed on as context. */
const MAX_TEXT_CHARS = 10_000;
/** Longest word list a request may carry before the settings cut it to its cap. */
const MAX_LIST_ITEMS = 1_000;

const STATUS: Record<VoiceMessageErrorCode, 400 | 409 | 422 | 500> = {
  invalid_project: 400, empty_audio: 400, too_long: 400,
  whisper_missing: 409, ffmpeg_missing: 422, unreadable_audio: 422, transcribe_failed: 500,
};

const fail = (c: Context, status: 400 | 409 | 422 | 500, message: string, code?: string) =>
  c.json({ ...err(message), ...(code ? { code } : {}) }, status);

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_LIST_ITEMS && v.every((x) => typeof x === "string");

async function settingsView(project: string | undefined, whisperReady: boolean) {
  const config = readVoiceSettings();
  const own = project ? projectWordsOf(config, project) : { words: [], learned: [] };
  const selfLearning = selfLearningOn(config);
  // Only a registered project (or the Assistant) is read: any other name would only fill the cache.
  const known = !!project && !!voiceProjectPath(project);
  const auto = known && selfLearning && config.learn_auto_vocabulary ? await autoVocabulary(project!).catch(() => []) : [];
  return {
    enabled: config.enabled === true,
    reviewBeforeSend: config.review_before_send,
    transcriptFix: config.transcript_fix,
    /** Both surfaces tidy with Haiku: the older single switch, as the Assistant's settings tools read it. */
    cleanupEnabled: VOICE_SURFACES.every((s) => config.transcript_fix[s] === "haiku"),
    selfLearning: config.self_learning === true,
    learnAutoVocabulary: config.learn_auto_vocabulary,
    learnFromCleanup: config.learn_from_cleanup,
    learnFromChat: config.learn_from_chat,
    weeklySummary: config.weekly_summary,
    vietnameseFixes: config.vietnamese_fixes,
    words: config.words,
    projectWords: own.words,
    // A faded word is gone from the list even before the next voice message prunes the row.
    projectLearned: own.learned.filter((l) => !isFaded(l, Date.now())),
    projectBlocked: own.blocked ?? [],
    whisperPrompt: project ? whisperPromptPreview(config, project, { selfLearning, auto }) : [],
    whisperPromptMaxChars: WHISPER_PROMPT_MAX_CHARS,
    whisperReady,
  };
}

/** The patch a PUT body asks for, or an error message. */
function parsePatch(body: unknown): VoiceSettingsPatch | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected a JSON object";
  const b = body as Record<string, unknown>;
  const patch: VoiceSettingsPatch = {};
  for (const key of [
    "enabled", "reviewBeforeSend", "cleanupEnabled", "selfLearning", "learnAutoVocabulary", "learnFromCleanup",
    "learnFromChat", "weeklySummary", "vietnameseFixes",
  ] as const) {
    const value = b[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return `${key} must be true or false`;
    patch[key] = value;
  }
  if (b.transcriptFix !== undefined) {
    const fix = b.transcriptFix;
    if (!fix || typeof fix !== "object" || Array.isArray(fix)) return "transcriptFix must be an object";
    const out: NonNullable<VoiceSettingsPatch["transcriptFix"]> = {};
    for (const [surface, value] of Object.entries(fix)) {
      if (!VOICE_SURFACES.includes(surface as VoiceSurface)) return `Unknown surface "${surface}"`;
      if (value !== "haiku" && value !== "hints") return "transcriptFix values must be \"haiku\" or \"hints\"";
      out[surface as VoiceSurface] = value;
    }
    patch.transcriptFix = out;
  }
  for (const key of ["words", "projectWords", "removeLearned", "restoreBlocked"] as const) {
    const value = b[key];
    if (value === undefined) continue;
    if (!isStringList(value)) return `${key} must be a list of at most ${MAX_LIST_ITEMS} strings`;
    patch[key] = value;
  }
  if (b.project !== undefined) {
    if (typeof b.project !== "string" || !voiceProjectPath(b.project)) return "Unknown project";
    patch.project = b.project;
  }
  if ((patch.projectWords || patch.removeLearned || patch.restoreBlocked) && !patch.project) {
    return "project is required with projectWords, removeLearned or restoreBlocked";
  }
  return patch;
}

export function registerVoiceMessageRoutes(routes: Hono, deps: VoiceRouteDeps): void {
  routes.get("/voice-settings", async (c) => c.json(ok(await settingsView(c.req.query("project") || undefined, deps.whisperReady()))));

  routes.put("/voice-settings", async (c) => {
    const patch = parsePatch(await c.req.json().catch(() => null));
    if (typeof patch === "string") return fail(c, 400, patch);
    updateVoiceSettings(patch);
    // A part of self-learning switched (back) on reads its sources fresh, not a list kept from before.
    if (patch.learnAutoVocabulary !== undefined || patch.selfLearning !== undefined) clearAutoVocabularyCache();
    // The switches are also the feature intros' answers, as a switch saved in Settings → Tools is.
    if ((patch.enabled !== undefined || patch.selfLearning !== undefined) && settleFeaturesDecidedInSettings()) {
      deps.broadcast({ type: FEATURE_INTROS_CHANGED_EVENT, change: "settings" });
    }
    return c.json(ok(await settingsView(patch.project, deps.whisperReady())));
  });

  routes.post("/voice-message", async (c) => {
    // Timed here so the composer can show where the wait went: receiving the upload, then the steps.
    const handlerStarted = Date.now();
    if (!voiceMessagesEnabled()) return fail(c, 409, "Voice messages are turned off", "voice_messages_off");
    if (Number(c.req.header("content-length") ?? 0) > MAX_VOICE_AUDIO_BYTES + 64 * 1024) {
      return fail(c, 400, "The recording is too large", "too_long");
    }
    let body: Record<string, unknown>;
    try { body = await c.req.parseBody(); } catch { return fail(c, 400, "Expected a multipart form"); }
    const receiveMs = Date.now() - handlerStarted;
    const audio = body.audio;
    if (!(audio instanceof Blob)) return fail(c, 400, "audio must be a file", "empty_audio");
    if (audio.size > MAX_VOICE_AUDIO_BYTES) return fail(c, 400, "The recording is too large", "too_long");
    const text = (key: string, max: number): string | undefined =>
      typeof body[key] === "string" && body[key] ? (body[key] as string).slice(0, max) : undefined;
    const project = text("project", 300);
    if (!project) return fail(c, 400, "project is required", "invalid_project");
    if (!deps.whisperReady()) return fail(c, 409, "Whisper is not installed on this host", "whisper_missing");
    try {
      const result = await deps.process({
        audio: new Uint8Array(await audio.arrayBuffer()),
        project,
        surface: "composer",
        sessionId: text("sessionId", 200),
        providerId: text("providerId", 40),
        typed: text("typed", MAX_TEXT_CHARS),
        lang: text("lang", 8),
      });
      // The setting as it is now, nothing folded into it: a raw transcript (`cleaned: false`) always
      // waits for the user, and the client decides that from `cleaned`. Folding it in here made a
      // send queued before the text arrived read "review on" and go out unread.
      return c.json(ok({
        ...result, reviewBeforeSend: readVoiceSettings().review_before_send, receiveMs, serverMs: Date.now() - handlerStarted,
      }));
    } catch (e) {
      if (e instanceof VoiceMessageError) return fail(c, STATUS[e.code], e.message, e.code);
      return fail(c, 500, (e as Error)?.message || "The voice message failed");
    }
  });

  routes.post("/voice-learn", async (c) => {
    if (!voiceMessagesEnabled()) return fail(c, 409, "Voice messages are turned off", "voice_messages_off");
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const { project, before, after } = body;
    if (typeof project !== "string" || !voiceProjectPath(project)) return fail(c, 400, "Unknown project", "invalid_project");
    if (typeof before !== "string" || typeof after !== "string") return fail(c, 400, "before and after must be text");
    if (before.length > MAX_TEXT_CHARS || after.length > MAX_TEXT_CHARS) return fail(c, 400, "The text is too long");
    try {
      return c.json(ok({ learned: await deps.learn({ project, before, after }) }));
    } catch (e) {
      if (e instanceof VoiceMessageError) return fail(c, STATUS[e.code], e.message, e.code);
      return fail(c, 500, (e as Error)?.message || "Learning failed");
    }
  });
}

export const defaultVoiceRouteDeps = (broadcast: (event: unknown) => void): VoiceRouteDeps => ({
  broadcast,
  process: (input) => processVoiceMessage(input),
  learn: (input) => learnFromEdit(input),
  whisperReady: () => getWhisperStatus().ready,
});
