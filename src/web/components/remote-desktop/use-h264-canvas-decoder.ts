/**
 * WebCodecs `VideoDecoder` wrapper — Annex-B H.264 in, `<canvas>` frames out.
 *
 * Two config traps this guards against: (1) the codec string must come from the real
 * bitstream (`avc1-codec-string.ts` on the server derives it from the actual SPS) — a
 * hardcoded guess can mismatch the encoder's actual profile/level and make `configure()`
 * throw; (2) no `description` field is passed, which is what tells WebCodecs to expect
 * Annex-B (start-code-prefixed) input rather than length-prefixed AVCC — passing a
 * `description` here would silently break decode of every chunk this session sends.
 */
import { useCallback, useRef, useState } from "react";

export type DecoderStatus = "idle" | "unsupported" | "ready" | "error";

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
   *  a render dependency, so every decoded frame doesn't force a re-render. Temporary-debug use;
   *  safe to keep permanently too (near-zero cost), but nothing else needs it today. */
  getFrameCount: () => number;
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

  const fail = useCallback((message: string) => {
    setStatus("error");
    setErrorMessage(message);
  }, []);

  const configure = useCallback(async (codec: string) => {
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
      error: (e) => fail(e.message),
    });
    try {
      decoder.configure(config);
    } catch (e) {
      fail((e as Error).message);
      return;
    }
    decoderRef.current = decoder;
    setStatus("ready");
    setErrorMessage(null);
  }, [canvasRef, fail]);

  const decodeAccessUnit = useCallback((bytes: Uint8Array, isKey: boolean) => {
    const decoder = decoderRef.current;
    if (!decoder || decoder.state !== "configured") return;
    // Decode can't start on a delta chunk — guards a reconnect race, not normal operation
    // (the session's first AU is always a forced keyframe).
    if (!decodedAnyKeyRef.current && !isKey) return;
    if (isKey) decodedAnyKeyRef.current = true;
    try {
      decoder.decode(new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: performance.now() * 1000,
        data: bytes,
      }));
    } catch (e) {
      fail((e as Error).message);
    }
  }, [fail]);

  const reset = useCallback(() => {
    // Closing an already-errored/half-configured decoder can throw in some browsers; this runs
    // from a React effect cleanup, and an uncaught throw there crashes the whole tree (no error
    // boundary catches effect-cleanup errors) — swallow it, we're discarding the decoder anyway.
    try { decoderRef.current?.close(); } catch { /* discarding regardless */ }
    decoderRef.current = null;
    decodedAnyKeyRef.current = false;
    frameCountRef.current = 0;
    setStatus("idle");
    setErrorMessage(null);
  }, []);

  const getFrameCount = useCallback(() => frameCountRef.current, []);

  return { status, errorMessage, configure, decodeAccessUnit, reset, getFrameCount };
}
