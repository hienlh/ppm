/**
 * A voice message from recording to text: the audio becomes a WAV (ffmpeg for anything that is
 * not one already), Whisper transcribes it on this host with the project's words as a hint, and
 * Claude Haiku tidies the transcript with the chat's context. The audio and the transcript go
 * nowhere else. Shared by the composer's route and the Telegram bridge, which passes the OGG a
 * voice note arrives as and the project `__assistant__`.
 *
 * The feature switch is the callers' to check; this only does the work.
 */
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { VOICE_MAX_SECONDS, whisperVocabularyPrompt, type LearnedWord } from "../../shared/voice-message.ts";
import { assistantWorkDir } from "../assistant/assistant-work-dir.ts";
import { configService } from "../config.service.ts";
import { createLogger } from "../logger.ts";
import { getWhisperStatus } from "../speech-to-text/whisper-install.service.ts";
import { transcribeWav, type TranscribeResult } from "../speech-to-text/whisper-transcribe.service.ts";
import { toWhisperWav, wavDurationSec } from "./voice-audio.ts";
import { cleanupTranscript } from "./voice-cleanup.ts";
import { gatherVoiceContext, type VoiceContext, type VoiceContextInput } from "./voice-context.ts";
import { askClaudeHaiku, type VoiceAsk } from "./voice-haiku.ts";
import { extractLearnedWords } from "./voice-learn.ts";
import { VoiceMessageError } from "./voice-message-errors.ts";
import { appendLearnedWords, readVoiceSettings, vocabularyOf } from "./voice-settings.ts";

const log = createLogger("voice-message");

/** 16 kHz mono 16-bit is 32 KB/s, so a two-minute WAV is under 4 MB; this leaves room for other formats. */
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
/** A recorder stops a little after its limit; a few seconds over it is the same recording. */
const DURATION_SLACK_SEC = 5;

export interface ProcessVoiceInput {
  audio: Uint8Array;
  project: string;
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
  transcribeMs: number;
  cleanupMs: number;
}

/** The steps that leave the process, swappable for tests. */
export interface VoiceServiceDeps {
  whisperReady: () => boolean;
  transcribe: (wav: Uint8Array, lang: string, prompt: string) => Promise<TranscribeResult>;
  gatherContext: (input: VoiceContextInput) => Promise<VoiceContext>;
  ask: VoiceAsk;
}

const defaultDeps: VoiceServiceDeps = {
  whisperReady: () => getWhisperStatus().ready,
  transcribe: transcribeWav,
  gatherContext: (input) => gatherVoiceContext(input),
  ask: askClaudeHaiku,
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

  const wav = await toWhisperWav(input.audio);
  const seconds = wavDurationSec(wav);
  if (seconds !== null && seconds > VOICE_MAX_SECONDS + DURATION_SLACK_SEC) {
    throw new VoiceMessageError("too_long", `A voice message can be at most ${VOICE_MAX_SECONDS / 60} minutes long`);
  }

  const lang = input.lang && /^(auto|[a-z]{2})$/.test(input.lang) ? input.lang : "vi";
  const words = vocabularyOf(readVoiceSettings(), input.project);
  // Read while Whisper runs: the chat, the docs and the file index cost nothing on the critical path.
  const context = deps.gatherContext({
    project: input.project, projectPath, sessionId: input.sessionId, providerId: input.providerId, typed: input.typed, words,
  }).catch((e): VoiceContext => {
    log.warn(`voice context failed, cleaning up without it: ${(e as Error).message}`);
    return { recentMessages: [], typed: input.typed ?? "", instructions: "", memory: "", fileNames: [], words };
  });

  let transcript: TranscribeResult;
  try {
    transcript = await deps.transcribe(wav, lang, whisperVocabularyPrompt(words));
  } catch (e) {
    const message = (e as Error)?.message || "Transcription failed";
    if (!deps.whisperReady()) throw new VoiceMessageError("whisper_missing", message);
    throw new VoiceMessageError("transcribe_failed", message);
  }
  const raw = transcript.text.trim();
  if (!raw) return { raw: "", text: "", cleaned: false, transcribeMs: transcript.ms, cleanupMs: 0 };

  const started = Date.now();
  const cleanup = await cleanupTranscript(raw, await context, deps.ask);
  const cleanupMs = Date.now() - started;
  if (!cleanup.ok) {
    log.warn(`clean-up failed, keeping the raw transcript: ${cleanup.error}`);
    return { raw, text: raw, cleaned: false, cleanupError: cleanup.error, transcribeMs: transcript.ms, cleanupMs };
  }
  return { raw, text: cleanup.text, cleaned: true, transcribeMs: transcript.ms, cleanupMs };
}

export interface LearnFromEditInput {
  project: string;
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
  const known = vocabularyOf(readVoiceSettings(), input.project);
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
