/**
 * WebCodecs `VideoDecoder` wrapper — Annex-B H.264 in, `<canvas>` frames out.
 *
 * Two config traps this guards against: (1) the codec string must come from the real
 * bitstream (`avc1-codec-string.ts` on the server derives it from the actual SPS) — a
 * hardcoded guess can mismatch the encoder's actual profile/level and make `configure()`
 * throw; (2) no `description` field is passed, which is what tells WebCodecs to expect
 * Annex-B (start-code-prefixed) input rather than length-prefixed AVCC — passing a
 * `description` here would silently break decode of every chunk this session sends.
 *
 * Self-healing on decode error: a mobile hardware decoder (confirmed: works on desktop Chrome,
 * dies on mobile Chromium after ~one GOP) can throw a hard decode error and never recover on its
 * own — WebCodecs offers no "just skip this frame" API once that happens, the decoder is dead.
 * Rather than freeze the stream forever, a decode error tears down the errored `VideoDecoder`
 * and creates a fresh one with the same cached codec string, then waits for the next server
 * keyframe before feeding it anything (same guard the very first connect already uses) — the
 * server sends one roughly every second (30-frame GOP @ 30fps), so recovery is bounded to about
 * that long instead of permanent.
 */
import { useCallback, useRef, useState } from "react";
import { frameTimestampMicros } from "./remote-desktop-frame-timestamp";

export type DecoderStatus = "idle" | "unsupported" | "ready" | "error";

/**
 * Whether an access unit should be fed to the decoder right now. Decode cannot start on a delta
 * chunk — true both on the very first connect (before any keyframe has arrived) and after an
 * auto-recovered decode error, since a freshly (re)created `VideoDecoder` has no prior reference
 * frame either way. A keyframe is always decodable on its own. Pure so this resync rule is
 * testable without a real `VideoDecoder`.
 */
export function shouldDecodeAccessUnit(hasSeenKeyframeThisInstance: boolean, isKey: boolean): boolean {
  return isKey || hasSeenKeyframeThisInstance;
}

/** The real WebCodecs error message plus which frame it died on — `status`/`errorMessage`
 *  only reflect a PERMANENT failure (recovery exhausted or impossible), so this is the one place
 *  a transient error that WAS recovered from is still visible (e.g. in a debug HUD). */
export interface LastDecoderError {
  message: string;
  frameIndex: number;
}

export interface UseH264CanvasDecoderResult {
  status: DecoderStatus;
  errorMessage: string | null;
  /** Configure (or reconfigure) the decoder once the server's `{type:"config"}` message
   *  arrives with a codec string derived from the real SPS. */
  configure: (codec: string) => Promise<void>;
  /** Feed one access unit (header byte already stripped by the caller) to the decoder. */
  decodeAccessUnit: (bytes: Uint8Array, isKey: boolean) => void;
  reset: () => void;
  /** Total frames the decoder has handed to `output()` (and drawn, or attempted to) since the
   *  last `reset()`. Ref-backed, not React state — read it from a poll (e.g. a debug HUD), not
   *  a render dependency, so every decoded frame doesn't force a re-render. */
  getFrameCount: () => number;
  /** The most recent decode error, recovered or not, or null if none yet this session. */
  getLastError: () => LastDecoderError | null;
  /** How many times a decode error has been auto-recovered from (fresh decoder + wait for next
   *  keyframe) since the last `reset()`. Repeated recovery roughly once per GOP points at a
   *  systemic decoder incompatibility rather than a one-off glitch. */
  getRecoveredCount: () => number;
}

