/**
 * Owns one remote-desktop WS connection end to end: mints a session nonce, opens the socket,
 * feeds binary access units to the H.264 decoder, and answers the server's heartbeat ping.
 * Factored out of the desktop floating-window body so the mobile full-screen viewer can share
 * the exact same connection logic instead of a parallel implementation — see
 * `remote-desktop-window-content.tsx` (desktop) and `remote-desktop-mobile-view.tsx` (mobile),
 * both now thin callers of this hook.
 *
 * Connection is one-shot — a lost connection reports `connState: "closed"`/`"error"` and waits
 * for the caller to bump `reconnect()`. We deliberately do NOT auto-reconnect on every close (a
 * flaky link reconnecting in a loop would fight the server's "one session per host" eviction).
 * The one exception is the tab becoming visible again: browsers throttle the ping
 * `setInterval` in a backgrounded tab, so a user who glances away can trip the server's
 * heartbeat timeout — on return we re-ping (or, if the session already died, reconnect once).
 * That's a discrete user-driven event, not a loop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { resolveRemoteDesktopWsUrl } from "./remote-desktop-ws-url";
import { useH264CanvasDecoder, type DecoderStatus, type LastDecoderError } from "./use-h264-canvas-decoder";

export type RemoteDesktopConnState = "connecting" | "streaming" | "error" | "closed";

const PING_INTERVAL_MS = 5_000;

export interface UseRemoteDesktopConnectionResult {
  connState: RemoteDesktopConnState;
  errorMessage: string | null;
  decoderStatus: DecoderStatus;
  decoderErrorMessage: string | null;
  sendMessage: (msg: Record<string, unknown>) => void;
  /** Force a fresh connection (e.g. a manual "Reconnect" button). */
  reconnect: () => void;
  /** Total binary (access-unit) WS messages received since the last (re)connect. Ref-backed —
   *  poll it (e.g. a debug HUD), don't treat it as a render dependency. Tells apart "frames stop
   *  ARRIVING" (this stalls) from "frames arrive but stop DRAWING" (`getFrameCount` below stalls
   *  instead) when diagnosing a frozen stream. */
  getBinaryMessageCount: () => number;
  /** Forwards the decoder's own frame counter (see `use-h264-canvas-decoder.ts`) — the other
   *  half of the arriving-vs-drawing split above. */
  getFrameCount: () => number;
  /** Forwards the decoder's last (recovered-or-not) decode error — the REAL WebCodecs message,
   *  not the generic "decoder failure" `decoderErrorMessage` shows once recovery is exhausted. */
  getLastDecoderError: () => LastDecoderError | null;
  /** Forwards how many times the decoder has auto-recovered from a decode error. */
  getRecoveredCount: () => number;
}

export function useRemoteDesktopConnection(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): UseRemoteDesktopConnectionResult {
  const wsRef = useRef<WebSocket | null>(null);
  const binaryCountRef = useRef(0);
  const [connState, setConnState] = useState<RemoteDesktopConnState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0); // bump to force a manual reconnect

  const decoder = useH264CanvasDecoder(canvasRef);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    setConnState("connecting");
    setErrorMessage(null);
    binaryCountRef.current = 0;
    decoder.reset();

    (async () => {
      let nonce: string;
      try {
        // `wsPath` in the response is always "/ws/remote-desktop" — the client already knows
        // that path; the response is only consumed for the nonce.
        const res = await api.post<{ nonce: string; wsPath: string }>("/api/remote-desktop/session");
        nonce = res.nonce;
      } catch (e) {
        if (!cancelled) { setConnState("error"); setErrorMessage((e as Error).message); }
        return;
      }
      if (cancelled) return;

      const url = resolveRemoteDesktopWsUrl(window.location, import.meta.env.DEV, import.meta.env.VITE_DEV_API_PORT);
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", nonce }));
        pingTimer = setInterval(() => sendMessage({ type: "ping" }), PING_INTERVAL_MS);
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(event.data); } catch { return; }
          if (msg.type === "config" && typeof msg.codec === "string") {
            decoder.configure(msg.codec).then(() => { if (!cancelled) setConnState("streaming"); });
          } else if (msg.type === "error") {
            setConnState("error");
            setErrorMessage(typeof msg.message === "string" ? msg.message : "Server error");
          }
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.length < 1) return;
        binaryCountRef.current += 1;
        decoder.decodeAccessUnit(bytes.subarray(1), bytes[0] === 1);
      };
      ws.onerror = () => { if (!cancelled) { setConnState("error"); setErrorMessage("WebSocket error"); } };
      ws.onclose = () => { if (!cancelled) setConnState((s) => (s === "error" ? s : "closed")); };
    })();

    // A backgrounded tab throttles the ping interval, which can trip the server heartbeat. When
    // the tab is visible again, re-ping immediately; if the session already died, reconnect once
    // (bumping generation re-runs this effect). Fires only on the visible transition — not a loop.
    const onVisibility = () => {
      if (document.hidden || cancelled) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      else setGeneration((g) => g + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (pingTimer) clearInterval(pingTimer);
      // A throw here (e.g. closing a socket/decoder mid-teardown) runs inside an effect cleanup,
      // which no error boundary catches — left unguarded it can blank the entire app on unmount,
      // not just this component (this is what closing the mobile sheet used to do).
      try { wsRef.current?.close(); } catch { /* tearing down regardless */ }
      wsRef.current = null;
      try { decoder.reset(); } catch { /* tearing down regardless */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect is driven by `generation`
  }, [generation]);

  const reconnect = useCallback(() => setGeneration((g) => g + 1), []);
  const getBinaryMessageCount = useCallback(() => binaryCountRef.current, []);

  return {
    connState,
    errorMessage,
    decoderStatus: decoder.status,
    decoderErrorMessage: decoder.errorMessage,
    sendMessage,
    reconnect,
    getBinaryMessageCount,
    getFrameCount: decoder.getFrameCount,
    getLastDecoderError: decoder.getLastError,
    getRecoveredCount: decoder.getRecoveredCount,
  };
}
