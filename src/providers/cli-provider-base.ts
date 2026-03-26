import type {
  AIProvider,
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  SendMessageOpts,
} from "./provider.interface.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { parseNdjsonLines } from "../utils/ndjson-line-parser.ts";
import { configService } from "../services/config.service.ts";

/**
 * Abstract base class for CLI-spawning AI providers.
 * Handles process lifecycle, NDJSON streaming, abort, and cleanup.
 * Subclasses only implement event mapping + arg building.
 */
export abstract class CliProvider implements AIProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly cliCommand: string;

  /** Build CLI args for a given message/session */
  abstract buildArgs(params: {
    sessionId?: string;
    message: string;
    model?: string;
    permissionMode?: string;
    isResume: boolean;
  }): string[];

  /** Map a raw JSON object from CLI stdout → ChatEvent[] */
  abstract mapEvent(raw: unknown, sessionId: string): ChatEvent[];

  /** Extract session ID from CLI init event (provider-specific) */
  abstract extractSessionId(raw: unknown): string | null;

  /** Check if CLI binary exists on this machine */
  abstract isAvailable(): Promise<boolean>;

  // --- Shared state ---
  protected sessions = new Map<string, Session>();
  protected activeProcesses = new Map<string, ChildProcess>();
  private messageCount = new Map<string, number>();

  // --- Session lifecycle ---

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      providerId: this.id,
      title: config.title ?? "New Chat",
      projectName: config.projectName,
      projectPath: config.projectPath,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    this.messageCount.set(id, 0);
    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session: Session = {
      id: sessionId,
      providerId: this.id,
      title: "Resumed Chat",
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    this.messageCount.set(sessionId, 1);
    return session;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      providerId: s.providerId,
      title: s.title,
      projectName: s.projectName,
      createdAt: s.createdAt,
    }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.messageCount.delete(sessionId);
  }

  // --- Streaming ---

  async *sendMessage(
    sessionId: string,
    message: string,
    opts?: SendMessageOpts,
  ): AsyncIterable<ChatEvent> {
    if (!this.sessions.has(sessionId)) {
      await this.resumeSession(sessionId);
    }
    const meta = this.sessions.get(sessionId)!;

    if (meta.title === "New Chat") {
      meta.title = message.slice(0, 50) + (message.length > 50 ? "..." : "");
    }

    const count = this.messageCount.get(sessionId) ?? 0;
    const isResume = count > 0;
    this.messageCount.set(sessionId, count + 1);

    const config = this.getProviderConfig();
    const args = this.buildArgs({
      sessionId: isResume ? sessionId : undefined,
      message,
      model: config?.model,
      permissionMode: opts?.permissionMode || config?.permission_mode,
      isResume,
    });

    const cwd = meta.projectPath || process.cwd();
    let capturedSessionId = isResume ? sessionId : null;

    const proc = this.spawnProcess(args, cwd);
    const processKey = sessionId;
    this.activeProcesses.set(processKey, proc);

    try {
      for await (const raw of parseNdjsonLines(proc.stdout!)) {
        if (!capturedSessionId) {
          const extracted = this.extractSessionId(raw);
          if (extracted) {
            capturedSessionId = extracted;
            if (capturedSessionId !== processKey) {
              this.activeProcesses.delete(processKey);
              this.activeProcesses.set(capturedSessionId, proc);
            }
          }
        }

        const events = this.mapEvent(raw, capturedSessionId || sessionId);
        for (const event of events) {
          yield event;
        }
      }

      const exitCode = await waitForExit(proc);
      yield {
        type: "done",
        sessionId: capturedSessionId || sessionId,
        resultSubtype: exitCode === 0 ? "success" : "error_during_execution",
      };
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      yield {
        type: "done",
        sessionId: capturedSessionId || sessionId,
        resultSubtype: "error_during_execution",
      };
    } finally {
      this.activeProcesses.delete(capturedSessionId || processKey);
    }
  }

  // --- Abort ---

  abortQuery(sessionId: string): void {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) return;
    console.log(`[${this.id}] Aborting session: ${sessionId}`);
    proc.kill("SIGTERM");
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }, 2000);
    this.activeProcesses.delete(sessionId);
  }

  // --- Helpers ---

  protected spawnProcess(args: string[], cwd: string): ChildProcess {
    console.log(`[${this.id}] spawn: ${this.cliCommand} ${args.join(" ")} (cwd=${cwd})`);
    const proc = spawn(this.cliCommand, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    proc.stdin?.end();

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error(`[${this.id}] stderr: ${text}`);
    });

    return proc;
  }

  /** Read provider config from PPM settings */
  protected getProviderConfig() {
    try {
      const ai = configService.get("ai");
      return ai.providers[this.id] ?? null;
    } catch {
      return null;
    }
  }

  /** Kill all active processes (cleanup on server start) */
  cleanupAll(): void {
    for (const [sessionId, proc] of this.activeProcesses) {
      console.log(`[${this.id}] cleanup: killing orphaned process for session ${sessionId}`);
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.activeProcesses.clear();
  }
}

function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", (err) => reject(err));
  });
}
