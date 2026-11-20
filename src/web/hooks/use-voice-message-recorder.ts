import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { VOICE_MAX_SECONDS } from "../../shared/voice-message";

export interface VoiceRecording {
  blob: Blob;
  mimeType: string;
  durationSec: number;
}

/** A recording in progress: when it started, and the analyser the level bars read from. */
export interface VoiceRecordingSession {
  startedAt: number;
  analyser: AnalyserNode | null;
}

/**
 * Records one voice message: the mic through `MediaRecorder`, an `AnalyserNode` on the same
 * stream for the live level bars, and a stop at `VOICE_MAX_SECONDS` whatever the user does.
 *
 * Only start and stop change state here. The elapsed time and the levels are read by the
 * recording bar on its own clock, because the composer that owns this hook is large and a
 * re-render of it per animation frame would be felt while typing alongside.
 *
 * Stopping releases the mic at once (the browser's recording indicator goes out) and hands the
 * recording to `onFinished`; cancelling releases it and hands over nothing.
 */
export function useVoiceMessageRecorder(onFinished: (recording: VoiceRecording) => void) {
  const [session, setSession] = useState<VoiceRecordingSession | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startingRef = useRef(false);
  const cancelledRef = useRef(false);
  const stoppedAtRef = useRef(0);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const supported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof OfflineAudioContext !== "undefined";

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "recording") return;
    stoppedAtRef.current = performance.now();
    recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    if (!supported || recorderRef.current || startingRef.current) return;
    startingRef.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error("Microphone unavailable", { description: "Allow microphone access for this site." });
      return;
    } finally {
      startingRef.current = false;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (e) {
      for (const track of stream.getTracks()) track.stop();
      toast.error("Could not record", { description: e instanceof Error ? e.message : String(e) });
      return;
    }
    // The level bars are a nicety: a browser that refuses an AudioContext still records.
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
    } catch {
      analyser = null;
    }

    const chunks: Blob[] = [];
    const startedAt = performance.now();
    recorderRef.current = recorder;
    cancelledRef.current = false;
    const limit = setTimeout(stop, VOICE_MAX_SECONDS * 1000);

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      clearTimeout(limit);
      for (const track of stream.getTracks()) track.stop();
      void audioCtx?.close().catch(() => {});
      recorderRef.current = null;
      setSession(null);
      if (cancelledRef.current || chunks.length === 0) return;
      const elapsed = ((stoppedAtRef.current || performance.now()) - startedAt) / 1000;
      const mimeType = recorder.mimeType || chunks[0]?.type || "audio/webm";
      onFinishedRef.current({
        blob: new Blob(chunks, { type: mimeType }),
        mimeType,
        durationSec: Math.min(VOICE_MAX_SECONDS, Math.max(1, Math.round(elapsed))),
      });
    };

    stoppedAtRef.current = 0;
    recorder.start();
    setSession({ startedAt, analyser });
  }, [supported, stop]);

  // A composer unmounted mid-recording must not leave the mic on.
  useEffect(() => () => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  return { supported, session, recording: session !== null, start, stop, cancel };
}
