/**
 * The browser's calls to `/api/speech/voice-*`: the voice-message settings, one recording's
 * transcript, and learning from a corrected transcript.
 */
import { api, getAuthToken } from "@/lib/api-client";
import type { LearnedWord } from "../../shared/voice-message";

export interface VoiceSettingsView {
  enabled: boolean;
  reviewBeforeSend: boolean;
  words: string[];
  projectWords: string[];
  projectLearned: LearnedWord[];
  whisperReady: boolean;
}

export interface VoiceSettingsPatch {
  enabled?: boolean;
  reviewBeforeSend?: boolean;
  words?: string[];
  project?: string;
  projectWords?: string[];
  removeLearned?: string[];
}

export interface VoiceTranscript {
  raw: string;
  text: string;
  cleaned: boolean;
  cleanupError?: string;
  transcribeMs: number;
  cleanupMs: number;
  reviewBeforeSend: boolean;
  /** The server's step timings, when it sends them. */
  convertMs?: number;
  receiveMs?: number;
  serverMs?: number;
}

/** A failed transcript request; `code` is the server's (`whisper_missing` when Whisper is not installed). */
export class VoiceMessageError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "VoiceMessageError";
  }
}

/** Fired in this window after Settings changed the voice settings, so open composers re-read them. */
export const VOICE_SETTINGS_CHANGED_EVENT = "ppm:voice-settings-changed";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** What the server answered, with anything missing read as off or empty. */
export function parseVoiceSettings(raw: unknown): VoiceSettingsView {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const learned = Array.isArray(v.projectLearned)
    ? v.projectLearned.filter((l): l is LearnedWord =>
        !!l && typeof l === "object" && typeof (l as LearnedWord).word === "string" && typeof (l as LearnedWord).from === "string")
    : [];
  return {
    enabled: v.enabled === true,
    reviewBeforeSend: v.reviewBeforeSend !== false,
    words: strings(v.words),
    projectWords: strings(v.projectWords),
    projectLearned: learned,
    whisperReady: v.whisperReady === true,
  };
}

const settingsPath = (project?: string) =>
  `/api/speech/voice-settings${project ? `?project=${encodeURIComponent(project)}` : ""}`;

export async function fetchVoiceSettings(project?: string): Promise<VoiceSettingsView> {
  return parseVoiceSettings(await api.get<unknown>(settingsPath(project)));
}

export async function putVoiceSettings(patch: VoiceSettingsPatch): Promise<VoiceSettingsView> {
  const next = parseVoiceSettings(await api.put<unknown>("/api/speech/voice-settings", patch));
  window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT));
  return next;
}

/** Transcribe and tidy one recording on the host. Multipart, so it does not go through `api`. */
export async function postVoiceMessage(input: {
  wav: Uint8Array;
  project: string;
  sessionId?: string;
  providerId?: string;
  typed?: string;
  lang?: string;
  signal?: AbortSignal;
}): Promise<VoiceTranscript> {
  const form = new FormData();
  form.append("audio", new Blob([input.wav as BlobPart], { type: "audio/wav" }), "voice.wav");
  form.append("project", input.project);
  if (input.sessionId) form.append("sessionId", input.sessionId);
  if (input.providerId) form.append("providerId", input.providerId);
  if (input.typed) form.append("typed", input.typed);
  form.append("lang", input.lang ?? "vi");
  const token = getAuthToken();
  const res = await fetch("/api/speech/voice-message", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    signal: input.signal,
  });
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: Partial<VoiceTranscript>; error?: string; code?: string }
    | null;
  if (!res.ok || !json?.ok || !json.data) {
    throw new VoiceMessageError(json?.error ?? `HTTP ${res.status}`, res.status, json?.code);
  }
  const d = json.data;
  return {
    raw: typeof d.raw === "string" ? d.raw : "",
    text: typeof d.text === "string" ? d.text : "",
    cleaned: d.cleaned === true,
    cleanupError: typeof d.cleanupError === "string" ? d.cleanupError : undefined,
    transcribeMs: Number(d.transcribeMs) || 0,
    cleanupMs: Number(d.cleanupMs) || 0,
    reviewBeforeSend: d.reviewBeforeSend !== false,
    ...(Number.isFinite(Number(d.convertMs)) && d.convertMs !== undefined && { convertMs: Number(d.convertMs) }),
    ...(Number.isFinite(Number(d.receiveMs)) && d.receiveMs !== undefined && { receiveMs: Number(d.receiveMs) }),
    ...(Number.isFinite(Number(d.serverMs)) && d.serverMs !== undefined && { serverMs: Number(d.serverMs) }),
  };
}

/** The corrections PPM learned from an edited transcript; only the newly added ones. */
export async function postVoiceLearn(input: { project: string; before: string; after: string }): Promise<LearnedWord[]> {
  const res = await api.post<{ learned?: unknown }>("/api/speech/voice-learn", input);
  return parseVoiceSettings({ projectLearned: res?.learned }).projectLearned;
}
