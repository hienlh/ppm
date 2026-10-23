/**
 * The pieces of a Codex one-shot that need no subprocess: the params of its thread and turn,
 * and a collector that turns the app-server's notifications into one answer.
 *
 * Checked against the protocol schema `codex app-server generate-json-schema` writes for
 * codex-cli 0.164.0: `ThreadStartParams` has `ephemeral` (no rollout file, so the call never
 * shows up as a session) and a free-form `config`, whose `web_search` takes
 * `disabled | cached | indexed | live`; `TurnStartParams` has `outputSchema` ("Optional JSON
 * Schema used to constrain the final assistant message for this turn").
 */
import type { JsonRpcNotification } from "./codex-protocol.ts";
import type { OneShotUsage } from "../one-shot-error.ts";

export interface CodexOneShotParamsInput {
  cwd: string;
  model: string;
  systemPrompt: string;
  webSearch?: boolean;
}

export function codexOneShotThreadParams(input: CodexOneShotParamsInput): Record<string, unknown> {
  return {
    cwd: input.cwd,
    model: input.model,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
    ...(input.systemPrompt.trim() ? { developerInstructions: input.systemPrompt } : {}),
    config: { web_search: input.webSearch ? "live" : "disabled" },
  };
}

export function codexOneShotTurnParams(
  threadId: string,
  input: { prompt: string; model: string },
  outputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: input.prompt, text_elements: [] }],
    model: input.model,
    ...(outputSchema ? { outputSchema } : {}),
  };
}

/** A turn's end as `turn/completed` reports it. */
export interface CodexTurnEnd {
  status: string;
  error?: string;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Notifications of one thread folded into its answer, its token count and its last error. */
export class CodexOneShotCollector {
  private deltas = "";
  private lastMessage: string | null = null;
  private usage: OneShotUsage = { inputTokens: 0, outputTokens: 0 };
  /** The last error codex reported for good (retry notices are not errors). */
  lastError = "";
  turnId: string | null = null;
  private onEnd: ((end: CodexTurnEnd) => void) | null = null;

  /** Called once when the running turn ends. */
  awaitEnd(fn: (end: CodexTurnEnd) => void): void {
    this.onEnd = fn;
  }

  /** A second turn on the same thread starts from an empty answer. */
  resetAnswer(): void {
    this.deltas = "";
    this.lastMessage = null;
    this.lastError = "";
    this.turnId = null;
  }

  handle(notif: JsonRpcNotification): void {
    const p = asObj(notif.params);
    switch (notif.method) {
      case "turn/started": {
        const id = asObj(p.turn).id;
        if (typeof id === "string") this.turnId = id;
        return;
      }
      case "item/agentMessage/delta":
        if (typeof p.delta === "string") this.deltas += p.delta;
        return;
      case "item/completed": {
        const item = asObj(p.item);
        if (item.type === "agentMessage" && typeof item.text === "string") this.lastMessage = item.text;
        return;
      }
      case "thread/tokenUsage/updated": {
        // `total` is the thread's running sum, which covers a second turn as well.
        const total = asObj(asObj(p.tokenUsage).total);
        if (typeof total.inputTokens === "number") {
          this.usage = { inputTokens: num(total.inputTokens), outputTokens: num(total.outputTokens) };
        }
        return;
      }
      case "error": {
        if (p.willRetry === true) return;
        const err = asObj(p.error);
        this.lastError = typeof err.message === "string" ? err.message : typeof p.message === "string" ? p.message : "codex error";
        return;
      }
      case "turn/completed": {
        const turn = asObj(p.turn);
        const status = typeof turn.status === "string" ? turn.status : "completed";
        const turnError = asObj(turn.error).message;
        const end: CodexTurnEnd = { status };
        const error = typeof turnError === "string" && turnError ? turnError : this.lastError;
        if (error) end.error = error;
        const fn = this.onEnd;
        this.onEnd = null;
        fn?.(end);
        return;
      }
      default:
        return;
    }
  }

  answer(): string {
    return this.lastMessage ?? this.deltas;
  }

  tokens(): OneShotUsage {
    return { ...this.usage };
  }
}

/** Whether a failed turn was refused for the schema it carried (so a retry without it can work). */
export function isSchemaRefusal(message: string): boolean {
  return /json[\s_-]?schema|output[\s_-]?schema|response_format|text\.format|invalid schema/i.test(message);
}
