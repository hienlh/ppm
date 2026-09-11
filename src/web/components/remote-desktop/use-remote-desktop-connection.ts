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
import { useSettingsStore } from "@/stores/settings-store";
import { resolveRemoteDesktopWsUrl } from "./remote-desktop-ws-url";
import { useH264CanvasDecoder, type DecoderStatus } from "./use-h264-canvas-decoder";
import {
  DEFAULT_PRESET_ID, parsePresetId, type QualityChoice, type QualityPresetId,
} from "../../../shared/remote-desktop-quality";
import { CLIPBOARD_READ_DELAY_MS, writeClientClipboard } from "./remote-desktop-clipboard-client";
import { useOpusAudioPlayer } from "./use-opus-audio-player";

export type RemoteDesktopConnState = "connecting" | "streaming" | "error" | "closed";

const PING_INTERVAL_MS = 5_000;
/** First byte of every binary message. 0/1 are the video's delta/key flags, unchanged; audio is
 *  a third kind on the same socket rather than a second connection, which would need its own
 *  nonce and its own eviction rules. */
const FRAME_AUDIO = 2;

export interface UseRemoteDesktopConnectionResult {
  connState: RemoteDesktopConnState;
  errorMessage: string | null;
  decoderStatus: DecoderStatus;
  decoderErrorMessage: string | null;
  sendMessage: (msg: Record<string, unknown>) => void;
  /** Force a fresh connection (e.g. a manual "Reconnect" button). */
  reconnect: () => void;
  /** Total bytes of binary (access-unit) WS messages received since the last (re)connect.
   *  Ref-backed — poll it (e.g. the stats overlay), don't treat it as a render dependency. Feeds
   *  the KB/s stat; frame count below feeds fps. */
  getTotalBytes: () => number;
  /** Forwards the decoder's own frame counter (see `use-h264-canvas-decoder.ts`). */
  getFrameCount: () => number;
  /** Pixel size of the decoded picture, 0×0 until the first frame. What the `original`/`custom`
   *  scale modes multiply — see `remote-desktop-view-style.ts`. */
  frameSize: { width: number; height: number };
  /** The rung the *server* is actually streaming at, and whether it is free to change it
   *  itself. Both come from the server (`config`, then `quality` on every change) rather than
   *  from what was last requested: the host echoes the rung it settled on, and `held` says how
   *  much of that rung's bitrate the link is currently allowing (1 = all of it). */
  quality: { preset: QualityPresetId; held: number };
  /** Choose a rung. There is no `auto`: the adaptation always runs beneath whichever is
   *  chosen, so the choice is a ceiling rather than an off switch. */
  setQuality: (preset: QualityChoice) => void;
  /** Commit RustDesk's custom rung: a bitrate percentage and an fps. Also selects `custom`. */
  setCustomQuality: (percent: number, fps: number) => void;
  /** Whether the host pointer is drawn into the frames. Device pref, not a server report — the
   *  session never changes this by itself, so there is nothing to echo back. */
  showCursor: boolean;
  /** Toggle the host pointer. Respawns the host's ffmpeg (~400ms of held picture): every
   *  grabber takes `-draw_mouse`/`-capture_cursor` at startup and none can be retuned live. */
  setShowCursor: (show: boolean) => void;
  /** The encoder the host is *actually* running, or null while it is on its own first choice.
   *  Read back from the server rather than from the pref, because the server drops an encoder
   *  this host cannot run — so the menu shows what is live, not what was asked for. */
  codec: string | null;
  /** Ask the host for another H.264 encoder. Also a respawn. */
  setCodec: (encoder: string | null) => void;
  /** Whether the host is streaming its audio. Reported by the server, because it also turns
   *  this back off by itself when the host has no loopback device or its ffmpeg dies. */
  audioOn: boolean;
  /** Ask the host to start/stop streaming audio. Starting also resumes the `AudioContext`, so
   *  it has to be called from a real user gesture (a click), not from an effect. */
  setAudioOn: (on: boolean) => void;
  /** Audio tracks for the recorder to mux in; empty while audio is off. */
  getAudioTracks: () => MediaStreamTrack[];
  /** Local input blocked + host monitor blanked. Server-reported, because an engage can fail
   *  (a screen lock already holds the keyboard) and the switch must show what actually holds. */
  privacyOn: boolean;
  /** Why the last engage failed, or null. */
  privacyError: string | null;
  setPrivacyOn: (on: boolean) => void;
  /** The host mode id that is live now, read back from the host after every switch — so the
   *  picker ticks what the host is really doing rather than what was asked for. Null until the
   *  host has reported once (a non-X11 host never does). */
  hostModeId: string | null;
  /** The mode that was live before this session changed it, or null when it has changed none.
   *  Drives the "Original" item, exactly as RustDesk's `isOriginalResolutionSet` does. */
  hostOriginalModeId: string | null;
  /** Why the last switch failed, or null. */
  resolutionError: string | null;
  /** Ask the host to change its own display mode. Respawns the capture: `-video_size` is fixed
   *  at spawn, so the old grabber would keep reading a rectangle the framebuffer no longer has. */
  setHostMode: (modeId: string) => void;
  /** Text the host copied that could NOT be written to this device's clipboard automatically —
   *  `navigator.clipboard` is secure-context only and PPM is usually plain HTTP on a LAN. Non-null
   *  means the UI must offer a real click to copy it; null means nothing is pending. */
  pendingHostClipboard: string | null;
  /** Discard the pending text (copied it, or dismissed the notice). */
  clearHostClipboard: () => void;
  /** Put client text on the host clipboard; `paste` also presses the host's paste shortcut,
   *  with Shift when the user pressed Ctrl+Shift+V (a terminal's paste). */
  sendClipboard: (text: string, paste: boolean, shift?: boolean) => void;
  /** Ask the host for its clipboard, after `CLIPBOARD_READ_DELAY_MS` so a just-forwarded copy
   *  combo has actually landed on the host clipboard first. */
  requestHostClipboard: () => void;
}