export function useH264CanvasDecoder(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): UseH264CanvasDecoderResult {
  const [status, setStatus] = useState<DecoderStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const decodedAnyKeyRef = useRef(false);
  const frameCountRef = useRef(0);
  const frameIndexRef = useRef(0); // per-decoder-instance timestamp counter, see decodeAccessUnit
  const lastCodecRef = useRef<string | null>(null);
  const activeRef = useRef(false); // false once reset()/unmount has torn this session down
  const lastErrorRef = useRef<LastDecoderError | null>(null);
  const recoveredCountRef = useRef(0);

  const fail = useCallback((message: string) => {
    setStatus("error");
    setErrorMessage(message);
  }, []);

  const configure = useCallback(async (codec: string) => {
    lastCodecRef.current = codec;
    if (typeof VideoDecoder === "undefined") {
      setStatus("unsupported");
      setErrorMessage("This browser has no WebCodecs VideoDecoder — try Chrome, Edge, or Safari 16.4+.");
      return;
    }
    const config: VideoDecoderConfig = { codec, optimizeForLatency: true };
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) {
        setStatus("unsupported");
        setErrorMessage(`This browser's decoder does not support ${codec}.`);
        return;
      }
    } catch (e) {
      fail((e as Error).message);
      return;
    }

    decoderRef.current?.close();
    decodedAnyKeyRef.current = false;
    frameIndexRef.current = 0;
    const decoder = new VideoDecoder({
      output: (frame) => {
        frameCountRef.current += 1;
        const canvas = canvasRef.current;
        if (canvas) {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          if (!ctxRef.current) ctxRef.current = canvas.getContext("2d");
          ctxRef.current?.drawImage(frame, 0, 0, canvas.width, canvas.height);
        }
        frame.close();
      },
      error: (e) => recoverOrFail(e.message),
    });
    try {
      decoder.configure(config);
    } catch (e) {
      fail((e as Error).message);
      return;
    }
    decoderRef.current = decoder;
    activeRef.current = true;
    setStatus("ready");
    setErrorMessage(null);
  }, [canvasRef, fail]);

  /** Shared by the decoder's async `error` callback and `decodeAccessUnit`'s synchronous catch
   *  (a `.decode()` call can also throw directly) — both are "this decoder just broke", handled
   *  identically: record the real message + frame it died on, then recreate rather than give up,
   *  unless the session has already been torn down (`reset()`/unmount) or there is no cached
   *  codec to recreate with (should not happen — codec is cached before any decode is possible). */
  const recoverOrFail = useCallback((message: string) => {
    lastErrorRef.current = { message, frameIndex: frameCountRef.current };
    if (!activeRef.current) return; // torn down already — nothing to recover into
    const codec = lastCodecRef.current;
    if (!codec) { fail(message); return; }
    recoveredCountRef.current += 1;
    try { decoderRef.current?.close(); } catch { /* discarding the errored instance regardless */ }
    decoderRef.current = null;
    void configure(codec); // recreate; configure() itself resets decodedAnyKeyRef, so decode
    // waits for the next server keyframe instead of feeding a fresh decoder mid-GOP deltas.
  }, [configure, fail]);

  const decodeAccessUnit = useCallback((bytes: Uint8Array, isKey: boolean) => {
    const decoder = decoderRef.current;
    if (!decoder || decoder.state !== "configured") return;
    if (!shouldDecodeAccessUnit(decodedAnyKeyRef.current, isKey)) return;
    if (isKey) decodedAnyKeyRef.current = true;
    try {
      decoder.decode(new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: frameTimestampMicros(frameIndexRef.current++),
        data: bytes,
      }));
    } catch (e) {
      recoverOrFail((e as Error).message);
    }
  }, [recoverOrFail]);

  const reset = useCallback(() => {
    activeRef.current = false;
    // Closing an already-errored/half-configured decoder can throw in some browsers; this runs
    // from a React effect cleanup, and an uncaught throw there crashes the whole tree (no error
    // boundary catches effect-cleanup errors) — swallow it, we're discarding the decoder anyway.
    try { decoderRef.current?.close(); } catch { /* discarding regardless */ }
    decoderRef.current = null;
    decodedAnyKeyRef.current = false;
    frameCountRef.current = 0;
    frameIndexRef.current = 0;
    lastErrorRef.current = null;
    recoveredCountRef.current = 0;
    setStatus("idle");
    setErrorMessage(null);
  }, []);

  const getFrameCount = useCallback(() => frameCountRef.current, []);
  const getLastError = useCallback(() => lastErrorRef.current, []);
  const getRecoveredCount = useCallback(() => recoveredCountRef.current, []);

  return {
    status,
    errorMessage,
    configure,
    decodeAccessUnit,
    reset,
    getFrameCount,
    getLastError,
    getRecoveredCount,
  };
}
