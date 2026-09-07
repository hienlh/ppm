/**
 * Remote Desktop window body: mints a session nonce, opens the WS, feeds binary access
 * units to the H.264 decoder, and wires pointer/keyboard capture back over the same socket.
 *
 * Connection is one-shot — a lost connection shows "disconnected" with a manual reconnect
 * button. We deliberately do NOT auto-reconnect on every close (a flaky link reconnecting in a
 * loop would fight the server's "one session per host" eviction). The one exception is the tab
 * becoming visible again: browsers throttle the ping `setInterval` in a backgrounded tab, so a
 * user who glances away can trip the server's heartbeat timeout — on return we re-ping (or, if
 * the session already died, reconnect once). That's a discrete user-driven event, not a loop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw, MonitorX } from "lucide-react";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { api } from "@/lib/api-client";
import { resolveRemoteDesktopWsUrl } from "./remote-desktop-ws-url";
import { useH264CanvasDecoder } from "./use-h264-canvas-decoder";
import { useRemoteInputCapture } from "./use-remote-input-capture";

type ConnState = "connecting" | "streaming" | "unsupported" | "error" | "closed";

const PING_INTERVAL_MS = 5_000;

export default function RemoteDesktopWindowContent(_props: WindowContentProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0); // bump to force a manual reconnect

  const decoder = useH264CanvasDecoder(canvasRef);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  useRemoteInputCapture(canvasRef, sendMessage, connState === "streaming");

  useEffect(() => {
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    setConnState("connecting");
    setErrorMessage(null);
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
      wsRef.current?.close();
      wsRef.current = null;
      decoder.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect is driven by `generation`
  }, [generation]);

  const overlayMessage = decoder.status === "unsupported"
    ? decoder.errorMessage
    : connState === "error"
      ? errorMessage
      : connState === "closed"
        ? "Disconnected"
        : connState === "connecting"
          ? "Connecting…"
          : null;

  return (
    <div
      className="relative flex h-full w-full items-center justify-center bg-black"
      data-testid="remote-desktop-window"
      data-conn-state={connState}
    >
      <canvas ref={canvasRef} data-testid="remote-desktop-canvas" className="max-h-full max-w-full outline-none" />
      {overlayMessage && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-white">
          <MonitorX className="size-6 opacity-70" />
          <span className="max-w-sm text-center px-4">{overlayMessage}</span>
          {(connState === "error" || connState === "closed") && decoder.status !== "unsupported" && (
            <button
              onClick={() => setGeneration((g) => g + 1)}
              className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20"
            >
              <RotateCw className="size-3.5" /> Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
