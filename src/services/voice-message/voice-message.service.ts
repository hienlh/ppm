/**
 * A voice message from recording to text: the audio becomes a WAV (ffmpeg for anything that is
 * not one already), Whisper transcribes it on this host with the project's words as a hint, and —
 * where the surface is set to it — Claude Haiku tidies the transcript with the chat's context.
 * Otherwise the transcript goes as Whisper heard it, and the chat socket attaches the hints when
 * the message is sent (`voice-hints.ts`). The audio and the transcript go nowhere else. Shared by the composer's route and the Telegram bridge, which passes the OGG a
 * voice note arrives as and the project `__assistant__`.
 *
 * The feature switch is the callers' to check; this only does the work.
 */
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { redactLogText } from "../../shared/log-redact.ts";
import {
  VOICE_MAX_SECONDS, whisperVocabularyPrompt, type LearnedWord, type VoiceFix, type VoiceSurface,
} from "../../shared/voice-message.ts";
import { assistantWorkDir } from "../assistant/assistant-work-dir.ts";
import { configService } from "../config.service.ts";
import { createLogger } from "../logger.ts";
import { getWhisperStatus } from "../speech-to-text/whisper-install.service.ts";
import { transcribeWav, type TranscribeResult } from "../speech-to-text/whisper-transcribe.service.ts";
import { toWhisperWav, wavDurationSec } from "./voice-audio.ts";
import { autoVocabulary } from "./voice-auto-vocabulary-sources.ts";
import type { RankedTerm } from "./voice-auto-vocabulary.ts";
import { cleanupTranscript } from "./voice-cleanup.ts";
import { gatherVoiceContext, type VoiceContext, type VoiceContextInput } from "./voice-context.ts";
import { askClaudeHaiku, type VoiceAsk } from "./voice-haiku.ts";
import { extractLearnedWords } from "./voice-learn.ts";
import { fixesToShow, replacements } from "./voice-learn-from-cleanup.ts";
import { appendLearnedWords, markLearnedUse, recordCleanupReplacements } from "./voice-learned-store.ts";
import { VoiceMessageError } from "./voice-message-errors.ts";
import { readVoiceSettings, selfLearningOn, transcriptFixFor, vocabularyOf } from "./voice-settings.ts";
import { composeVoiceWords, looksLikePromptEcho } from "./voice-vocabulary.ts";

const log = createLogger("voice-message");

/** 16 kHz mono 16-bit is 32 KB/s, so a two-minute WAV is under 4 MB; this leaves room for other formats. */
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
/** A recorder stops a little after its limit; a few seconds over it is the same recording. */
const DURATION_SLACK_SEC = 5;

export interface ProcessVoiceInput {
  audio: Uint8Array;
  project: string;
  /** Where it was recorded: chooses Haiku or hints (Settings → Voice). The chat box when left out. */
  surface?: VoiceSurface;
  sessionId?: string;
  providerId?: string;
  /** What the user already typed into the same message; context only, never merged. */
  typed?: string;
  /** Whisper language: a two-letter code or "auto"; anything else falls back to "vi". */
  lang?: string;
}

export interface ProcessVoiceResult {
  raw: string;
  text: string;
  cleaned: boolean;
  cleanupError?: string;
  /**
   * The surface sends Whisper's text with hints instead of a Haiku clean-up: `text` is Whisper's
   * own, by choice rather than failure, so it neither warns nor forces a review.
   */
  cleanupSkipped?: true;
  /** Words the clean-up replaced ("BPM" → "PPM"), for the Telegram card; absent when none. */
  fixes?: VoiceFix[];
  /** Words self-learning learned from this message's clean-up. */
  learned?: LearnedWord[];
  /** Turning the recording into Whisper's WAV on the host (0 when it already was one). */
  convertMs: number;
  transcribeMs: number;
  cleanupMs: number;
}

/** The steps that leave the process, swappable for tests. */
export interface VoiceServiceDeps {
  whisperReady: () => boolean;
  transcribe: (wav: Uint8Array, lang: string, prompt: string) => Promise<TranscribeResult>;
  gatherContext: (input: VoiceContextInput) => Promise<VoiceContext>;
  ask: VoiceAsk;
  /** The project's picked-up words (self-learning). */
  autoVocabulary?: (project: string) => Promise<RankedTerm[]>;
  /** The clock learning stamps and fades words by. */
  now?: () => Date;
}

