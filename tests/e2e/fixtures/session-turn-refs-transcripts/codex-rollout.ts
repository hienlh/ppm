/**
 * A synthetic Codex rollout in the record shapes codex writes (legacy `event_msg` layout,
 * `cli_version` before `item_completed`): `session_meta`, `turn_context`, `task_started` /
 * `task_complete` carrying the native turn id, user and agent messages, a steered second user
 * message inside a running turn, a `compacted` replacement history, a tool call, and
 * `thread_rolled_back`. No real conversation content.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class CodexRollout {
  private minute = 0;

  constructor(readonly path: string, private readonly start: number) {}

  /** Where codex puts a thread's rollout under a sessions directory. */
  static pathFor(sessionsDir: string, threadId: string, start: number): string {
    const d = new Date(start);
    const ymd = [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")];
    const stamp = d.toISOString().slice(0, 19).replace(/:/g, "-");
    return join(sessionsDir, ...ymd, `rollout-${stamp}-${threadId}.jsonl`);
  }

  private ts(): string {
    return new Date(this.start + (this.minute++) * 1000).toISOString();
  }

  private write(record: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }

  private event(payload: Record<string, unknown>): void {
    this.write({ timestamp: this.ts(), type: "event_msg", payload });
  }

  meta(threadId: string, cwd: string): this {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, "");
    this.write({ timestamp: this.ts(), type: "session_meta", payload: { id: threadId, timestamp: this.ts(), cwd, originator: "codex_cli_rs", cli_version: "0.150.0", instructions: null } });
    return this;
  }

  taskStarted(turnId: string, cwd: string): this {
    this.event({ type: "task_started", turn_id: turnId, started_at: Math.floor(this.start / 1000), model_context_window: 272000 });
    this.write({ timestamp: this.ts(), type: "turn_context", payload: { cwd, approval_policy: "never", sandbox_policy: { mode: "danger-full-access" }, model: "gpt-5.5-codex", effort: "medium", summary: "auto" } });
    return this;
  }

  user(message: string): this {
    this.event({ type: "user_message", message, images: [] });
    return this;
  }

  agent(message: string): this {
    this.event({ type: "agent_message", message });
    return this;
  }

  call(name: string, command: string, output: string): this {
    const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
    this.write({ timestamp: this.ts(), type: "response_item", payload: { type: "function_call", name, arguments: JSON.stringify({ command: ["bash", "-lc", command] }), call_id: callId } });
    this.write({ timestamp: this.ts(), type: "response_item", payload: { type: "function_call_output", call_id: callId, output: JSON.stringify({ output, metadata: { exit_code: 0 } }) } });
    return this;
  }

  compacted(history: Array<{ role: "user" | "assistant"; text: string }>): this {
    this.write({
      timestamp: this.ts(), type: "compacted",
      payload: { message: "summary of the thread so far", replacement_history: history.map((h) => ({ type: "message", role: h.role, content: [{ type: h.role === "user" ? "input_text" : "output_text", text: h.text }] })) },
    });
    return this;
  }

  taskComplete(turnId: string, last: string | null = null): this {
    this.event({ type: "task_complete", turn_id: turnId, last_agent_message: last });
    return this;
  }

  rolledBack(turns: number): this {
    this.event({ type: "thread_rolled_back", num_turns: turns });
    return this;
  }
}
