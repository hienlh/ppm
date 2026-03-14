import pty from "node-pty";
import type { TerminalSession } from "../types/terminal.ts";

const IDLE_TIMEOUT_MS = 30_000;

interface ActiveSession {
  info: TerminalSession;
  pty: ReturnType<typeof pty.spawn>;
  dataHandlers: Set<(data: string) => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class TerminalService {
  private sessions = new Map<string, ActiveSession>();

  create(opts: { projectPath: string; shell?: string; cols?: number; rows?: number }): TerminalSession {
    const id = crypto.randomUUID();
    const shell = opts.shell ?? (process.env["SHELL"] ?? "/bin/bash");
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;

    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.projectPath,
      env: { ...process.env } as Record<string, string>,
    });

    const session: ActiveSession = {
      info: { id, pid: proc.pid, cols, rows, cwd: opts.projectPath },
      pty: proc,
      dataHandlers: new Set(),
      idleTimer: null,
    };

    proc.onData((data) => {
      for (const handler of session.dataHandlers) {
        handler(data);
      }
    });

    proc.onExit(() => {
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);
    return session.info;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id)?.info;
  }

  list(): TerminalSession[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.pty.kill();
    this.sessions.delete(id);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Terminal session not found: ${id}`);
    session.pty.resize(cols, rows);
    session.info.cols = cols;
    session.info.rows = rows;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Terminal session not found: ${id}`);
    session.pty.write(data);
  }

  onData(id: string, handler: (data: string) => void): () => void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Terminal session not found: ${id}`);
    session.dataHandlers.add(handler);
    return () => session.dataHandlers.delete(handler);
  }

  scheduleIdleCleanup(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.kill(id);
    }, IDLE_TIMEOUT_MS);
  }

  cancelIdleCleanup(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
}

export const terminalService = new TerminalService();
