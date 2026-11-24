/**
 * Settings → Voice Input → "Try it": say a few words (or use the bundled sample), and see what
 * Whisper on this host makes of them, how long it took and what it ran on — and, on a host whose
 * Whisper runs on a GPU, the same audio again on the CPU for comparison.
 *
 * The audio stays on this host: it is posted to PPM's own `/api/speech/test`, which hands it to
 * whisper-cli and deletes it after the run. The page keeps the WAV in memory only for the compare
 * button, and drops it with the result or when the pane closes.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Play, Square } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { TEXT_BUTTON } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import { useVoiceMessageRecorder } from "@/hooks/use-voice-message-recorder";
import { recordingToWav } from "@/lib/voice-wav";
import {
  TEST_MAX_SECONDS, TEST_SAMPLE_LANG, TEST_SAMPLE_URL, formatSeconds, ranOnText, runWhisperTest, speedup,
  type WhisperTestResult,
} from "@/lib/whisper-test-client";
import type { SpeechStatus } from "./whisper-status-types";

/** Real voice messages are Vietnamese by default, so the recorded test runs the same way. */
const RECORDING_LANG = "vi";

type Busy = null | "running" | "comparing";

export function WhisperTestPanel({ status }: { status: SpeechStatus }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<WhisperTestResult | null>(null);
  const [cpu, setCpu] = useState<WhisperTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const last = useRef<{ wav: Uint8Array; lang: string } | null>(null);

  const run = async (wav: Uint8Array, lang: string) => {
    last.current = { wav, lang };
    setResult(null); setCpu(null); setError(null); setBusy("running");
    try {
      setResult(await runWhisperTest(wav, lang, "default"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const recorder = useVoiceMessageRecorder((recording) => {
    setBusy("running");
    void recordingToWav(recording.blob)
      .then((wav) => run(wav, RECORDING_LANG))
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setBusy(null); });
  });

  // A test is a sentence, not a message: stop by itself, and show the seconds as they pass.
  useEffect(() => {
    if (!recorder.recording) return;
    setElapsed(0);
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    const limit = setTimeout(() => recorder.stop(), TEST_MAX_SECONDS * 1000);
    return () => { clearInterval(tick); clearTimeout(limit); };
  }, [recorder.recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the pane drops the audio and cancels a recording in progress.
  useEffect(() => () => { last.current = null; recorder.cancel(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runSample = async () => {
    setError(null); setBusy("running");
    try {
      const blob = await (await fetch(TEST_SAMPLE_URL)).blob();
      await run(await recordingToWav(blob), TEST_SAMPLE_LANG);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const compare = async () => {
    if (!last.current) return;
    setBusy("comparing"); setError(null);
    try {
      setCpu(await runWhisperTest(last.current.wav, last.current.lang, "cpu"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!status.ready) return null;
  const micOk = recorder.supported && typeof window !== "undefined" && window.isSecureContext;
  const gpuRun = result?.ranOn === "gpu";
  const faster = gpuRun && cpu ? speedup(result.ms, cpu.ms) : null;

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="whisper-test">
      <div>
        <p className="text-sm font-medium">Try it</p>
        <p className="text-xs text-muted-foreground">
          Say a sentence and see what Whisper writes and how long it takes. The audio stays on this host and is
          deleted after the run.
        </p>
      </div>

      {/* Buttons at the app's standard (design-guidelines rule 3): 28px, 26px on a phone, sized by
          their text — no taller variant for touch. */}
      <div className="flex flex-wrap gap-2">
        {micOk && (recorder.recording ? (
          <Button onClick={recorder.stop} className={cn(TEXT_BUTTON, "cursor-pointer")}>
            <Square className="size-3.5" />
            Stop · {elapsed}s / {TEST_MAX_SECONDS}s
          </Button>
        ) : (
          <Button
            onClick={() => void recorder.start()}
            disabled={busy !== null}
            className={cn(TEXT_BUTTON, "cursor-pointer")}
          >
            <Mic className="size-3.5" />
            Record a test
          </Button>
        ))}
        <Button
          variant="outline"
          onClick={() => void runSample()}
          disabled={busy !== null || recorder.recording}
          className={cn(TEXT_BUTTON, "cursor-pointer")}
        >
          <Play className="size-3.5" />
          Use the sample (11 s, English)
        </Button>
      </div>
      {!micOk && (
        <p className="text-xs text-muted-foreground">
          The microphone needs HTTPS or localhost here, so only the sample can be used on this page.
        </p>
      )}

      {busy === "running" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Transcribing on this host…
        </p>
      )}
      {error && <p className="text-xs text-error">{error}</p>}

      {result && (
        <div className="space-y-2 rounded-md bg-muted/50 p-3" data-testid="whisper-test-result">
          <p className="text-sm break-words">{result.text || <span className="text-muted-foreground">(no speech heard)</span>}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{formatSeconds(result.ms)}</span> · {ranOnText(result)}
          </p>
          {cpu && (
            <p className="text-xs text-muted-foreground" data-testid="whisper-test-compare">
              Same audio on the CPU: <span className="font-medium text-foreground">{formatSeconds(cpu.ms)}</span>
              {faster ? ` — ${faster}` : ""}
            </p>
          )}
          {gpuRun && !cpu && (
            <Button
              variant="outline"
              onClick={() => void compare()}
              disabled={busy !== null}
              className={cn(TEXT_BUTTON, "cursor-pointer")}
            >
              {busy === "comparing" && <Loader2 className="size-3.5 animate-spin" />}
              {busy === "comparing" ? "Running on the CPU…" : "Compare with the CPU"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
