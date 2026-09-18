import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/api-client";
import { recordingToWav } from "@/lib/voice-wav";

/**
 * The chat mic when Settings has it pointed at Whisper on the PPM host.
 *
 * Same shape as `useVoiceInput` (the browser's own recogniser) so the composer
 * can swap one for the other, with one extra state: Whisper is not streaming,
 * so there is a wait between "stopped talking" and "text appears" that the
 * button has to show — `isTranscribing`.
 *
 * `supported` is about recording, not recognising: any browser with
 * `MediaRecorder` can feed this, which is the point of doing it on the server.
 * Both still need a secure context — `navigator.mediaDevices` does not exist on
 * a plain-HTTP origin, so neither engine can reach the mic there.
 */
export function useWhisperVoiceInput(language = "vi") {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);

  const supported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof OfflineAudioContext !== "undefined";

  const start = useCallback(
    async (onResult: (text: string, isFinal: boolean) => void) => {
      if (!supported || recorderRef.current) return;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast.error("Microphone unavailable", { description: "Allow microphone access for this site." });
        return;
      }

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Release the mic before the wait, or the browser keeps its recording
        // indicator lit for the whole transcription.
        for (const track of stream.getTracks()) track.stop();
        recorderRef.current = null;
        setIsListening(false);

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (cancelledRef.current || chunks.length === 0) return;

        setIsTranscribing(true);
        try {
          const wav = await recordingToWav(new Blob(chunks, { type: recorder.mimeType }));
          const text = await postForTranscript(wav, language);
          if (text) onResult(text, true);
          else
            toast.info("Nothing was picked up", {
              description: "Speak closer to the mic, or check which input device is selected.",
            });
        } catch (e) {
          toast.error("Could not transcribe", { description: e instanceof Error ? e.message : String(e) });
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      setIsListening(true);
    },
    [supported, language],
  );

  /** Finish the recording and transcribe it. */
  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  /** Drop the recording — used when the message is sent while the mic is open. */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  return { isListening, isTranscribing, start, stop, cancel, supported };
}

async function postForTranscript(wav: Uint8Array, language: string): Promise<string> {
  const token = getAuthToken();
  const res = await fetch(`/api/speech/transcribe?lang=${encodeURIComponent(language)}`, {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: wav as BodyInit,
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { text: string }; error?: string } | null;
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data?.text ?? "";
}
