import type { Subprocess } from "bun";

/** Max output buffer size per session (10KB) */
const MAX_BUFFER_SIZE = 10 * 1024;

/** Idle session timeout: 1 hour */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Reconnect grace period after WS disconnect */
const RECONNECT_GRACE_MS = 30 * 1000;

export interface TerminalSession {
  id: string;
  proc: Subprocess;
  projectPath: string;
  createdAt: Date;
  /** Connected WebSocket (if any) */
  ws: unknown | null;
  /** Timeout to kill session after WS disconnect */
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Idle timeout timer */
  idleTimer: ReturnType<typeof setTimeout>;
  /** Readable stream reader for stdout */
  stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null;
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

  /** Create a new terminal session */
  create(projectPath: string, shell?: string): string {
    const id = crypto.randomUUID();
    const shellCmd = shell || process.env.SHELL || "bash";

    // Use bash with minimal init to avoid zsh/powerlevel10k issues in pipe mode.
    // Pipe mode doesn't create a real TTY, but bash works fine for interactive use.
    // Use bash -i for interactive mode (handles echo/prompt natively)
    // Suppress macOS zsh migration warning and job control message
    const proc = Bun.spawn(["bash", "--norc", "-i"], {
      cwd: projectPath,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: "120",
        LINES: "24",
        PS1: "\\[\\033[1;34m\\]\\u@ppm\\[\\033[0m\\]:\\[\\033[1;36m\\]\\w\\[\\033[0m\\]\\$ ",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const session: TerminalSession = {
      id,
      proc,
      projectPath,
      createdAt: new Date(),
      ws: null,
      disconnectTimer: null,
      idleTimer: this.createIdleTimer(id),
      stdoutReader: null,
    };

    this.sessions.set(id, session);
    this.outputBuffers.set(id, "");

    // Start reading stdout
    this.pipeOutput(id, proc);

    return id;
  }

  /** Write data to terminal stdin — bash -i handles echo natively */
  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.resetIdleTimer(id);
    const stdin = session.proc.stdin;
    if (!stdin) return;

    try {
      const sink = stdin as unknown as { write(data: Uint8Array): number; flush(): void };
      // Convert \r to \n for bash (xterm sends \r on Enter)
      const normalized = data.replace(/\r/g, "\n");
      sink.write(new TextEncoder().encode(normalized));
      sink.flush();
    } catch {
      // stdin closed
    }
  }

  /** Resize terminal (no-op for pipe mode, but kept for API compatibility) */
  resize(_id: string, _cols: number, _rows: number): void {
    // Bun.spawn with stdin:"pipe"/stdout:"pipe" doesn't support resize.
    // Resize is only possible with the `terminal` option (Bun nightly).
    // This is a no-op for now; the frontend xterm.js still renders correctly.
  }

  /** Kill a terminal session */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    clearTimeout(session.idleTimer);

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

    // Cancel disconnect timer
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

    // Start grace timer — kill if not reconnected
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

  /** Pipe stdout + stderr to buffer and listeners */
  private async pipeOutput(id: string, proc: Subprocess): Promise<void> {
    const decoder = new TextDecoder();

    const readStream = async (
      stream: ReadableStream<Uint8Array> | null,
    ) => {
      if (!stream) return;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          this.appendBuffer(id, text);
          const listener = this.outputListeners.get(id);
          if (listener) listener(id, text);
        }
      } catch {
        // Stream closed
      } finally {
        reader.releaseLock();
      }
    };

    // Read both stdout and stderr concurrently
    readStream(proc.stdout as ReadableStream<Uint8Array> | null);
    readStream(proc.stderr as ReadableStream<Uint8Array> | null);

    // When process exits, clean up after a delay
    proc.exited.then(() => {
      // Notify listener that process exited
      const listener = this.outputListeners.get(id);
      if (listener) listener(id, "\r\n[Process exited]\r\n");
    });
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
