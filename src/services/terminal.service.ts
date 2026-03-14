import type { Subprocess, Terminal } from "bun";

/** Max output buffer size per session (10KB) */
const MAX_BUFFER_SIZE = 10 * 1024;

/** Idle session timeout: 1 hour */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Reconnect grace period after WS disconnect */
const RECONNECT_GRACE_MS = 30 * 1000;

export interface TerminalSession {
  id: string;
  proc: Subprocess;
  terminal: Terminal;
  projectPath: string;
  createdAt: Date;
  /** Connected WebSocket (if any) */
  ws: unknown | null;
  /** Timeout to kill session after WS disconnect */
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Idle timeout timer */
  idleTimer: ReturnType<typeof setTimeout>;
}

export interface TerminalSessionInfo {
  id: string;
  projectPath: string;
  createdAt: string;
  connected: boolean;
}

type OutputCallback = (sessionId: string, data: string) => void;

class TerminalService {
  private sessions = new Map<string, TerminalSession>();
  private outputBuffers = new Map<string, string>();
  private outputListeners = new Map<string, OutputCallback>();

  /** Create a new terminal session using Bun's native PTY */
  create(projectPath: string, cols = 80, rows = 24): string {
    const id = crypto.randomUUID();
    const shellCmd = process.env.SHELL || "/bin/zsh";
    const decoder = new TextDecoder();

    const proc = Bun.spawn([shellCmd, "-l"], {
      cwd: projectPath,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      terminal: {
        cols,
        rows,
        data: (_terminal: Terminal, data: Uint8Array) => {
          const text = decoder.decode(data);
          this.appendBuffer(id, text);
          const listener = this.outputListeners.get(id);
          if (listener) listener(id, text);
        },
      },
    });

    const terminal = proc.terminal!;

    const session: TerminalSession = {
      id,
      proc,
      terminal,
      projectPath,
      createdAt: new Date(),
      ws: null,
      disconnectTimer: null,
      idleTimer: this.createIdleTimer(id),
    };

    this.sessions.set(id, session);
    this.outputBuffers.set(id, "");

    // When process exits, notify
    proc.exited.then(() => {
      const listener = this.outputListeners.get(id);
      if (listener) listener(id, "\r\n[Process exited]\r\n");
    });

    return id;
  }

  /** Write data to terminal via PTY */
  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.terminal.closed) return;

    this.resetIdleTimer(id);
    session.terminal.write(data);
  }

  /** Resize terminal PTY */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.terminal.closed) return;
    session.terminal.resize(cols, rows);
  }

  /** Kill a terminal session */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    clearTimeout(session.idleTimer);

    try {
      if (!session.terminal.closed) session.terminal.close();
    } catch {
      // Already closed
    }
    try {
      session.proc.kill();
    } catch {
      // Already dead
    }

    this.sessions.delete(id);
    this.outputBuffers.delete(id);
    this.outputListeners.delete(id);
  }

  /** Get buffered output for reconnect */
  getBuffer(id: string): string {
    return this.outputBuffers.get(id) ?? "";
  }

  /** List all active sessions */
  list(): TerminalSessionInfo[] {
    const result: TerminalSessionInfo[] = [];
    for (const [, session] of this.sessions) {
      result.push({
        id: session.id,
        projectPath: session.projectPath,
        createdAt: session.createdAt.toISOString(),
        connected: session.ws !== null,
      });
    }
    return result;
  }

  /** Get a session by ID */
  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /** Register output listener for a session (used by WS handler) */
  onOutput(id: string, callback: OutputCallback): void {
    this.outputListeners.set(id, callback);
  }

  /** Remove output listener */
  removeOutputListener(id: string): void {
    this.outputListeners.delete(id);
  }

  /** Mark session as connected to a WebSocket */
  setConnected(id: string, ws: unknown): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.ws = ws;

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = null;
    }
  }

  /** Mark session as disconnected — start grace period */
  setDisconnected(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.ws = null;

    session.disconnectTimer = setTimeout(() => {
      this.kill(id);
    }, RECONNECT_GRACE_MS);
  }

  /** Append to circular output buffer (max 10KB) */
  private appendBuffer(id: string, data: string): void {
    let buf = this.outputBuffers.get(id) ?? "";
    buf += data;
    if (buf.length > MAX_BUFFER_SIZE) {
      buf = buf.slice(buf.length - MAX_BUFFER_SIZE);
    }
    this.outputBuffers.set(id, buf);
  }

  /** Create idle timeout — kills session after IDLE_TIMEOUT_MS */
  private createIdleTimer(id: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.kill(id);
    }, IDLE_TIMEOUT_MS);
  }

  /** Reset idle timer on activity */
  private resetIdleTimer(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(id);
  }
}

export const terminalService = new TerminalService();
