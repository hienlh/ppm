/**
 * One viewer's connection to PPM's browser: mints a nonce, opens `/ws/web-browser`, presents the
 * nonce first, then sends input and receives pictures, sound and state.
 *
 * Reconnects by itself only when asked (`connect()` again): the server treats the newest viewer
 * as the one in control, so a loop reconnecting in the background would keep taking control
 * away from the device actually in use.
 */
import { api } from "@/lib/api-client";
import { withWsAuth } from "@/lib/ws-auth";
import type { WebBrowserClientMessage, WebBrowserServerMessage } from "../../../shared/web-browser-protocol";
import { decodeBinaryFrame, type PictureFrame, type SoundFrame } from "../../../shared/web-browser-binary-frames";

export type ConnState = "idle" | "connecting" | "open" | "closed" | "error";

export interface WebBrowserClientHandlers {
  onState(state: ConnState, error?: string): void;
  onMessage(msg: WebBrowserServerMessage): void;
  onPicture(frame: PictureFrame): void;
  onSound(frame: SoundFrame): void;
}

/**
 * Same origin, through Vite's `/ws` proxy in dev, unless `VITE_DEV_API_PORT` names the API port
 * to reach directly (the bypass other sockets use). Never a hard-coded 8081: a scratch e2e server
 * listens elsewhere, and 8081 may be someone's live dev PPM.
 */
export function webBrowserWsUrl(loc: Pick<Location, "protocol" | "hostname" | "host">, devPort?: string): string {
  const authed = withWsAuth("/ws/web-browser");
  if (devPort && loc.protocol !== "https:") return `ws://${loc.hostname}:${devPort}${authed}`;
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${authed}`;
}

export class WebBrowserClient {
  private ws: WebSocket | null = null;
  private lastInputAt = 0;
  /** Smoothed time from an input to the next picture, in ms; what the status chip shows. */
  latencyMs: number | null = null;

  constructor(private readonly h: WebBrowserClientHandlers) {}

  async connect(): Promise<void> {
    this.close();
    this.h.onState("connecting");
    let nonce: string;
    try {
      nonce = (await api.post<{ nonce: string; wsPath: string }>("/api/web-browser/session")).nonce;
    } catch (error) {
      this.h.onState("error", (error as Error)?.message ?? String(error));
      return;
    }
    const env = (import.meta as { env?: Record<string, string | boolean | undefined> }).env ?? {};
    const devPort = env.DEV === true && typeof env.VITE_DEV_API_PORT === "string" ? env.VITE_DEV_API_PORT : undefined;
    const ws = new WebSocket(webBrowserWsUrl(window.location, devPort));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", nonce }));
      this.h.onState("open");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try { this.h.onMessage(JSON.parse(ev.data) as WebBrowserServerMessage); } catch {}
        return;
      }
      const frame = decodeBinaryFrame(ev.data as ArrayBuffer);
      if (!frame) return;
      if (frame.kind === 1) {
        if (this.lastInputAt) {
          const sample = performance.now() - this.lastInputAt;
          this.latencyMs = this.latencyMs === null ? sample : Math.round(this.latencyMs * 0.7 + sample * 0.3);
          this.lastInputAt = 0;
        }
        this.h.onPicture(frame);
      } else {
        this.h.onSound(frame);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) {
        this.ws = null;
        this.h.onState("closed", ev.reason || undefined);
      }
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: WebBrowserClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (msg.type === "pointer" || msg.type === "key" || msg.type === "wheel" || msg.type === "text" || msg.type === "touch") {
      if (!this.lastInputAt) this.lastInputAt = performance.now();
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch {}
    }
  }
}
