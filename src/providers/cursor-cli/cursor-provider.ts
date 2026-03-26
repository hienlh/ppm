import { CliProvider } from "../cli-provider-base.ts";
import { mapCursorEvent } from "./cursor-event-mapper.ts";
import { listCursorSessions, loadCursorHistory } from "./cursor-history.ts";
import type { ChatEvent, ChatMessage, SessionInfo } from "../provider.interface.ts";
import type { ChildProcess } from "node:child_process";

const TRUST_PATTERNS = [
  /workspace trust required/i,
  /do you trust the contents/i,
  /pass --trust/i,
];

/**
 * Cursor CLI provider — spawns `cursor-agent` with NDJSON streaming.
 * Extends CliProvider with Cursor-specific event mapping, arg building,
 * workspace trust auto-retry, and SQLite DAG history.
 */
export class CursorCliProvider extends CliProvider {
  readonly id = "cursor";
  readonly name = "Cursor";
  readonly cliCommand = "cursor-agent";

  async isAvailable(): Promise<boolean> {
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const proc = Bun.spawn([cmd, "cursor-agent"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  buildArgs(params: {
    sessionId?: string;
    message: string;
    model?: string;
    permissionMode?: string;
    isResume: boolean;
  }): string[] {
    const args: string[] = [];

    if (params.sessionId && params.isResume) {
      args.push(`--resume=${params.sessionId}`);
    }

    args.push("-p", params.message);

    if (!params.isResume && params.model) {
      args.push("--model", params.model);
    }

    args.push("--output-format", "stream-json");

    // Permission mode → CLI flags
    const mode = params.permissionMode || "default";
    if (mode === "bypassPermissions") {
      args.push("-f");
    }

    return args;
  }

  mapEvent(raw: unknown, sessionId: string): ChatEvent[] {
    return mapCursorEvent(raw, sessionId);
  }

  extractSessionId(raw: unknown): string | null {
    const obj = raw as Record<string, unknown>;
    if (obj?.type === "system" && obj?.subtype === "init") {
      return (obj.session_id as string) || null;
    }
    return null;
  }

  // Override listSessions to include Cursor's native history
  override async listSessions(): Promise<SessionInfo[]> {
    const inMemory = await super.listSessions();
    try {
      const native = await listCursorSessions(this.id);
      // Merge: in-memory first, then native (deduplicated)
      const seen = new Set(inMemory.map((s) => s.id));
      const merged = [...inMemory];
      for (const s of native) {
        if (!seen.has(s.id)) merged.push(s);
      }
      return merged;
    } catch {
      return inMemory;
    }
  }

  // Optional: load history from SQLite
  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const meta = this.sessions.get(sessionId);
    return loadCursorHistory(sessionId, meta?.projectPath);
  }

  // Workspace trust detection: log warning so user knows to re-run with --trust
  protected override spawnProcess(args: string[], cwd: string): ChildProcess {
    const proc = super.spawnProcess(args, cwd);

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (TRUST_PATTERNS.some((p) => p.test(text))) {
        console.warn("[cursor] Workspace trust prompt detected. Re-run with bypassPermissions mode or add --trust flag.");
      }
    });

    return proc;
  }
}
