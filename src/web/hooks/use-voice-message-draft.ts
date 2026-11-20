import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { recordingToWav } from "@/lib/voice-wav";
import { randomId } from "@/lib/utils";
import { postVoiceMessage, VoiceMessageError } from "@/lib/voice-message-client";
import type { VoiceTimings } from "@/lib/voice-message-timings";
import { transcriptFailureAction, voiceFileName } from "@/lib/voice-message-compose";
import type { VoicePart } from "../../shared/voice-message";
import type { VoiceRecording } from "./use-voice-message-recorder";

/** The one voice message waiting in a composer: its recording, upload and transcript. */
export interface VoiceDraft {
  id: string;
  /** The recording as a blob URL, for the chip's player. Revoked when the draft goes. */
  localUrl: string;
  durationSec: number;
  upload: { status: "uploading" | "done" | "error"; path?: string };
  transcript: {
    status: "processing" | "ready" | "error";
    startedAt: number;
    /** The text PPM put in the box (tidied, or raw when the clean-up failed). */
    shown: string;
    /** Whisper's own text, before the clean-up: for the user to compare, never sent. */
    raw?: string;
    cleaned: boolean;
    /** The clean-up is off in Settings: the raw text is the intended one, not a failure. */
    cleanupSkipped?: boolean;
    cleanupError?: string;
    transcribeMs: number;
    cleanupMs: number;
    /** Each step's seconds, for the line under the transcript. */
    timings?: VoiceTimings;
    /** The server's setting when it answered: fresher than the one the composer read at mount. */
    reviewBeforeSend?: boolean;
    error?: string;
  };
}

export interface VoiceDraftDeps {
  project?: string;
  sessionId?: string;
  providerId?: string;
  /** What is typed in the composer right now: the clean-up reads it as context. */
  getTyped: () => string;
  uploadFile: (file: File) => Promise<string | null>;
  discardUpload: (path: string) => Promise<void> | void;
  onWhisperMissing: () => void;
}

/**
 * The composer's voice draft. Upload and transcript start together the moment recording stops;
 * every late answer is checked against the draft id, so a draft removed meanwhile is never
 * revived, and an upload that lands after the removal is deleted rather than left orphaned.
 *
 * The text the user edits lives in a ref, not in state: the composer avoids re-rendering on
 * every keystroke, and the send reads the ref.
 */
