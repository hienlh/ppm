type MessageHandler = (data: MessageEvent) => void;
type OpenHandler = () => void;
type CloseHandler = () => void;

const MAX_BACKOFF = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private openHandlers = new Set<OpenHandler>();
  private closeHandlers = new Set<CloseHandler>();
  private retryDelay = 1_000;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string) {}

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.stopped = false;
    this._open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.retryDelay = 1_000;
  }

  send(data: string | ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private _open(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error("[WsClient] Failed to open WebSocket:", err);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retryDelay = 1_000;
      this.openHandlers.forEach((h) => h());
    };

    this.ws.onmessage = (evt) => {
      this.messageHandlers.forEach((h) => h(evt));
    };

    this.ws.onclose = () => {
      this.closeHandlers.forEach((h) => h());
      if (!this.stopped) this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose fires after onerror — let it handle reconnect
    };
  }

  private _scheduleReconnect(): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this._open();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_BACKOFF);
  }
}