export interface UseRemoteDesktopConnectionOptions {
  /** One of `/capabilities`' `displays[].id`; undefined = the host's primary display. Changing it
   *  tears the session down and reconnects on the new display — one ffmpeg per display. */
  displayId?: string;
}

export function useRemoteDesktopConnection(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  { displayId }: UseRemoteDesktopConnectionOptions = {},
): UseRemoteDesktopConnectionResult {
  const wsRef = useRef<WebSocket | null>(null);
  const totalBytesRef = useRef(0);
  const [connState, setConnState] = useState<RemoteDesktopConnState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0); // bump to force a manual reconnect
  const [quality, setQualityState] = useState<{ preset: QualityPresetId; held: number }>(() => {
    // Reflect the restored choice immediately: the server confirms it a moment later with its
    // own `quality` message, and until then the picker must not tick the wrong rung.
    const stored = parsePresetId(useSettingsStore.getState().remoteDesktopQuality);
    return { preset: stored ?? DEFAULT_PRESET_ID, held: 1 };
  });
  /** The user's pinned choice, re-applied after a reconnect (the server always starts a fresh
   *  session on `auto`). A ref, not state: this must never be a dependency of the effect that
   *  owns the socket, or changing quality would tear down the connection it is tuning.
   *
   *  Seeded from the device-local pref via `getState()` rather than the hook, for that same
   *  reason — subscribing would make the socket effect re-run on a quality change. `useRef`
   *  reads its argument on the first render only, which is exactly the "restore on open"
   *  semantics wanted here. */
  const pinnedRef = useRef<QualityChoice | null>(
    parsePresetId(useSettingsStore.getState().remoteDesktopQuality),
  );
  const [pendingHostClipboard, setPendingHostClipboard] = useState<string | null>(null);
  const clipboardReadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showCursor = useSettingsStore((s) => s.remoteDesktopShowCursor);
  const clipboardSync = useSettingsStore((s) => s.remoteDesktopClipboardSync);
  /** Mirrors of the two prefs above for the socket's own closures. The socket effect runs only
   *  on `generation`/`displayId`, so `onopen`/`onmessage` capture whatever these were when it
   *  last ran — reading the pref through a ref is what keeps a toggle mid-session honest
   *  without making a settings change tear the connection down. */
  const showCursorRef = useRef(showCursor);
  const clipboardSyncRef = useRef(clipboardSync);
  useEffect(() => { showCursorRef.current = showCursor; }, [showCursor]);
  useEffect(() => { clipboardSyncRef.current = clipboardSync; }, [clipboardSync]);
  /** Same ref-for-the-socket-closure reasoning; seeded from the pref so the first ffmpeg is
   *  already the right one. `codec` state is what the server confirmed. */
  const codecRef = useRef(useSettingsStore.getState().remoteDesktopCodec);
  const [codec, setCodecState] = useState<string | null>(codecRef.current);

  const decoder = useH264CanvasDecoder(canvasRef);
  const audio = useOpusAudioPlayer();
  const [audioOn, setAudioOn] = useState(false);
  const [privacyOn, setPrivacyOn] = useState(false);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [hostModeId, setHostModeId] = useState<string | null>(null);
  const [hostOriginalModeId, setHostOriginalModeId] = useState<string | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  /** Adopt whatever rung the server reports, from either `config` or `quality`. */
  const applyQualityMessage = useCallback((msg: Record<string, unknown>) => {
    const preset = parsePresetId(msg.preset);
    if (!preset) return;
    // `held` is absent whenever the link is allowing the whole rung, which is the normal case.
    const held = typeof msg.held === "number" && msg.held > 0 && msg.held < 1 ? msg.held : 1;
    setQualityState({ preset, held });
  }, []);

  /** The wire form of a rung. `custom` carries its two numbers, because the server cannot look
   *  them up — they live in this device's prefs, and the same session may be reconnected to. */
  const qualityMessage = useCallback((choice: QualityChoice): Record<string, unknown> => {
    if (choice !== "custom") return { type: "quality", preset: choice };
    const st = useSettingsStore.getState();
    return {
      type: "quality", preset: "custom",
      percent: st.remoteDesktopCustomQualityPercent,
      fps: st.remoteDesktopCustomFps,
    };
  }, []);

  const setQuality = useCallback((preset: QualityChoice) => {
    pinnedRef.current = preset;
    // Remembered per device so a LAN desktop reopens on its 60fps rung without being asked
    // again, while a phone keeps whatever that phone chose.
    useSettingsStore.getState().setRemoteDesktopQuality(preset);
    sendMessage(qualityMessage(preset));
  }, [qualityMessage, sendMessage]);

  /** Commit the custom dialog's numbers. Writes them first so `qualityMessage` reads the new
   *  pair, then re-sends — selecting "Custom" and then dragging a slider are the same request
   *  as far as the host is concerned. */
  const setCustomQuality = useCallback((percent: number, fps: number) => {
    const st = useSettingsStore.getState();
    st.setRemoteDesktopCustomQuality(percent, fps);
    st.setRemoteDesktopQuality("custom");
    pinnedRef.current = "custom";
    sendMessage(qualityMessage("custom"));
  }, [qualityMessage, sendMessage]);

  const requestPrivacy = useCallback((on: boolean) => {
    // Not optimistic, unlike audio: claiming the host is locked out when the grab was refused
    // is the one wrong answer that matters here, so the switch waits for the server.
    setPrivacyError(null);
    sendMessage({ type: "privacy", enabled: on });
  }, [sendMessage]);

  const requestAudio = useCallback((on: boolean) => {
    // Optimistic: the server confirms with its own `audio` message (and contradicts this when
    // the host cannot capture), but the AudioContext must be created inside this click.
    setAudioOn(on);
    if (!on) audio.reset();
    sendMessage({ type: "audio", enabled: on });
  }, [audio, sendMessage]);

  const setCodec = useCallback((encoder: string | null) => {
    codecRef.current = encoder;
    useSettingsStore.getState().setRemoteDesktopCodec(encoder);
    // null means "your choice": there is no message for that (ffmpeg has to be told *some*
    // encoder), so the session keeps the current one until the next connect. Reflected locally
    // so the menu does not claim the switch already happened.
    setCodecState(encoder);
    if (encoder) sendMessage({ type: "codec", encoder });
  }, [sendMessage]);

  const setHostMode = useCallback((modeId: string) => {
    // Not optimistic, for the same reason as privacy: the X server can refuse a mode, and a
    // picker that ticked it anyway would be describing a screen nobody has.
    setResolutionError(null);
    sendMessage({ type: "resolution", modeId });
  }, [sendMessage]);

  const setShowCursor = useCallback((show: boolean) => {
    showCursorRef.current = show;
    useSettingsStore.getState().setRemoteDesktopShowCursor(show);
    sendMessage({ type: "cursor", show });
  }, [sendMessage]);

  const sendClipboard = useCallback((text: string, paste: boolean, shift = false) => {
    sendMessage({ type: "clipboard", text, paste, shift });
  }, [sendMessage]);

  /** Coalesced: holding Ctrl+C repeats the keydown, and one read per repeat would spawn a
   *  clipboard helper per frame on the host. */
  const requestHostClipboard = useCallback(() => {
    if (clipboardReadTimer.current) clearTimeout(clipboardReadTimer.current);
    clipboardReadTimer.current = setTimeout(() => {
      clipboardReadTimer.current = null;
      sendMessage({ type: "clipboardRead" });
    }, CLIPBOARD_READ_DELAY_MS);
  }, [sendMessage]);

  const clearHostClipboard = useCallback(() => setPendingHostClipboard(null), []);

  useEffect(() => () => { if (clipboardReadTimer.current) clearTimeout(clipboardReadTimer.current); }, []);

  useEffect(() => {
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    setConnState("connecting");
    setErrorMessage(null);
    // A fresh session engages nothing, and the old session's grab died with its socket.
    setPrivacyOn(false);
    setPrivacyError(null);
    totalBytesRef.current = 0;
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
        // The cursor pref rides along with `auth`: the grabber takes it at startup, so sending
        // it as its own message would respawn ffmpeg immediately after every connect.
        ws.send(JSON.stringify({
          type: "auth", nonce, ...(displayId ? { displayId } : {}), cursor: showCursorRef.current,
          ...(codecRef.current ? { codec: codecRef.current } : {}),
        }));
        // Re-pin across a reconnect so a deliberate choice is not silently reset to balanced.
        if (pinnedRef.current) ws.send(JSON.stringify(qualityMessage(pinnedRef.current)));
        pingTimer = setInterval(() => sendMessage({ type: "ping" }), PING_INTERVAL_MS);
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(event.data); } catch { return; }
          if (msg.type === "config" && typeof msg.codec === "string") {
            // A second `config` arrives on every quality change: the new ffmpeg has its own SPS
            // and resolution, and `configure()` closes the old decoder and waits for a keyframe.
            applyQualityMessage(msg);
            setCodecState(typeof msg.encoder === "string" ? msg.encoder : null);
            decoder.configure(msg.codec).then(() => { if (!cancelled) setConnState("streaming"); });
          } else if (msg.type === "quality") {
            applyQualityMessage(msg);
          } else if (msg.type === "codec") {
            setCodecState(typeof msg.encoder === "string" ? msg.encoder : null);
          } else if (msg.type === "resolution") {
            setHostModeId(typeof msg.modeId === "string" ? msg.modeId : null);
            setHostOriginalModeId(typeof msg.original === "string" ? msg.original : null);
            setResolutionError(null);
          } else if (msg.type === "resolutionError") {
            setResolutionError(typeof msg.message === "string" ? msg.message : "The host refused the mode.");
          } else if (msg.type === "privacy") {
            setPrivacyOn(msg.enabled === true);
            setPrivacyError(typeof msg.reason === "string" ? msg.reason : null);
          } else if (msg.type === "audio") {
            const on = msg.enabled === true;
            setAudioOn(on);
            if (!on) { audio.reset(); return; }
            // The host announces its layout once the encoder's header has been parsed, which
            // is what the decoder needs before the first packet arrives.
            const channels = typeof msg.channels === "number" ? msg.channels : 2;
            const rate = typeof msg.sampleRate === "number" ? msg.sampleRate : 48_000;
            void audio.configure(channels, rate);
          } else if (msg.type === "clipboard" && typeof msg.text === "string") {
            // Sync can be turned off while a read is already in flight (the client's own
            // `clipboardRead` is delayed by 350ms), and "off" has to mean the host's text never
            // reaches this device's clipboard — so the check is here, at the one place it lands.
            if (!clipboardSyncRef.current) return;
            const text = msg.text;
            // Only surface the manual affordance when the automatic write actually failed, so a
            // secure-context client syncs silently and an HTTP one gets one button.
            void writeClientClipboard(text).then((wrote) => {
              if (!wrote && !cancelled) setPendingHostClipboard(text);
            });
          } else if (msg.type === "error") {
            setConnState("error");
            setErrorMessage(typeof msg.message === "string" ? msg.message : "Server error");
          }
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.length < 1) return;
        totalBytesRef.current += bytes.length;
        // Audio shares the socket, so the kind byte has to be read before anything is treated
        // as a video access unit — feeding an Opus packet to the H.264 decoder is a decode
        // error per 20ms, i.e. a stream that dies the moment sound is turned on.
        if (bytes[0] === FRAME_AUDIO) { audio.decodePacket(bytes.subarray(1)); return; }
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
      try { audio.reset(); } catch { /* tearing down regardless */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect is driven by `generation` + the display pick
  }, [generation, displayId]);

  const reconnect = useCallback(() => setGeneration((g) => g + 1), []);
  const getTotalBytes = useCallback(() => totalBytesRef.current, []);

  return {
    connState,
    errorMessage,
    decoderStatus: decoder.status,
    decoderErrorMessage: decoder.errorMessage,
    sendMessage,
    reconnect,
    getTotalBytes,
    getFrameCount: decoder.getFrameCount,
    frameSize: decoder.frameSize,
    quality,
    setQuality,
    setCustomQuality,
    showCursor,
    setShowCursor,
    codec,
    setCodec,
    audioOn,
    setAudioOn: requestAudio,
    getAudioTracks: audio.getTracks,
    privacyOn,
    privacyError,
    setPrivacyOn: requestPrivacy,
    hostModeId,
    hostOriginalModeId,
    resolutionError,
    setHostMode,
    pendingHostClipboard,
    clearHostClipboard,
    sendClipboard,
    requestHostClipboard,
  };
}
