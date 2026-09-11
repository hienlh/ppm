/**
 * The browser half of the language-server bridge.
 *
 * One connection per project, shared by every editor open on it, because the
 * server shares one language-server process the same way. Editors register a
 * document and get back a status; providers ask questions through `request`.
 *
 * Two things this has to get right that a naive client does not:
 *
 * - **Reconnects lose the server's document state.** The socket layer replays
 *   messages it had queued, but a document opened before the drop was never
 *   queued, so the language server would answer questions about a file it has
 *   never been told the contents of. On the bridge's `hello` every registered
 *   document is opened again from its current text.
 * - **A request must always settle.** Monaco awaits provider promises; one that
 *   never resolves leaves the suggest widget spinning with no way out. Every
 *   request has a timeout, and a dropped socket rejects everything in flight.
 */
import { WsClient } from "@/lib/ws-client";

export interface LspServerInfo {
  id: string;
  displayName: string;
  rootPath: string;
}

export interface LspMissingServer {
  id: string;
  displayName: string;
  installHint: string;
}

export type LspDocumentStatus =
  | { state: "opening" }
  | { state: "ready"; languageId: string; server: LspServerInfo; projectPath: string; capabilities: Record<string, unknown> }
  | { state: "unavailable"; reason: string; server: LspMissingServer | null; message: string };

/** What an editor gives the connection so a document can be re-sent after a drop. */
export interface LspDocumentSource {
  getText: () => string;
  getVersion: () => number;
  /**
   * The Monaco model's own URI.
   *
   * Monaco names models `inmemory://model/N`, which no language server has
   * heard of. The bridge keeps both names so it can translate the server's
   * `file:` URIs back into something Monaco can match against this model.
   */
  clientUri: string;
}

/** How long a provider request may wait before it is treated as lost. */
const REQUEST_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Registered {
  source: LspDocumentSource;
  status: LspDocumentStatus;
}

export class LspConnection {
  private readonly ws: WsClient;
  private readonly docs = new Map<string, Registered>();
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly statusListeners = new Set<(path: string, status: LspDocumentStatus) => void>();
  private nextId = 1;

  constructor(readonly projectName: string) {
    this.ws = new WsClient(`/ws/project/${encodeURIComponent(projectName)}/lsp`);
    this.ws.onMessage((event) => this.receive(event));
    this.ws.connect();
  }

  // ── Documents ───────────────────────────────────────────────────────────

  open(path: string, source: LspDocumentSource): void {
    this.docs.set(path, { source, status: { state: "opening" } });
    this.setStatus(path, { state: "opening" });
    this.sendOpen(path);
  }

  private sendOpen(path: string): void {
    const entry = this.docs.get(path);
    if (!entry) return;
    this.send({
      t: "open",
      path,
      version: entry.source.getVersion(),
      text: entry.source.getText(),
      clientUri: entry.source.clientUri,
    });
  }

  close(path: string): void {
    if (!this.docs.delete(path)) return;
    this.send({ t: "close", path });
  }

  /**
   * Report an edit.
   *
   * `changes` are LSP content changes against `version - 1`. The bridge checks
   * that, and asks for a full resend if the sequence ever skips — a silently
   * desynchronised server answers every later question about lines that no
   * longer exist.
   */
  change(path: string, version: number, changes: Array<{ range: unknown; text: string }>): void {
    if (!this.docs.has(path)) return;
    this.send({ t: "change", path, version, changes });
  }

  save(path: string, text: string): void {
    if (!this.docs.has(path)) return;
    this.send({ t: "save", path, text });
  }

  statusOf(path: string): LspDocumentStatus | undefined {
    return this.docs.get(path)?.status;
  }

  // ── Requests ────────────────────────────────────────────────────────────

  request<T>(path: string, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const entry = this.docs.get(path);
    if (!entry || entry.status.state !== "ready") {
      return Promise.reject(new Error(`No language server is ready for ${path}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ t: "cancel", id });
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: "request", id, path, method, params });
    });
  }

  // ── Events ──────────────────────────────────────────────────────────────

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onStatus(listener: (path: string, status: LspDocumentStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  private send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  private receive(event: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }

    switch (msg.t) {
      case "hello":
        // A fresh socket, so the server knows nothing about our documents.
        for (const path of this.docs.keys()) this.sendOpen(path);
        break;

      case "ready":
        this.setStatus(String(msg.path), {
          state: "ready",
          languageId: String(msg.languageId),
          server: msg.server as LspServerInfo,
          projectPath: String(msg.projectPath ?? ""),
          capabilities: (msg.capabilities as Record<string, unknown>) ?? {},
        });
        break;

      case "unavailable":
        this.setStatus(String(msg.path), {
          state: "unavailable",
          reason: String(msg.reason),
          server: (msg.server as LspMissingServer | null) ?? null,
          message: String(msg.message),
        });
        break;

      case "resync": {
        // The bridge saw a version gap. Send the whole document rather than
        // another delta onto a copy we know is wrong.
        const path = String(msg.path);
        const entry = this.docs.get(path);
        if (entry) {
          this.send({ t: "change", path, version: entry.source.getVersion(), text: entry.source.getText() });
        }
        break;
      }

      case "response": {
        const pending = this.pending.get(Number(msg.id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(Number(msg.id));
        pending.resolve(msg.result);
        break;
      }

      case "error": {
        const pending = this.pending.get(Number(msg.id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(Number(msg.id));
        pending.reject(new Error(String(msg.message)));
        break;
      }

      case "notification":
        for (const listener of this.notificationListeners) {
          listener(String(msg.method), msg.params);
        }
        break;
    }
  }

  private setStatus(path: string, status: LspDocumentStatus): void {
    const entry = this.docs.get(path);
    if (entry) entry.status = status;
    for (const listener of this.statusListeners) listener(path, status);
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The language server connection was closed"));
    }
    this.pending.clear();
    this.docs.clear();
    this.notificationListeners.clear();
    this.statusListeners.clear();
    this.ws.disconnect();
  }
}

// ── Per-project sharing ────────────────────────────────────────────────────

const connections = new Map<string, { connection: LspConnection; holders: number }>();

/**
 * The connection for a project, created on first use.
 *
 * Shared and reference-counted: several editors on one project must not each
 * open a socket, since the server would then treat them as separate clients
 * and could not tell that they are looking at the same documents.
 */
export function acquireLspConnection(projectName: string): LspConnection {
  const existing = connections.get(projectName);
  if (existing) {
    existing.holders++;
    return existing.connection;
  }
  const connection = new LspConnection(projectName);
  connections.set(projectName, { connection, holders: 1 });
  return connection;
}

export function releaseLspConnection(projectName: string): void {
  const existing = connections.get(projectName);
  if (!existing) return;
  existing.holders--;
  if (existing.holders > 0) return;
  connections.delete(projectName);
  existing.connection.dispose();
}
