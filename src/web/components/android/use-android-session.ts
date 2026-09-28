/**
 * The viewer's half of `/ws/android`: mint a nonce, connect, decode, keep the lease alive.
 *
 * Four things here are load-bearing and each one looks optional until it is missing:
 *
 *  - **The nonce is minted per connection attempt, and it is single use.** A reconnect mints a
 *    new one; reusing the old one is rejected by design, so the retry path must go through the
 *    route again rather than caching it.
 *  - **The heartbeat is what holds the controller lease.** Stop sending for 15 seconds and the
 *    server hands control to someone else — which is the intended behaviour for a closed laptop
 *    lid, and a bug if the timer is tied to a render.
 *  - **The decoder is reconfigured from the server's `codec` message, never from a guess.** The
 *    encoder sets no profile or level, so the string is encoder-default and only knowable from
 *    the real SPS. A rung switch and a rotation both produce a new one.
 *  - **Deltas before a keyframe are dropped.** A `VideoDecoder` cannot start on one, and neither
 *    can a freshly recreated one after an error — `shouldDecodeAccessUnit` is the shared rule.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useH264CanvasDecoder, shouldDecodeAccessUnit } from "@/components/remote-desktop/use-h264-canvas-decoder";
import { resolveAndroidWsUrl } from "./android-ws-url";
import {
  ANDROID_PROTOCOL_VERSION, decodeVideoFrame,
  type AndroidClientMessage, type AndroidGeometry, type AndroidLogEntry, type AndroidQuality,
  type AndroidServerMessage,
} from "../../../shared/android-protocol";

const HEARTBEAT_MS = 5_000;
/** Long enough that a phone switching cell tower does not lose the picture, short enough that a
 *  dead socket is noticed. Backed off so a server that is down is not hammered. */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export type AndroidConnectionState = "connecting" | "live" | "reconnecting" | "failed";

export interface UseAndroidSessionOptions {
  deviceId: string;
  quality: AndroidQuality;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Paused sessions stop receiving frames; the emulator and the lease stay up. */
  paused?: boolean;
}

export interface AndroidSession {
  state: AndroidConnectionState;
  errorMessage: string | null;
  geometry: AndroidGeometry | null;
  controller: boolean;
  controllerReason: string | null;
  encoder: string | null;
  /** Null until the first keyframe has been decoded — the viewer shows a spinner until then. */
  hasPicture: boolean;
  send: (message: AndroidClientMessage) => void;
  takeControl: () => void;
  reconnect: () => void;
  /**
   * Turn the device's log feed on or off.
   *
   * The server stops the gRPC stream when the last watcher leaves (plan gate: "logs hidden
   * ngừng subscription"), so this is not a client-side filter — asking for it off really does
   * stop the work on the host.
   */
  setLogcat: (on: boolean) => void;
  /**
   * Listen for log batches. Deliberately a subscription rather than state: a chatty device
   * produces hundreds of entries a second, and putting them in this hook's state would
   * re-render the canvas's parent at that rate.
   */
  onLog: (listener: (entries: AndroidLogEntry[]) => void) => () => void;
}