const defaultDeps: VoiceServiceDeps = {
  whisperReady: () => getWhisperStatus().ready,
  transcribe: transcribeWav,
  gatherContext: (input) => gatherVoiceContext(input),
  ask: askClaudeHaiku,
  autoVocabulary: (project) => autoVocabulary(project),
};

/** A registered project's folder, the Assistant's work directory, or null for any other name. */
export function voiceProjectPath(project: string): string | null {
  if (project === ASSISTANT_PROJECT_NAME) return assistantWorkDir();
  return configService.get("projects").find((p) => p.name === project)?.path ?? null;
}

function requireProject(project: string): string {
  const path = typeof project === "string" ? voiceProjectPath(project) : null;
  if (!path) throw new VoiceMessageError("invalid_project", `No project named "${project}"`);
  return path;
}

export async function processVoiceMessage(
  input: ProcessVoiceInput,
  deps: VoiceServiceDeps = defaultDeps,
): Promise<ProcessVoiceResult> {
  const projectPath = requireProject(input.project);
  if (input.audio.byteLength === 0) throw new VoiceMessageError("empty_audio", "The recording is empty");
  if (input.audio.byteLength > MAX_VOICE_AUDIO_BYTES) throw new VoiceMessageError("too_long", "The recording is too large");
  if (!deps.whisperReady()) throw new VoiceMessageError("whisper_missing", "Whisper is not installed on this host");

  const settings = readVoiceSettings();
  const selfLearning = selfLearningOn(settings);
  // Read while the audio converts; a cold list is waited for at most a moment (see autoVocabulary).
  const autoWords = selfLearning && settings.learn_auto_vocabulary && deps.autoVocabulary
    ? deps.autoVocabulary(input.project).catch((): RankedTerm[] => [])
    : Promise.resolve<RankedTerm[]>([]);

  const convertStarted = Date.now();
  const wav = await toWhisperWav(input.audio);
  const convertMs = Date.now() - convertStarted;
  const seconds = wavDurationSec(wav);
  if (seconds !== null && seconds > VOICE_MAX_SECONDS + DURATION_SLACK_SEC) {
    throw new VoiceMessageError("too_long", `A voice message can be at most ${VOICE_MAX_SECONDS / 60} minutes long`);
  }

  const lang = input.lang && /^(auto|[a-z]{2})$/.test(input.lang) ? input.lang : "vi";
  const lists = composeVoiceWords(settings, input.project, {
    selfLearning, auto: await autoWords, nowMs: (deps.now?.() ?? new Date()).getTime(),
  });
  const words = lists.cleanup;
  // Hints instead of Haiku: no context is read and Haiku is never asked; the word lists still help
  // Whisper, and the chat socket attaches the misheard words when the message is sent.
  const cleanupOn = transcriptFixFor(settings, input.surface ?? "composer") === "haiku";
  // Read while Whisper runs: the chat, the docs and the file index cost nothing on the critical path.
  const context = !cleanupOn ? null : deps.gatherContext({
    project: input.project, projectPath, sessionId: input.sessionId, providerId: input.providerId, typed: input.typed, words,
  }).then((ctx): VoiceContext => ({ ...ctx, corrections: lists.corrections }), (e): VoiceContext => {
    log.warn(`voice context failed, cleaning up without it: ${(e as Error).message}`);
    return { recentMessages: [], typed: input.typed ?? "", instructions: "", memory: "", fileNames: [], words, corrections: lists.corrections };
  });

  let transcript: TranscribeResult;
  try {
    transcript = await deps.transcribe(wav, lang, whisperVocabularyPrompt(lists.whisper));
  } catch (e) {
    const message = (e as Error)?.message || "Transcription failed";
    if (!deps.whisperReady()) throw new VoiceMessageError("whisper_missing", message);
    throw new VoiceMessageError("transcribe_failed", message);
  }
  const heard = transcript.text.trim();
  const raw = heard && looksLikePromptEcho(heard, lists.whisper) ? "" : heard;
  if (heard && !raw) log.info("Whisper wrote its word list back instead of speech; treated as no speech");
  if (!raw) return { raw: "", text: "", cleaned: false, convertMs, transcribeMs: transcript.ms, cleanupMs: 0 };
  const now = deps.now ?? (() => new Date());
  // A learned word said again stays; one the clean-up taught and nobody has said for a month fades.
  const noteUse = (texts: string[]) => {
    if (!selfLearning) return;
    try {
      const faded = markLearnedUse(input.project, texts, now());
      if (faded.length) log.info(`${faded.length} learned word(s) faded for project "${input.project}" after going unused`);
    } catch (e) {
      log.warn(`could not note which learned words were used: ${(e as Error).message}`);
    }
  };
  if (!context) {
    noteUse([raw]);
    return { raw, text: raw, cleaned: false, cleanupSkipped: true, convertMs, transcribeMs: transcript.ms, cleanupMs: 0 };
  }

  const started = Date.now();
  const cleanup = await cleanupTranscript(raw, await context, deps.ask, undefined, { vietnameseFixes: settings.vietnamese_fixes });
  const cleanupMs = Date.now() - started;
  if (!cleanup.ok) {
    log.warn(`clean-up failed, keeping the raw transcript: ${cleanup.error}`);
    noteUse([raw]);
    return { raw, text: raw, cleaned: false, cleanupError: cleanup.error, convertMs, transcribeMs: transcript.ms, cleanupMs };
  }
  // Times only: what was said never goes into the log.
  log.info(`clean-up ok in ${cleanupMs} ms (Whisper ${transcript.ms} ms)`);
  const fixes = fixesToShow(raw, cleanup.text);
  let learned: LearnedWord[] = [];
  // A message with a secret in it teaches nothing: a learned word is stored and sent with every later message.
  const holdsSecret = (text: string) => redactLogText(text, { home: false, email: false, chats: false }) !== text;
  if (selfLearning && settings.learn_from_cleanup && !holdsSecret(raw) && !holdsSecret(cleanup.text)) {
    try {
      learned = recordCleanupReplacements(input.project, replacements(raw, cleanup.text, lists.known), lists.known, now());
      if (learned.length) log.info(`learned ${learned.length} word(s) from the clean-up for project "${input.project}"`);
    } catch (e) {
      log.warn(`could not record the clean-up's corrections: ${(e as Error).message}`);
    }
  }
  noteUse([raw, cleanup.text]);
  return {
    raw, text: cleanup.text, cleaned: true, convertMs, transcribeMs: transcript.ms, cleanupMs,
    ...(fixes.length ? { fixes } : {}), ...(learned.length ? { learned } : {}),
  };
}

