import type { Subprocess, Terminal as BunTerminal } from "bun";

/** Max output buffer size per session (1MB — enough for ~20K lines) */
const MAX_BUFFER_SIZE = 1024 * 1024;

/** Idle session timeout: 1 hour (only counted from last PTY activity) */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Reconnect grace period after WS disconnect (30 min — covers browser
 *  backgrounding, tab discarding, and network interruptions) */
const RECONNECT_GRACE_MS = 30 * 60 * 1000;

const isWindows = process.platform === "win32";

// ── Unified PTY handle ──
// Abstracts Bun native PTY (macOS/Linux) and bun-pty (Windows) behind one interface.

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly closed: boolean;
}

/** Bun native PTY wrapper (macOS/Linux) */
function spawnBunNative(
  shell: string,
  projectPath: string,
  cols: number,
  rows: number,
  onData: (text: string) => void,
  onExit: () => void,
): PtyHandle {
  const decoder = new TextDecoder();
  const proc: Subprocess = Bun.spawn([shell, "-l"], {
    cwd: projectPath,
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols,
      rows,
      data: (_terminal: BunTerminal, data: Uint8Array) => {
        onData(decoder.decode(data));
      },
    },
  });
  const terminal = proc.terminal!;
  proc.exited.then(onExit);

  let _closed = false;
  return {
    write: (data) => terminal.write(data),
    resize: (c, r) => terminal.resize(c, r),
    kill() {
      if (_closed) return;
      _closed = true;
      try { terminal.close(); } catch { /* already closed */ }
      try { proc.kill(); } catch { /* already dead */ }
    },
    get closed() {
      return _closed || terminal.closed;
    },
  };
}

/** bun-pty wrapper (Windows) — uses ConPTY via FFI */
function spawnBunPty(
  shell: string,
  projectPath: string,
  cols: number,
  rows: number,
  onData: (text: string) => void,
  onExit: () => void,
): PtyHandle {
  // Dynamic import to avoid loading native binaries on non-Windows
  const { spawn } = require("@skitee3000/bun-pty");
  const pty = spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: projectPath,
    env: process.env as Record<string, string>,
  });

  pty.onData(onData);
  pty.onExit(onExit);

  let _closed = false;
  return {
    write: (data) => pty.write(data),
    resize: (c, r) => pty.resize(c, r),
    kill() {
      if (_closed) return;
      _closed = true;
      try { pty.kill(); } catch { /* already dead */ }
    },
    get closed() { return _closed; },
  };
}

function getDefaultShell(): string {
  if (isWindows) {
    // bun-pty's FFI spawn fails with full paths (e.g. C:\WINDOWS\system32\cmd.exe)
    // Use short executable name — Windows resolves via PATH
    return "cmd.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

export interface TerminalSession {
  id: string;
  pty: PtyHandle;
  projectPath: string;
  createdAt: Date;
  /** Connected WebSocket (if any) */
  ws: unknown | null;
  /** Timeout to kill session after WS disconnect */
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Idle timeout timer — null while a WebSocket is connected (paused).
   * Invariant: idleTimer is armed iff session.ws === null.
   */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalSessionInfo {
  id: string;
  projectPath: string;
  createdAt: string;
  connected: boolean;
}

type OutputCallback = (sessionId: string, data: string) => void;

export class TerminalService {
  private sessions = new Map<string, TerminalSession>();
  private outputBuffers = new Map<string, string>();
  private outputListeners = new Map<string, OutputCallback>();

  /** Create a new terminal session — auto-selects Bun native or bun-pty */
  create(projectPath: string, cols = 80, rows = 24): string {
    const id = crypto.randomUUID();
    const shell = getDefaultShell();

    const onData = (text: string) => {
      this.appendBuffer(id, text);
      this.resetIdleTimer(id);
      const listener = this.outputListeners.get(id);
      if (listener) listener(id, text);
    };
    const onExit = () => {
      const listener = this.outputListeners.get(id);
      if (listener) {
        listener(id, "\r\n[Process exited]\r\n");
        listener(id, JSON.stringify({ type: "exited" }));
      }
    };

    const pty = isWindows
      ? spawnBunPty(shell, projectPath, cols, rows, onData, onExit)
      : spawnBunNative(shell, projectPath, cols, rows, onData, onExit);

    const session: TerminalSession = {
      id,
      pty,
      projectPath,
      createdAt: new Date(),
      ws: null,
      disconnectTimer: null,
      idleTimer: this.createIdleTimer(id),
    };

    this.sessions.set(id, session);
    this.outputBuffers.set(id, "");
    return id;
  }

  /**
   * Test-only seam: register a pre-built session with a caller-supplied
   * PtyHandle. This avoids spawning a real shell in unit tests while still
   * exercising all timer / state logic. Not part of the public API —
   * prefixed with underscore to signal internal use.
   *
   * Returns the sessionId so tests can call setConnected / setDisconnected.
   */
  _createWithPty(pty: PtyHandle, projectPath = "/test"): string {
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      pty,
      projectPath,
      createdAt: new Date(),
      ws: null,
      disconnectTimer: null,
      idleTimer: this.createIdleTimer(id),
    };
    this.sessions.set(id, session);
    this.outputBuffers.set(id, "");
    return id;
  }

  /** Write data to terminal via PTY */
  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.pty.closed) return;
    this.resetIdleTimer(id);
    session.pty.write(data);
  }

  /** Resize terminal PTY */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.pty.closed) return;
    session.pty.resize(cols, rows);
  }

  /** Kill a terminal session */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.pty.kill();

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

    // Pause idle timer — it only counts while disconnected (ws === null)
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = null;
    }
  }

  /** Mark session as disconnected — start grace period and re-arm idle timer */
  setDisconnected(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.ws = null;

    // Re-arm idle timer now that ws is gone (grace is shorter and fires first,
    // but idle keeps the invariant consistent for any reconnect-then-disconnect cycle)
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(id);

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

  /** Reset idle timer on activity — only re-arms when disconnected (ws === null) */
  private resetIdleTimer(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.ws !== null) {
      // Connected: keep idle paused — do not re-arm
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = null;
      return;
    }
    // Disconnected: reset the countdown from now
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(id);
  }
}

export const terminalService = new TerminalService();