export function useAndroidSession(opts: UseAndroidSessionOptions): AndroidSession {
  const { deviceId, quality, canvasRef, paused = false } = opts;

  const [state, setState] = useState<AndroidConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<AndroidGeometry | null>(null);
  const [controller, setController] = useState(false);
  const [controllerReason, setControllerReason] = useState<string | null>(null);
  const [encoder, setEncoder] = useState<string | null>(null);
  const [hasPicture, setHasPicture] = useState(false);

  const decoder = useH264CanvasDecoder(canvasRef);
  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  // Bumped by every connection attempt, and only the newest may act. The socket a manual
  // reconnect replaced still fires `onclose` after its handshake, and a nonce request can still
  // be out when the viewer closes: left to run, either one would clear the live socket's ref,
  // schedule a retry nobody asked for, or open a socket nothing will ever close.
  const generationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configuredCodecRef = useRef<string | null>(null);
  // Read inside the socket's handlers, which are created once per connection — a state read
  // there would be the value from the render that created them.
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const hasPictureRef = useRef(false);
  const logListenersRef = useRef(new Set<(entries: AndroidLogEntry[]) => void>());
  // Survives a reconnect: the subscription is per socket on the server, so a dropped connection
  // silently ends it and the panel would show a log that stopped without saying why.
  const logcatWantedRef = useRef(false);

  const send = useCallback((message: AndroidClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const takeControl = useCallback(() => send({ type: "take-control" }), [send]);

  const handleServerMessage = useCallback((message: AndroidServerMessage) => {
    switch (message.type) {
      case "ready":
        attemptRef.current = 0;
        setState("live");
        setErrorMessage(null);
        setGeometry(message.geometry);
        setController(message.controller);
        setControllerReason(null);
        setEncoder(message.encoder);
        if (message.codec) {
          configuredCodecRef.current = message.codec;
          void decoder.configure(message.codec);
        }
        if (logcatWantedRef.current) send({ type: "logcat", subscribe: true });
        return;
      case "log":
        for (const listener of logListenersRef.current) listener(message.entries);
        return;
      case "codec":
        if (message.codec === configuredCodecRef.current) return;
        configuredCodecRef.current = message.codec;
        void decoder.configure(message.codec);
        return;
      case "geometry":
        setGeometry(message.geometry);
        // The decoder is holding parameters for a size that no longer exists; the server's
        // `codec` message for the new bitstream is what reconfigures it.
        decoder.reset();
        setHasPicture(false);
        return;
      case "controller":
        setController(message.controller);
        setControllerReason(message.reason ?? null);
        return;
      case "error":
        setErrorMessage(message.message);
        return;
      default:
        return;
    }
  }, [decoder, send]);

  /** Silence the current attempt: its callbacks stop acting, its socket and retry are dropped. */
  const retire = useCallback(() => {
    generationRef.current += 1;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    retire();
    const generation = generationRef.current;
    const current = () => generationRef.current === generation;
    setErrorMessage(null);

    let nonce: string;
    try {
      // Single use and short-lived: a reconnect must mint a fresh one, never replay this.
      const res = await api.post<{ nonce: string }>(`/api/android/devices/${encodeURIComponent(deviceId)}/sessions`, {});
      nonce = res.nonce;
    } catch (e) {
      if (!current()) return;
      setErrorMessage((e as Error).message);
      setState("failed");
      return;
    }
    if (!current()) return;

    const socket = new WebSocket(resolveAndroidWsUrl(window.location, import.meta.env.DEV));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "auth", nonce, quality: qualityRef.current } satisfies AndroidClientMessage));
    };

    socket.onmessage = (event) => {
      // A replaced socket can still deliver what was queued before its close: its `ready` would
      // mark the viewer live, and its frames would feed the decoder, while the new one connects.
      if (!current()) return;
      if (typeof event.data === "string") {
        try { handleServerMessage(JSON.parse(event.data) as AndroidServerMessage); } catch { /* not ours */ }
        return;
      }
      const frame = decodeVideoFrame(event.data as ArrayBuffer);
      // A frame that fails to decode here was truncated or coalesced in transit; feeding its
      // bytes to the decoder anyway is how a stream turns to garbage rather than erroring.
      if (!frame || frame.header.version !== ANDROID_PROTOCOL_VERSION) return;
      if (!shouldDecodeAccessUnit(hasPictureRef.current, frame.header.keyframe)) return;
      hasPictureRef.current = true;
      setHasPicture(true);
      decoder.decodeAccessUnit(frame.payload, frame.header.keyframe);
    };

    socket.onclose = () => {
      if (!current()) return;
      socketRef.current = null;
      const delay = RECONNECT_DELAYS_MS[Math.min(attemptRef.current, RECONNECT_DELAYS_MS.length - 1)]!;
      attemptRef.current += 1;
      setState(attemptRef.current > RECONNECT_DELAYS_MS.length ? "failed" : "reconnecting");
      hasPictureRef.current = false;
      setHasPicture(false);
      decoder.reset();
      configuredCodecRef.current = null;
      reconnectTimerRef.current = setTimeout(() => { void connect(); }, delay);
    };

    socket.onerror = () => { /* onclose does the work; this only stops an unhandled event */ };
  }, [deviceId, decoder, handleServerMessage, retire]);

  useEffect(() => {
    void connect();
    return () => {
      retire();
      decoder.reset();
    };
    // `connect` is stable per deviceId; re-running on every decoder identity change would
    // reconnect the socket for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // The heartbeat is the lease. A tab that stops sending loses control after 15s but keeps
  // watching, so this runs regardless of whether this client currently holds it.
  useEffect(() => {
    const timer = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [send]);

  useEffect(() => { send({ type: "visibility", visible: !paused }); }, [paused, send]);

  useEffect(() => {
    if (state === "live") send({ type: "quality", quality });
  }, [quality, state, send]);

  const setLogcat = useCallback((on: boolean) => {
    logcatWantedRef.current = on;
    send({ type: "logcat", subscribe: on });
  }, [send]);

  const onLog = useCallback((listener: (entries: AndroidLogEntry[]) => void) => {
    const set = logListenersRef.current;
    set.add(listener);
    return () => { set.delete(listener); };
  }, []);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setState("connecting");
    void connect();
  }, [connect]);

  return {
    state,
    errorMessage: errorMessage ?? decoder.errorMessage,
    geometry,
    controller,
    controllerReason,
    encoder,
    hasPicture,
    send,
    takeControl,
    reconnect,
    setLogcat,
    onLog,
  };
}
