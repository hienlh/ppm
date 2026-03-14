/**
 * Registry for tracking active Claude CLI processes.
 * Mirrors opcode's ProcessRegistry — enables cancel/kill support.
 */

export interface ProcessInfo {
  runId: number;
  sessionId: string;
  pid: number;
  startedAt: Date;
  projectPath: string;
  prompt: string;
  model: string;
}

interface ProcessHandle {
  info: ProcessInfo;
  proc: ReturnType<typeof Bun.spawn> | null;
}

class ProcessRegistry {
  private processes = new Map<string, ProcessHandle>(); // sessionId -> handle

  /** Register a running Claude CLI process */
  register(
    sessionId: string,
    proc: ReturnType<typeof Bun.spawn>,
    meta: { projectPath?: string; prompt: string; model?: string },
  ): void {
    const pid = proc.pid;
    this.processes.set(sessionId, {
      info: {
        runId: Date.now(),
        sessionId,
        pid,
        startedAt: new Date(),
        projectPath: meta.projectPath ?? process.cwd(),
        prompt: meta.prompt,
        model: meta.model ?? "default",
      },
      proc,
    });
  }

  /** Unregister a process (called when it completes) */
  unregister(sessionId: string): void {
    this.processes.delete(sessionId);
  }

  /** Get process info for a session */
  get(sessionId: string): ProcessInfo | null {
    return this.processes.get(sessionId)?.info ?? null;
  }

  /** List all running sessions */
  listRunning(): ProcessInfo[] {
    return Array.from(this.processes.values()).map((h) => h.info);
  }

  /**
   * Kill a running process. Mirrors opcode's graceful shutdown:
   *   SIGTERM → wait 2s → SIGKILL
   */
  async kill(sessionId: string): Promise<boolean> {
    const handle = this.processes.get(sessionId);
    if (!handle?.proc) return false;

    const { proc } = handle;
    const pid = proc.pid;

    try {
      // Try graceful SIGTERM first
      proc.kill("SIGTERM");

      // Wait up to 2s for exit
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 2000)),
      ]);

      if (!exited) {
        // Force kill with SIGKILL
        try {
          proc.kill("SIGKILL");
        } catch {
          // Fallback: system kill command
          Bun.spawnSync(["kill", "-KILL", String(pid)]);
        }
      }

      this.processes.delete(sessionId);
      return true;
    } catch {
      this.processes.delete(sessionId);
      return false;
    }
  }

  /** Check if a session has a running process */
  isRunning(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }
}

/** Singleton process registry */
export const processRegistry = new ProcessRegistry();
