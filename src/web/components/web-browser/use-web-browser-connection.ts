/**
 * The React side of one viewer: the connection, what the server last said (tabs, status, who
 * controls, dialogs, downloads, the AI banner), pictures onto the canvas, the viewport reported
 * from the picture area's real size, and visibility.
 *
 * The socket is open only while the view is visible. A hidden window, a background tab or a
 * phone with PPM in the background disconnects, which is what lets the browser stop when
 * nobody is looking (`browser-idle.ts`); coming back reconnects.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WebBrowserServerMessage, WebBrowserTabInfo, WebBrowserState } from "../../../shared/web-browser-protocol";
import { WebBrowserClient, type ConnState } from "@/lib/web-browser/web-browser-client";
import { FrameRenderer } from "@/lib/web-browser/frame-renderer";
import { PcmAudioPlayer } from "@/lib/web-browser/pcm-audio-player";
import { copyTextWithGesture, writeClientClipboard } from "@/components/remote-desktop/remote-desktop-clipboard-client";

type DialogMsg = Extract<WebBrowserServerMessage, { type: "dialog" }>;
type DownloadMsg = Extract<WebBrowserServerMessage, { type: "download" }>;
type BlockedMsg = Extract<WebBrowserServerMessage, { type: "blocked" }>;
type AiMsg = Extract<WebBrowserServerMessage, { type: "ai" }>;
type ChooserMsg = Extract<WebBrowserServerMessage, { type: "fileChooser" }>;

export interface WebBrowserViewState {
  conn: ConnState;
  connError: string | null;
  browser: WebBrowserState | null;
  browserMessage: string | null;
  ramMB: number | null;
  idleStopAt: number | null;
  tabs: WebBrowserTabInfo[];
  activeTabId: string | null;
  isController: boolean;
  dialog: DialogMsg | null;
  chooser: ChooserMsg | null;
  downloads: DownloadMsg[];
  blocked: BlockedMsg | null;
  ai: AiMsg | null;
  error: { code: string; message: string } | null;
  maxTabs: number;
  audioAvailable: boolean;
}

const INITIAL: WebBrowserViewState = {
  conn: "idle", connError: null, browser: null, browserMessage: null, ramMB: null, idleStopAt: null,
  tabs: [], activeTabId: null, isController: true, dialog: null, chooser: null, downloads: [], blocked: null,
  ai: null, error: null, maxTabs: 4, audioAvailable: false,
};

export function useWebBrowserConnection(opts: { mobile: boolean; visible: boolean; muted: boolean }) {
  const [state, setState] = useState<WebBrowserViewState>(INITIAL);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<WebBrowserClient | null>(null);
  const rendererRef = useRef<FrameRenderer | null>(null);
  const audioRef = useRef<PcmAudioPlayer | null>(null);
  const mutedRef = useRef(opts.muted);
  mutedRef.current = opts.muted;

  const patch = useCallback((p: Partial<WebBrowserViewState>) => setState((s) => ({ ...s, ...p })), []);

  const onMessage = useCallback((m: WebBrowserServerMessage) => {
    switch (m.type) {
      case "hello": return patch({ tabs: m.tabs, activeTabId: m.activeTabId, maxTabs: m.limits.maxTabs, audioAvailable: m.limits.audio });
      case "tabs": return patch({ tabs: m.list, activeTabId: m.activeTabId });
      case "status": return patch({ browser: m.state, browserMessage: m.message ?? null, ramMB: m.ramMB, idleStopAt: m.idleStopAt, ...(m.state === "running" ? { error: null } : {}) });
      case "controller": return patch({ isController: m.isYou });
      case "dialog": return patch({ dialog: m });
      case "dialog.closed": return setState((s) => (s.dialog?.id === m.id ? { ...s, dialog: null } : s));
      case "fileChooser": return patch({ chooser: m });
      case "download": return setState((s) => ({ ...s, downloads: [m, ...s.downloads.filter((d) => d.id !== m.id)].slice(0, 20) }));
      case "blocked": return patch({ blocked: m });
      case "ai": return patch({ ai: m });
      case "error": return patch({ error: { code: m.code, message: m.message } });
      case "clipboard.copy":
        void writeClientClipboard(m.text).then((ok) => { if (!ok) copyTextWithGesture(m.text); });
        return;
    }
  }, [patch]);

  const connect = useCallback(() => {
    clientRef.current?.close();
    const client = new WebBrowserClient({
      onState: (conn, err) => patch({ conn, connError: err ?? null }),
      onMessage,
      onPicture: (f) => rendererRef.current?.push(f),
      onSound: (f) => { if (!mutedRef.current) audioRef.current?.push(f); },
    });
    clientRef.current = client;
    rendererRef.current = new FrameRenderer((seq) => client.send({ type: "frame.ack", seq }));
    rendererRef.current.attach(canvasRef.current);
    void client.connect();
  }, [onMessage, patch]);

  // Open while visible, closed while hidden.
  useEffect(() => {
    if (!opts.visible) return;
    connect();
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
      patch({ conn: "idle" });
    };
  }, [opts.visible, connect, patch]);

  // Report the picture area's size whenever it changes (and once the socket opens).
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || state.conn !== "open") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      const r = surface.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return;
      clientRef.current?.send({ type: "viewport", cssWidth: Math.round(r.width), cssHeight: Math.round(r.height), dpr: Math.min(window.devicePixelRatio || 1, 3), mobile: opts.mobile });
    };
    report();
    clientRef.current?.send({ type: "visibility", visible: true });
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(report, 150);
    });
    ro.observe(surface);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [state.conn, opts.mobile]);

  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    rendererRef.current?.attach(el);
  }, []);

  /** Sound needs a gesture to start (autoplay policy); the first tap or click provides it. */
  const unlockAudio = useCallback(() => {
    if (!audioRef.current) audioRef.current = new PcmAudioPlayer();
    audioRef.current.resume();
  }, []);

  useEffect(() => () => { audioRef.current?.close(); }, []);

  const send = useCallback((m: Parameters<WebBrowserClient["send"]>[0]) => clientRef.current?.send(m), []);
  const latency = () => clientRef.current?.latencyMs ?? null;

  return { state, patch, send, connect, surfaceRef, attachCanvas, unlockAudio, latency };
}
