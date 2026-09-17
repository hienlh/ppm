import { withWsAuth } from "@/lib/ws-auth";

type MessageHandler = (data: MessageEvent) => void;

const MAX_RECONNECT_DELAY = 30_000;
const BASE_DELAY = 1_000;

export interface WsClientOptions {
  /** Opt in only for protocols that regularly send heartbeat messages. */
  idleTimeoutMs?: number;
  onConnectionChange?: (connected: boolean) => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: MessageHandler[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  /** Messages queued while WS is still CONNECTING — flushed on open */
  private pendingMessages: (string | ArrayBuffer)[] = [];
  private visibilityHandler: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReceivedAt = 0;
  private connected = false;

  constructor(url: string, private options: WsClientOptions = {}) {
    this.url = url;
    // Reconnect immediately when page becomes visible (e.g. iPad wake from sleep)
    this.visibilityHandler = () => {
      const state = this.ws?.readyState;
      const stale = !!this.options.idleTimeoutMs && Date.now() - this.lastReceivedAt >= this.options.idleTimeoutMs;
      if (document.visibilityState === "visible" && !this.intentionalClose
        && (stale || (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING))) {
        this.reconnectAttempts = 0;
        this.connect();
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  connect(): void {
    this.intentionalClose = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cleanup();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Every app socket is authenticated at upgrade time; the token is read fresh
    // on each (re)connect so a re-login mid-session is picked up.
    const path = this.url.startsWith("ws") ? this.url : withWsAuth(this.url);
    let fullUrl: string;
    if (path.startsWith("ws")) {
      fullUrl = path;
    } else if (import.meta.env.DEV && path.startsWith("/ws/") && window.location.protocol !== "https:") {
      // Local dev over http: connect directly to backend (port 8081) to bypass
      // Vite's dev proxy which has unreliable WebSocket upgrade handling.
      // Over https (e.g. a Cloudflare tunnel) port 8081 isn't reachable and ws://
      // is blocked as mixed content, so fall through to same-origin wss:// proxy.
      fullUrl = `ws://${window.location.hostname}:8081${path}`;
    } else {
      fullUrl = `${protocol}//${window.location.host}${path}`;
    }

    this.ws = new WebSocket(fullUrl);
    this.lastReceivedAt = Date.now();
    this.armIdleCheck();

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastReceivedAt = Date.now();
      this.setConnected(true);
      // Send "ready" handshake — triggers server to send status/connected.
      // Through Cloudflare tunnels, the server's open-handler message may not
      // arrive because the end-to-end data path isn't fully established yet.
      // This roundtrip ensures the path is working before status is sent.
      try { this.ws?.send(JSON.stringify({ type: "ready" })); } catch {}
      // Flush any messages queued while WS was CONNECTING
      if (this.pendingMessages.length > 0) {
        console.log(`[ws] flushing ${this.pendingMessages.length} queued message(s)`);
        for (const msg of this.pendingMessages) {
          try { this.ws?.send(msg); } catch {}
        }
        this.pendingMessages = [];
      }
    };

    this.ws.onmessage = (event) => {
      this.lastReceivedAt = Date.now();
      for (const handler of this.handlers) {
        handler(event);
      }
    };

    this.ws.onclose = () => {
      this.clearIdleCheck();
      this.setConnected(false);
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.pendingMessages = [];
    this.cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  send(data: string | ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else if (!this.intentionalClose) {
      // Queue message — will be flushed when WS (re)connects
      console.warn(`[ws] WS not open (readyState=${this.ws?.readyState ?? "no-ws"}) — queuing message`);
      this.pendingMessages.push(data);
    } else {
      console.warn(`[ws] message dropped — WS intentionally closed`);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private cleanup(): void {
    this.clearIdleCheck();
    this.setConnected(false);
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.options.onConnectionChange?.(connected);
  }

  private clearIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleCheck(): void {
    this.clearIdleCheck();
    const timeout = this.options.idleTimeoutMs;
    if (!timeout || timeout <= 0 || !Number.isFinite(timeout)) return;
    const remaining = Math.max(0, timeout - (Date.now() - this.lastReceivedAt));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.intentionalClose) return;
      if (Date.now() - this.lastReceivedAt >= timeout) {
        // An OPEN socket can have a dead downstream without firing close/error.
        // A fresh handshake lets the server replay the active turn or idle history.
        this.connect();
      } else {
        this.armIdleCheck();
      }
    }, remaining);
  }
}