export interface LearnFromEditInput {
  project: string;
  /** Where the transcript was recorded; the chat box when left out. */
  surface?: VoiceSurface;
  /** The transcript as PPM produced it (cleaned, or raw when the clean-up failed). */
  before: string;
  /** The transcript as the user sent it. */
  after: string;
}

/**
 * Learns the corrections in an edited transcript into the project's word list and answers with
 * the newly added ones. A model that cannot answer teaches nothing; that is not an error.
 */
export async function learnFromEdit(input: LearnFromEditInput, ask: VoiceAsk = askClaudeHaiku): Promise<LearnedWord[]> {
  requireProject(input.project);
  const settings = readVoiceSettings();
  // Learning asks Haiku once, after the message went. A surface set to hints keeps Haiku off its
  // messages unless self-learning was chosen, which is what asks for learning.
  if (transcriptFixFor(settings, input.surface ?? "composer") !== "haiku" && !selfLearningOn(settings)) return [];
  const known = vocabularyOf(settings, input.project);
  let learned: LearnedWord[];
  try {
    learned = await extractLearnedWords(input.before, input.after, known, ask);
  } catch (e) {
    log.warn(`could not learn from an edited transcript: ${(e as Error).message}`);
    return [];
  }
  const added = appendLearnedWords(input.project, learned);
  if (added.length) log.info(`learned ${added.length} word(s) for project "${input.project}"`);
  return added;
}