export function useVoiceMessageDraft(deps: VoiceDraftDeps) {
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const draftRef = useRef<VoiceDraft | null>(null);
  const textRef = useRef("");
  // Whether the user emptied the transcript. State, unlike the text, so the send button follows
  // it; it changes only when the block goes from empty to not, never on every keystroke.
  const [blank, setBlank] = useState(false);
  const blobRef = useRef<{ id: string; recording: VoiceRecording } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const commit = useCallback((next: VoiceDraft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const patch = useCallback((id: string, change: (d: VoiceDraft) => VoiceDraft) => {
    const current = draftRef.current;
    if (current?.id === id) commit(change(current));
  }, [commit]);

  /** Drop the draft. `keepUpload` is for a send: the message now names that file. */
  const clear = useCallback((keepUpload: boolean) => {
    const current = draftRef.current;
    if (!current) return;
    abortRef.current?.abort();
    abortRef.current = null;
    URL.revokeObjectURL(current.localUrl);
    if (!keepUpload && current.upload.path) void depsRef.current.discardUpload(current.upload.path);
    blobRef.current = null;
    textRef.current = "";
    setBlank(false);
    commit(null);
  }, [commit]);

  const runUpload = useCallback(async (id: string, recording: VoiceRecording) => {
    const file = new File([recording.blob], voiceFileName(recording.mimeType), { type: recording.mimeType });
    const path = await depsRef.current.uploadFile(file).catch(() => null);
    if (draftRef.current?.id !== id) {
      if (path) void depsRef.current.discardUpload(path);
      return;
    }
    patch(id, (d) => ({ ...d, upload: path ? { status: "done", path } : { status: "error" } }));
  }, [patch]);

  const runTranscript = useCallback(async (id: string, recording: VoiceRecording) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const { project, sessionId, providerId, getTyped } = depsRef.current;
    patch(id, (d) => ({ ...d, transcript: { ...d.transcript, status: "processing", startedAt: Date.now(), error: undefined } }));
    try {
      const convertStarted = performance.now();
      const wav = await recordingToWav(recording.blob);
      const requestStarted = performance.now();
      const result = await postVoiceMessage({
        wav, project: project ?? "", sessionId, providerId, typed: getTyped().trim() || undefined, signal: controller.signal,
      });
      const timings: VoiceTimings = {
        browserConvertMs: requestStarted - convertStarted, requestMs: performance.now() - requestStarted,
        serverMs: result.serverMs, receiveMs: result.receiveMs, convertMs: result.convertMs,
        transcribeMs: result.transcribeMs, cleanupMs: result.cleanupMs, cleaned: result.cleaned, cleanupSkipped: result.cleanupSkipped,
      };
      if (draftRef.current?.id !== id) return;
      if (!result.text.trim()) {
        clear(false);
        toast.info("Nothing was picked up", { description: "Speak closer to the mic, or check which input device is selected." });
        return;
      }
      textRef.current = result.text;
      setBlank(false);
      patch(id, (d) => ({
        ...d,
        transcript: {
          status: "ready", startedAt: d.transcript.startedAt, shown: result.text, raw: result.raw, cleaned: result.cleaned,
          cleanupSkipped: result.cleanupSkipped,
          cleanupError: result.cleanupError, transcribeMs: result.transcribeMs, cleanupMs: result.cleanupMs,
          timings, reviewBeforeSend: result.reviewBeforeSend,
        },
      }));
    } catch (e) {
      if (controller.signal.aborted || draftRef.current?.id !== id) return;
      const action = transcriptFailureAction(e instanceof VoiceMessageError ? e.code : undefined);
      if (action === "whisper-missing") {
        clear(false);
        depsRef.current.onWhisperMissing();
        return;
      }
      // Turned off elsewhere mid-transcript: no install dialog, which would be the wrong answer.
      // The draft stays as a failure, so its Remove (and the chip's ×) still clear it.
      if (action === "turned-off") toast.info("Voice messages are turned off", { description: "Turn them on again in Settings → Voice." });
      const message = e instanceof Error ? e.message : String(e);
      patch(id, (d) => ({ ...d, transcript: { ...d.transcript, status: "error", error: message } }));
    }
  }, [patch, clear]);

  /** A finished recording becomes the draft; a second one while a draft exists is ignored. */
  const begin = useCallback((recording: VoiceRecording) => {
    if (draftRef.current) return;
    const id = randomId();
    blobRef.current = { id, recording };
    textRef.current = "";
    commit({
      id,
      localUrl: URL.createObjectURL(recording.blob),
      durationSec: recording.durationSec,
      upload: { status: "uploading" },
      transcript: { status: "processing", startedAt: Date.now(), shown: "", cleaned: false, transcribeMs: 0, cleanupMs: 0 },
    });
    void runUpload(id, recording);
    void runTranscript(id, recording);
  }, [commit, runUpload, runTranscript]);

  /** Run again whatever failed: the transcript, the upload, or both. */
  const retry = useCallback(() => {
    const current = draftRef.current;
    const held = blobRef.current;
    if (!current || held?.id !== current.id) return;
    if (current.upload.status === "error") {
      patch(current.id, (d) => ({ ...d, upload: { status: "uploading" } }));
      void runUpload(current.id, held.recording);
    }
    if (current.transcript.status === "error") void runTranscript(current.id, held.recording);
  }, [patch, runUpload, runTranscript]);

  const setText = useCallback((text: string) => {
    textRef.current = text;
    setBlank(!text.trim());
  }, []);

  /** The voice part to send, or null when there is no ready draft with an uploaded file. */
  const voicePart = useCallback((): VoicePart | null => {
    const current = draftRef.current;
    if (!current?.upload.path || current.transcript.status !== "ready") return null;
    return { path: current.upload.path, durationSec: current.durationSec, transcript: textRef.current };
  }, []);

  // A composer closed with a voice still in it: nothing will ever send that upload, so it goes,
  // and one still on its way is deleted when it lands (its id no longer matches).
  useEffect(() => () => {
    const current = draftRef.current;
    abortRef.current?.abort();
    draftRef.current = null;
    if (!current) return;
    URL.revokeObjectURL(current.localUrl);
    if (current.upload.path) void depsRef.current.discardUpload(current.upload.path);
  }, []);

  const remove = useCallback(() => clear(false), [clear]);
  const sent = useCallback(() => clear(true), [clear]);
  return { draft, blank, begin, retry, setText, voicePart, remove, sent };
}
